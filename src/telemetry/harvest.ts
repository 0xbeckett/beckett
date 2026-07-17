import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelRate extends TokenUsage {
  estimate: boolean;
  source: string;
}

export interface RateTable {
  schema_version: number;
  effective_date: string;
  currency: "USD";
  unit: string;
  models: Record<string, ModelRate>;
}

export interface TelemetryRun {
  run_id: string;
  session_id: string;
  task_id: string | null;
  harness: "claude-code" | "pi" | "codex";
  model: string;
  timestamp: string;
  wall_clock_seconds: number;
  cost_usd: number;
  review_cycles: number;
  tokens: TokenUsage;
  rate_estimate: boolean;
}

export interface TelemetryDataset {
  schema_version: 1;
  generated_at: string;
  rate_table_effective_date: string;
  runs: TelemetryRun[];
}

export interface HarvestOptions {
  output: string;
  rates: string;
  claudeDir: string;
  piDir: string;
  codexDir: string;
  boredStateDir: string;
  trackerUrl?: string;
  note?: (message: string) => void;
}

interface ParsedSession {
  sessionId: string;
  taskId: string | null;
  model: string;
  timestamp: string;
  endTimestamp: string;
  tokens: TokenUsage;
}

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

function addTokens(into: TokenUsage, usage: unknown): void {
  const value = asObject(usage);
  if (!value) return;
  into.input += number(value.input) || number(value.input_tokens);
  into.output += number(value.output) || number(value.output_tokens);
  into.cache_read += number(value.cacheRead) || number(value.cache_read) || number(value.cached_input_tokens);
  into.cache_write += number(value.cacheWrite) || number(value.cache_write) || number(value.cache_creation_input_tokens);
}

function timestamp(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex event timestamps are seconds in task events and milliseconds in JSONL records.
    return new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString();
  }
  return null;
}

function earliest(values: string[]): string | null {
  return values.length ? values.reduce((a, b) => a < b ? a : b) : null;
}
function latest(values: string[]): string | null {
  return values.length ? values.reduce((a, b) => a > b ? a : b) : null;
}

/** Extract a tracker ref only from an explicit ticket marker, avoiding incidental issue mentions. */
export function taskIdFromText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bracketed = value.match(/\[\s*(#[0-9]+|[A-Z][A-Z0-9]*-[0-9]+)\s*\]/i)?.[1];
  if (bracketed) return bracketed.toUpperCase();
  const branch = value.match(/(?:^|\/)(#[0-9]+|[A-Z][A-Z0-9]*-[0-9]+)$/i)?.[1];
  return branch?.toUpperCase() ?? null;
}

function usageFromClaude(value: unknown): TokenUsage {
  const result = { ...ZERO_TOKENS };
  addTokens(result, value);
  return result;
}

/** Parse one Claude Code transcript. Duplicate transcript entries for one API message are de-duped. */
export function parseClaudeSession(path: string, contents: string, note: (message: string) => void): ParsedSession | null {
  const seenMessages = new Set<string>();
  const allTimes: string[] = [];
  const modelTimes = new Map<string, string[]>();
  const usageByModel = new Map<string, TokenUsage>();
  let sessionId: string | null = null;
  let taskId: string | null = null;

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; }
    catch { note(`claude-code: invalid JSON skipped in ${path}`); continue; }
    const at = timestamp(entry.timestamp);
    if (at) allTimes.push(at);
    sessionId ??= text(entry.sessionId);
    taskId ??= taskIdFromText(text(entry.gitBranch)) ?? taskIdFromText(text(entry.cwd));
    const message = asObject(entry.message);
    if (!message) continue;
    const role = text(message.role);
    const content = message.content;
    if (!taskId && role === "user") taskId = taskIdFromText(typeof content === "string" ? content : JSON.stringify(content));
    if (role !== "assistant") continue;
    const model = text(message.model);
    const usage = asObject(message.usage);
    if (!model || !usage) continue;
    const id = text(message.id) ?? text(entry.uuid) ?? `${model}:${at ?? line.length}`;
    if (seenMessages.has(id)) continue;
    seenMessages.add(id);
    const normalized = model.toLowerCase();
    const tokens = usageByModel.get(normalized) ?? { ...ZERO_TOKENS };
    addTokens(tokens, usage);
    usageByModel.set(normalized, tokens);
    if (at) (modelTimes.get(normalized) ?? (modelTimes.set(normalized, []), modelTimes.get(normalized)!)).push(at);
  }

  const model = [...usageByModel.keys()].sort((a, b) => {
    const aTokens = usageByModel.get(a)!; const bTokens = usageByModel.get(b)!;
    return (bTokens.input + bTokens.output + bTokens.cache_read + bTokens.cache_write) - (aTokens.input + aTokens.output + aTokens.cache_read + aTokens.cache_write);
  })[0];
  const start = earliest(allTimes);
  const end = latest(allTimes);
  if (!model || !start || !end) { note(`claude-code: no model/usage/timestamps; skipped ${path}`); return null; }
  const id = sessionId ?? basename(path, ".jsonl");
  return { sessionId: id, taskId, model, timestamp: start, endTimestamp: end, tokens: usageFromClaude(usageByModel.get(model)) };
}

/** Parse one pi session/resume JSONL file. pi records per-response usage inside assistant messages. */
export function parsePiSession(path: string, contents: string, note: (message: string) => void): ParsedSession | null {
  const allTimes: string[] = [];
  const usageByModel = new Map<string, TokenUsage>();
  let sessionId: string | null = null;
  let taskId: string | null = null;
  let selectedModel: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; }
    catch { note(`pi: invalid JSON skipped in ${path}`); continue; }
    const at = timestamp(entry.timestamp);
    if (at) allTimes.push(at);
    sessionId ??= text(entry.id);
    taskId ??= taskIdFromText(text(entry.cwd));
    if (entry.type === "model_change") selectedModel = text(entry.modelId)?.toLowerCase() ?? selectedModel;
    const message = asObject(entry.message);
    if (message?.role === "user" && !taskId) taskId = taskIdFromText(JSON.stringify(message.content));
    if (!message || message.role !== "assistant") continue;
    const model = (text(message.model) ?? selectedModel)?.toLowerCase();
    const usage = asObject(message.usage);
    if (!model || !usage) continue;
    const tokens = usageByModel.get(model) ?? { ...ZERO_TOKENS };
    addTokens(tokens, usage);
    usageByModel.set(model, tokens);
  }
  const model = [...usageByModel.keys()].sort((a, b) => usageByModel.get(b)!.input + usageByModel.get(b)!.output - usageByModel.get(a)!.input - usageByModel.get(a)!.output)[0];
  const start = earliest(allTimes); const end = latest(allTimes);
  if (!model || !start || !end) { note(`pi: no model/usage/timestamps; skipped ${path}`); return null; }
  return { sessionId: sessionId ?? basename(path, ".jsonl").split("_").at(-1)!, taskId, model, timestamp: start, endTimestamp: end, tokens: { ...usageByModel.get(model)! } };
}

