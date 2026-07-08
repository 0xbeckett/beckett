import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpenRouterProvider, type OpenRouterCompletionResult } from "./openrouter.ts";

export type EvalMode = "short" | "full";

export interface EvalPrompt {
  id: string;
  category: "ui" | "planning" | "backend" | "debug" | string;
  title: string;
  short: boolean;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface EvalPromptResult {
  prompt: EvalPrompt;
  elapsedMs: number;
  output: string;
  responseModel?: string;
  responseId?: string;
  usage?: unknown;
  error?: string;
}

export interface EvalRunResult {
  model: string;
  mode: EvalMode;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  prompts: EvalPromptResult[];
  savePath?: string;
}

export interface RunEvalOptions {
  model: string;
  mode?: EvalMode;
  suitePath?: string;
  outputDir?: string;
  provider?: Pick<OpenRouterProvider, "complete">;
  continueOnError?: boolean;
}

const DEFAULT_SYSTEM =
  "You are being evaluated as a coding agent. Answer the prompt directly and concretely. " +
  "Prefer practical implementation detail over caveats. Do not claim to have run tools.";

export const DEFAULT_SUITE_PATH = join(import.meta.dir, "suite.json");

export async function loadEvalSuite(path = DEFAULT_SUITE_PATH): Promise<EvalPrompt[]> {
  const raw = await Bun.file(path).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`eval suite is not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new Error("eval suite must be a JSON array");
  const prompts = parsed.map((item, i) => normalizePrompt(item, i));
  const ids = new Set<string>();
  for (const p of prompts) {
    if (ids.has(p.id)) throw new Error(`eval suite has duplicate prompt id "${p.id}"`);
    ids.add(p.id);
  }
  return prompts;
}

export function selectPrompts(suite: EvalPrompt[], mode: EvalMode): EvalPrompt[] {
  return mode === "full" ? suite : suite.filter((p) => p.short);
}

export async function runModelEval(opts: RunEvalOptions): Promise<EvalRunResult> {
  const model = opts.model.trim();
  if (!model) throw new Error("usage: beckett eval <author/model> [--short|--full]");
  const mode = opts.mode ?? "short";
  const suite = await loadEvalSuite(opts.suitePath);
  const prompts = selectPrompts(suite, mode);
  if (prompts.length === 0) throw new Error(`eval suite has no prompts selected for --${mode}`);

  const provider = opts.provider ?? new OpenRouterProvider();
  const started = Date.now();
  const results: EvalPromptResult[] = [];

  for (const prompt of prompts) {
    const t0 = Date.now();
    try {
      const res: OpenRouterCompletionResult = await provider.complete({
        model,
        prompt: prompt.prompt,
        system: prompt.system ?? DEFAULT_SYSTEM,
        maxTokens: prompt.maxTokens,
        temperature: prompt.temperature,
      });
      results.push({
        prompt,
        elapsedMs: Date.now() - t0,
        output: res.output,
        responseModel: res.model,
        responseId: res.id,
        usage: res.usage,
      });
    } catch (err) {
      const error = (err as Error).message;
      results.push({ prompt, elapsedMs: Date.now() - t0, output: "", error });
      if (!opts.continueOnError) break;
    }
  }

  const run: EvalRunResult = {
    model,
    mode,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    prompts: results,
  };

  if (opts.outputDir) {
    mkdirSync(opts.outputDir, { recursive: true });
    const file = `${run.startedAt.replace(/[:.]/g, "-")}-${slugForFile(model)}-${mode}.md`;
    run.savePath = join(opts.outputDir, file);
    await Bun.write(run.savePath, renderEvalReport(run));
  }

  return run;
}

export function renderEvalReport(run: EvalRunResult): string {
  const lines: string[] = [];
  lines.push(`# Beckett Eval`);
  lines.push("");
  lines.push(`- model: ${run.model}`);
  lines.push(`- mode: ${run.mode}`);
  lines.push(`- started: ${run.startedAt}`);
  lines.push(`- finished: ${run.finishedAt}`);
  lines.push(`- total: ${fmtMs(run.elapsedMs)}`);
  if (run.savePath) lines.push(`- saved: ${run.savePath}`);
  lines.push("");

  run.prompts.forEach((result, i) => {
    const p = result.prompt;
    lines.push(`---`);
    lines.push("");
    lines.push(`## ${i + 1}. [${p.category}] ${p.id} — ${p.title}`);
    lines.push("");
    lines.push(`- elapsed: ${fmtMs(result.elapsedMs)}`);
    if (result.responseModel) lines.push(`- response_model: ${result.responseModel}`);
    if (result.responseId) lines.push(`- response_id: ${result.responseId}`);
    if (result.usage) lines.push(`- usage: ${JSON.stringify(result.usage)}`);
    if (result.error) lines.push(`- error: ${result.error}`);
    lines.push("");
    lines.push(`### Prompt`);
    lines.push("");
    lines.push("```text");
    lines.push(p.prompt);
    lines.push("```");
    lines.push("");
    lines.push(`### Raw model output`);
    lines.push("");
    if (result.error) {
      lines.push(`ERROR: ${result.error}`);
    } else {
      lines.push(result.output.trimEnd());
    }
    lines.push("");
  });
  return lines.join("\n");
}

function normalizePrompt(item: unknown, index: number): EvalPrompt {
  if (!item || typeof item !== "object") throw new Error(`eval suite prompt #${index + 1} must be an object`);
  const o = item as Record<string, unknown>;
  const id = stringField(o, "id", index);
  const category = stringField(o, "category", index);
  const title = stringField(o, "title", index);
  const prompt = stringField(o, "prompt", index);
  const short = o.short === true;
  const system = typeof o.system === "string" ? o.system : undefined;
  const maxTokens = typeof o.maxTokens === "number" && Number.isFinite(o.maxTokens) ? o.maxTokens : undefined;
  const temperature = typeof o.temperature === "number" && Number.isFinite(o.temperature) ? o.temperature : undefined;
  return { id, category, title, short, prompt, system, maxTokens, temperature };
}

function stringField(o: Record<string, unknown>, field: string, index: number): string {
  const value = o[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`eval suite prompt #${index + 1} needs a non-empty string "${field}"`);
  }
  return value.trim();
}

function slugForFile(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const min = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return `${min}m ${rem}s`;
}