/** Parse one Codex rollout. token_count is cumulative, so only its final snapshot is charged. */
export function parseCodexSession(path: string, contents: string, note: (message: string) => void): ParsedSession | null {
  const allTimes: string[] = [];
  let sessionId: string | null = null;
  let taskId: string | null = null;
  let model: string | null = null;
  let finalUsage: Record<string, unknown> | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; }
    catch { note(`codex: invalid JSON skipped in ${path}`); continue; }
    const at = timestamp(entry.timestamp);
    if (at) allTimes.push(at);
    const payload = asObject(entry.payload);
    if (!payload) continue;
    if (entry.type === "session_meta") {
      sessionId ??= text(payload.session_id) ?? text(payload.id);
      taskId ??= taskIdFromText(text(payload.git_branch)) ?? taskIdFromText(text(payload.cwd));
    }
    if (entry.type === "turn_context") model ??= text(payload.model)?.toLowerCase() ?? null;
    if (entry.type === "response_item" && payload.role === "user" && !taskId) taskId = taskIdFromText(JSON.stringify(payload.content));
    if (entry.type === "event_msg" && payload.type === "token_count") {
      const info = asObject(payload.info);
      const total = asObject(info?.total_token_usage);
      if (total) finalUsage = total;
    }
  }
  const start = earliest(allTimes); const end = latest(allTimes);
  if (!model || !finalUsage || !start || !end) { note(`codex: no model/final token_count/timestamps; skipped ${path}`); return null; }
  const cache = number(finalUsage.cached_input_tokens);
  const input = Math.max(0, number(finalUsage.input_tokens) - cache);
  return {
    sessionId: sessionId ?? basename(path).replace(/^rollout-[^-]+-[^-]+-[^-]+-/, "").replace(/\.jsonl$/, ""),
    taskId,
    model,
    timestamp: start,
    endTimestamp: end,
    tokens: { input, output: number(finalUsage.output_tokens), cache_read: cache, cache_write: 0 },
  };
}

export function calculateCost(tokens: TokenUsage, rate: ModelRate): number {
  return Number(((tokens.input * rate.input + tokens.output * rate.output + tokens.cache_read * rate.cache_read + tokens.cache_write * rate.cache_write) / 1_000_000).toFixed(8));
}

async function filesUnder(root: string, note: (message: string) => void): Promise<string[]> {
  try {
    const result: string[] = [];
    const todo = [root];
    while (todo.length) {
      const dir = todo.pop()!;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) todo.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
      }
    }
    return result.sort();
  } catch (error) {
    note(`source absent/unreadable: ${root} (${(error as Error).message})`);
    return [];
  }
}

async function trackerCyclesFromState(stateDir: string, note: (message: string) => void): Promise<Map<string, number>> {
  const cycles = new Map<string, number>();
  const files = await filesUnder(join(stateDir, "runs"), note);
  for (const path of files) {
    try {
      const raw = await readFile(path, "utf8");
      let task: string | null = null;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; }
        catch { note(`tracker: invalid JSON skipped in ${path}`); continue; }
        task ??= text(event.taskRef) ?? text(event.ticketRef) ?? text(event.runId);
        const from = text(event.from) ?? text(event.fromState) ?? text(event.previousState);
        const to = text(event.to) ?? text(event.toState) ?? text(event.state);
        if ((from === "in_progress" || from === "beckett_implement") && (to === "in_review" || to === "review" || to === "beckett_review")) {
          const id = task ?? taskIdFromText(path);
          if (id) cycles.set(id.toUpperCase(), (cycles.get(id.toUpperCase()) ?? 0) + 1);
        }
      }
    } catch (error) { note(`tracker: could not read ${path} (${(error as Error).message})`); }
  }
  return cycles;
}

async function parseSource(
  root: string, label: "claude-code" | "pi" | "codex", parser: (path: string, raw: string, note: (message: string) => void) => ParsedSession | null,
  note: (message: string) => void,
): Promise<ParsedSession[]> {
  const result: ParsedSession[] = [];
  const files = await filesUnder(root, note);
  if (!files.length) note(`${label}: no session JSONL files found in ${root}`);
  for (const path of files) {
    try {
      const parsed = parser(path, await readFile(path, "utf8"), note);
      if (parsed) result.push(parsed);
    } catch (error) { note(`${label}: skipped unreadable session ${path} (${(error as Error).message})`); }
  }
  return result;
}

function runFromSession(session: ParsedSession, harness: TelemetryRun["harness"], rates: RateTable, cycles: Map<string, number>, note: (message: string) => void): TelemetryRun | null {
  const rate = rates.models[session.model.toLowerCase()];
  if (!rate) { note(`${harness}: skipped ${session.sessionId}; model ${session.model} has no rate in table`); return null; }
  const wall = Math.max(0, (Date.parse(session.endTimestamp) - Date.parse(session.timestamp)) / 1000);
  return {
    run_id: `${harness}:${session.sessionId}`,
    session_id: session.sessionId,
    task_id: session.taskId,
    harness,
    model: session.model,
    timestamp: session.timestamp,
    wall_clock_seconds: Number(wall.toFixed(3)),
    cost_usd: calculateCost(session.tokens, rate),
    review_cycles: session.taskId ? cycles.get(session.taskId.toUpperCase()) ?? 0 : 0,
    tokens: session.tokens,
    rate_estimate: rate.estimate,
  };
}

export async function harvest(options: HarvestOptions): Promise<TelemetryDataset> {
  const note = options.note ?? ((message: string) => console.error(`[telemetry] ${message}`));
  let rates: RateTable;
  try { rates = JSON.parse(await readFile(options.rates, "utf8")) as RateTable; }
  catch (error) { throw new Error(`cannot read rate table ${options.rates}: ${(error as Error).message}`); }
  const cycles = await trackerCyclesFromState(options.boredStateDir, note);
  const [claude, pi, codex] = await Promise.all([
    parseSource(options.claudeDir, "claude-code", parseClaudeSession, note),
    parseSource(join(options.piDir, "agent", "sessions"), "pi", parsePiSession, note),
    parseSource(join(options.codexDir, "sessions"), "codex", parseCodexSession, note),
  ]);
  const runs = [
    ...claude.map((s) => runFromSession(s, "claude-code", rates, cycles, note)),
    ...pi.map((s) => runFromSession(s, "pi", rates, cycles, note)),
    ...codex.map((s) => runFromSession(s, "codex", rates, cycles, note)),
  ].filter((run): run is TelemetryRun => run !== null).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.run_id.localeCompare(b.run_id));
  const dataset: TelemetryDataset = { schema_version: 1, generated_at: new Date().toISOString(), rate_table_effective_date: rates.effective_date, runs };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(dataset, null, 2)}\n`);
  note(`wrote ${runs.length} normalized runs to ${options.output}`);
  return dataset;
}

export function defaultOptions(cwd = process.cwd(), env = process.env): HarvestOptions {
  const home = env.HOME ?? ".";
  return {
    output: resolve(cwd, "data/telemetry-runs.json"),
    rates: resolve(cwd, "config/model-rates.json"),
    claudeDir: join(home, ".claude/projects"),
    piDir: join(home, ".pi"),
    codexDir: join(home, ".codex"),
    boredStateDir: env.BORED_STATE_DIR ?? join(home, ".local/state/bored"),
  };
}
