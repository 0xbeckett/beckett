/**
 * Beckett — the one-shot AGENT LANE seam (`src/drivers/lane.ts`)
 * =======================================================================================
 * Every agent Beckett runs that ISN'T a ticket worker — quick errands, the live-agent
 * registry, the background browser agent, the nightly dream pass and its spike — is the same
 * shape: prompt in → one non-interactive harness process → text out. Before #125 each of those
 * four lanes hand-rolled its own `claude -p` argv against `config.harness.claude.*`, which is
 * why "move the fleet to pi" (#121) moved the ticket workers and left every other agent behind.
 *
 * This module is the single place that knows how to turn "run this prompt under harness H" into
 * a concrete `{bin, args}` — the lane-level counterpart to {@link ./base.ts} for the long-lived
 * worker drivers. The lanes keep their own lifecycle (timeouts, ledgers, question parking,
 * budgets); what they no longer keep is a private opinion about argv.
 *
 * Why not reuse {@link HarnessDriver} itself? A driver is built for a STEERABLE, watchdogged,
 * session-resumable worker with a structured done-signal, and demands a worktree, a file scope,
 * a resource envelope and a done-schema path ({@link SpawnSpec}). A quick errand has none of
 * those. Reusing the driver here would mean rebuilding each lane around it — exactly the
 * redesign #125's scope ceiling forbids. So the lanes share the part that actually drifted (the
 * per-harness CLI surface) and keep the part that is genuinely theirs.
 *
 * ── The two harnesses, side by side ────────────────────────────────────────────────────
 *
 *   need                     claude                       pi
 *   ----------------------   --------------------------   ------------------------------
 *   non-interactive prompt   -p <prompt>                  -p <prompt>
 *   plain text out           --output-format text         --mode json (final assistant msg)
 *   text + token usage       --output-format json         --mode json (turn_end.usage)
 *   model                    --model                      --model (+ --provider)
 *   reasoning depth          --effort                     --thinking
 *   replace system prompt    --system-prompt              --system-prompt
 *   append to system prompt  --append-system-prompt       --append-system-prompt
 *   tool allowlist           --allowedTools               --tools
 *   tool denylist            --disallowedTools            --exclude-tools
 *   no tools at all          --disallowedTools <all>      --no-tools
 *   session id / resume      --session-id / --resume      --session-id / --session
 *   unattended execution     --permission-mode            (inherent: `pi -p` never prompts)
 *   MCP servers              --mcp-config                 ✗ NONE — see LANE_GAPS below
 *   enforced JSON output     --json-schema                ✗ none (lenient parse instead)
 *   settings-file hooks      --settings                   ✗ none
 *   turn cap                 --max-turns                  ✗ none
 *
 * The four ✗ rows are real, and this module NEVER swallows them: a run that asks for an
 * affordance the chosen harness lacks gets it reported on {@link LaneCommand.unsupported} so the
 * calling lane can log it loudly. Silence is how a lane ends up quietly less contained than its
 * comments claim.
 *
 * ── pi is extensible; a gap here is a TODO, not a verdict ──────────────────────────────
 *
 * pi loads TypeScript extensions that hook AgentSession lifecycle events and register tools via
 * `pi.registerTool()` (pi's own `docs/extensions.md`), so all four gaps have an in-band fix that
 * is NOT "keep the lane on claude forever" — see {@link LANE_GAPS} for the specific mapping.
 * Building those extensions is deliberately out of #125's scope; naming them precisely is not.
 */

import { join } from "node:path";

import { childEnv } from "../env.ts";
import type { Config, LaneHarness, LaneName, Logger } from "../types.ts";

export type { LaneHarness, LaneName } from "../types.ts";

// =======================================================================================
// Lanes
// =======================================================================================

/**
 * The non-worker agent lanes. Each maps to a `[harness.lanes.<name>]` config block, so any one
 * of them can be pinned to a different harness without a code change — these lanes fail in
 * different ways (a browser run loses its eyes; a dream run just costs tokens), so the lever is
 * per-lane rather than one fleet-wide rollback switch. The type lives in `src/types.ts` next to
 * the config contract; this is the runtime list.
 */
export const LANE_NAMES: readonly LaneName[] = ["quick", "agent", "browser", "dream", "dream_spike"];

/**
 * Harnesses a one-shot lane can spawn. `codex` is deliberately absent: `codex exec` has no
 * `--append-system-prompt` and no tool allow/denylist, so it cannot honor the seat these lanes
 * describe. It remains a ticket-worker harness ({@link ./codex.ts}) — this is a lane restriction,
 * not a deregistration.
 */
export const LANE_HARNESSES: readonly LaneHarness[] = ["claude", "pi"];

export function isLaneHarness(value: string): value is LaneHarness {
  return (LANE_HARNESSES as readonly string[]).includes(value);
}

/**
 * The stock harness for each lane — the SINGLE source of truth, read both by the config schema
 * (`src/capability/builtins.ts`) and by {@link resolveLaneSeat}, so the documented default and the
 * resolved one cannot drift.
 *
 * Everything is pi (the fleet harness since #121) except `browser`, which pi cannot serve at all:
 * BetterWright reaches the model as an MCP tool and pi has no MCP client. See
 * {@link LANE_GAPS}.mcpConfigPath and the header of `src/browser/agent.ts` — a labelled, temporary
 * pin with a named fix, not a permanent carve-out.
 */
export const LANE_DEFAULT_HARNESS: Record<LaneName, LaneHarness> = {
  quick: "pi",
  agent: "pi",
  browser: "claude",
  dream: "pi",
  dream_spike: "pi",
};

// =======================================================================================
// Capability gaps
// =======================================================================================

/**
 * The affordances `claude -p` has and `pi` does not, each named with the extension that closes
 * it. Verified against pi 0.82.1: `pi --help` advertises none of these, and pi's own
 * `docs/usage.md` says outright that it "intentionally does not include built-in MCP, sub-agents,
 * permission popups, plan mode, to-dos, or background bash. You can build or install those
 * workflows as extensions or packages". The pi package also carries no MCP dependency
 * (`@modelcontextprotocol/sdk` is absent from its `package.json`) and no `mcpServers` handling in
 * `dist/`, so this is an absence by design rather than an undocumented flag.
 *
 * Keyed by the {@link LaneRun} field that requests the affordance.
 */
export const LANE_GAPS: Record<string, string> = {
  mcpConfigPath:
    "MCP servers (claude --mcp-config): pi has no MCP client at all — no flag, no settings key, " +
    "no @modelcontextprotocol dependency. An MCP-backed tool is unreachable under pi. Fix: a pi " +
    "extension that registers the tool directly via pi.registerTool() (docs/extensions.md).",
  jsonSchema:
    "enforced structured output (claude --json-schema): pi cannot constrain the final message to " +
    "a schema. Fix: state the schema in the system prompt and parse leniently, the way PiDriver " +
    "already does, or a pi extension that validates on the message_end hook.",
  settingsPath:
    "settings-file hooks (claude --settings): pi has no PreToolUse hook file, so a scope-guard or " +
    "permission-deny ruleset delivered that way does not apply. Fix: a pi extension hooking the " +
    "`tool_call` event and returning `{block: true}` — pi's docs list permission gates and path " +
    "protection as first-class extension use cases.",
  maxTurns:
    "turn cap (claude --max-turns): pi has no turn ceiling flag. Fix: a pi extension counting " +
    "`turn_start` events, or rely on the caller's wall-clock timeout.",
};

// =======================================================================================
// Seat resolution
// =======================================================================================

/** The resolved harness seat for one lane run. */
export interface LaneSeat {
  lane: LaneName;
  harness: LaneHarness;
  /** pi `--provider` (the backend the model runs on). Empty and ignored for claude. */
  provider: string;
  /** Model id passed to the harness. Never empty. */
  model: string;
  /** Reasoning depth (`--effort` / `--thinking`). Empty ⇒ let the harness decide. */
  effort: string;
}

export interface LaneSeatRequest {
  /**
   * Per-run harness that WINS over the lane's config default. The live-agent lane passes the
   * agent definition's own seat here — an agent that names a harness is making a choice, and the
   * lane config is only the default for the agents that don't.
   */
  harness?: LaneHarness;
  /** Per-run model that wins over `[harness.lanes.<lane>].model` (e.g. an agent's own seat). */
  model?: string;
  /**
   * The model this lane used BEFORE #125 — its historical claude model key
   * (`config.quick.model`, `config.dream.model`, …). Used only when the lane resolves to claude
   * and nothing more specific named a model, so pinning a lane back to claude restores its exact
   * previous behavior rather than some new default.
   */
  claudeModel?: string;
  /** Reasoning depth for this run. Empty ⇒ the harness default. */
  effort?: string;
}

/**
 * Resolve which harness/provider/model one lane run uses. Precedence, highest first:
 *   1. the caller's per-run seat (`req.harness` / `req.model`),
 *   2. `[harness.lanes.<lane>]` in config — the per-lane lever,
 *   3. the harness's own configured default (`harness.pi.default_model`, or for claude the
 *      lane's historical model key, else `harness.claude.default_model`).
 */
export function resolveLaneSeat(config: Config, lane: LaneName, req: LaneSeatRequest = {}): LaneSeat {
  // The schema always fills `harness.lanes`; the `??` keeps hand-built Config objects (tests,
  // embedders) resolving to the documented default instead of crashing on an absent table.
  const laneConfig = config.harness.lanes?.[lane] ?? {
    harness: LANE_DEFAULT_HARNESS[lane],
    provider: "",
    model: "",
  };
  const harness = req.harness ?? laneConfig.harness;
  const model =
    (req.model ?? "").trim() ||
    laneConfig.model.trim() ||
    (harness === "pi"
      ? config.harness.pi.default_model
      : (req.claudeModel ?? "").trim() || config.harness.claude.default_model);
  return {
    lane,
    harness,
    provider: harness === "pi" ? laneConfig.provider.trim() || config.harness.pi.default_provider : "",
    model,
    effort: (req.effort ?? "").trim(),
  };
}

// =======================================================================================
// argv
// =======================================================================================

/** What one lane run asks the harness to do. Fields a harness can't honor land in `unsupported`. */
export interface LaneRun {
  /** The initial user turn. */
  prompt: string;
  /** REPLACES the harness's own system prompt. Mutually exclusive with `appendSystemPrompt`. */
  systemPrompt?: string;
  /** APPENDS to the harness's own system prompt. */
  appendSystemPrompt?: string;
  /**
   * `text` = the caller only wants the final message; `json` = it also wants token usage.
   * pi always runs `--mode json` (its text mode is a TUI transcript, not a clean answer), so both
   * kinds come back through {@link parseLaneOutput} rather than off raw stdout.
   */
  output: "text" | "json";
  /**
   * REPLACE the harness's built-in tool set with exactly these (claude `--tools`, pi `--tools`).
   * This is the restricting one: a run given `["mcp__browser__betterwright_browser"]` can reach
   * nothing else — no bash, no filesystem. The browser lane depends on that.
   */
  toolSet?: string[];
  /**
   * Permit these tools without a prompt (claude `--allowedTools`). It widens permission; it does
   * NOT remove the tools left off it — use {@link toolSet} for that. pi `-p` never prompts, so
   * there is nothing to permit and its nearest equivalent is the same enable-allowlist.
   */
  allowedTools?: string[];
  /** Deny these tool names. */
  disallowedTools?: string[];
  /** Disable every tool (the dream reflection call reads nothing but its assembled input). */
  noTools?: boolean;
  /** Caller-minted session id (so a ledger knows it before the handshake). */
  sessionId?: string;
  /** Resume this persisted session instead of starting fresh; `prompt` becomes the next turn. */
  resumeSessionId?: string;
  /**
   * Run unattended, without approval prompts (claude `--permission-mode`). Opt-in, so a lane that
   * never asked for it doesn't silently acquire it. pi needs no equivalent: `pi -p` has no
   * approval gate at all, which is why this is an inherent difference and not a {@link LANE_GAPS}
   * entry.
   */
  unattended?: boolean;
  /** Hard turn ceiling. claude only. */
  maxTurns?: number;
  /** External settings file carrying hooks/permission rules. claude only. */
  settingsPath?: string;
  /** MCP server config file. claude only. */
  mcpConfigPath?: string;
  /** Refuse MCP servers outside `mcpConfigPath`. claude only, and only with it. */
  strictMcp?: boolean;
  /** JSON Schema the final message must satisfy. claude only. */
  jsonSchema?: unknown;
  /** Flags appended verbatim after everything this builder owns (claude `--no-chrome`, …). */
  extraFlags?: string[];
}

export interface LaneCommand {
  seat: LaneSeat;
  bin: string;
  args: string[];
  /**
   * Human-readable descriptions of every affordance `run` asked for that this harness has no
   * equivalent for (see {@link LANE_GAPS}). Empty on a clean match. Callers are expected to
   * SURFACE this, not drop it — that is the whole point of returning it.
   */
  unsupported: string[];
}

/** Build the concrete `{bin, args}` for one lane run. Pure: no spawn, no I/O. */
export function buildLaneCommand(config: Config, seat: LaneSeat, run: LaneRun): LaneCommand {
  return seat.harness === "pi" ? buildPiLaneCommand(config, seat, run) : buildClaudeLaneCommand(config, seat, run);
}

function buildClaudeLaneCommand(config: Config, seat: LaneSeat, run: LaneRun): LaneCommand {
  const args = ["-p", run.prompt, "--output-format", run.output, "--model", seat.model];
  if (run.unattended) args.push("--permission-mode", config.harness.claude.permission_mode);
  if (run.systemPrompt) args.push("--system-prompt", run.systemPrompt);
  if (run.appendSystemPrompt) args.push("--append-system-prompt", run.appendSystemPrompt);
  if (seat.effort) args.push("--effort", seat.effort);
  // claude has no "all tools off" switch — `run.noTools` is expressed there as the caller's
  // explicit denylist, which is why a tool-less lane hands us both.
  if (run.disallowedTools?.length) args.push("--disallowedTools", run.disallowedTools.join(","));
  if (run.allowedTools?.length) args.push("--allowedTools", run.allowedTools.join(","));
  if (run.toolSet?.length) args.push("--tools", run.toolSet.join(","));
  if (run.jsonSchema !== undefined) args.push("--json-schema", JSON.stringify(run.jsonSchema));
  if (run.mcpConfigPath) {
    args.push("--mcp-config", run.mcpConfigPath);
    if (run.strictMcp) args.push("--strict-mcp-config");
  }
  if (run.settingsPath) args.push("--settings", run.settingsPath);
  if (run.maxTurns !== undefined) args.push("--max-turns", String(run.maxTurns));
  if (run.resumeSessionId) args.push("--resume", run.resumeSessionId);
  else if (run.sessionId) args.push("--session-id", run.sessionId);
  if (run.extraFlags?.length) args.push(...run.extraFlags);
  return { seat, bin: config.harness.claude.bin, args, unsupported: [] };
}

function buildPiLaneCommand(config: Config, seat: LaneSeat, run: LaneRun): LaneCommand {
  // Pin the lane environment exactly as PiDriver does: pi auto-discovers extensions, skills and
  // themes from the cwd AND the user dirs, so a stray install on the box would silently change
  // how every quick errand behaves. Explicit `-e <path>` still loads under --no-extensions, which
  // is how the browser-tool extension will attach when it exists (see LANE_GAPS.mcpConfigPath).
  const args = ["-p", "--mode", "json", "--no-extensions", "--no-skills", "--no-themes"];
  if (seat.provider) args.push("--provider", seat.provider);
  args.push("--model", seat.model);
  if (seat.effort) args.push("--thinking", seat.effort);
  if (run.systemPrompt) args.push("--system-prompt", run.systemPrompt);
  if (run.appendSystemPrompt) args.push("--append-system-prompt", run.appendSystemPrompt);
  if (run.noTools) {
    args.push("--no-tools");
  } else {
    if (run.disallowedTools?.length) args.push("--exclude-tools", piToolNames(run.disallowedTools).join(","));
    // pi's `--tools` is a single enable-allowlist, so both of claude's tool-narrowing concepts
    // land on it. They are never both set by a lane.
    const enable = piToolNames([...(run.toolSet ?? []), ...(run.allowedTools ?? [])]);
    if (enable.length) args.push("--tools", enable.join(","));
  }
  if (run.resumeSessionId) args.push("--session", run.resumeSessionId);
  else if (run.sessionId) args.push("--session-id", run.sessionId);
  // The prompt is positional and must come after every flag pi parses.
  args.push(run.prompt);

  const unsupported: string[] = [];
  if (run.mcpConfigPath) unsupported.push(LANE_GAPS.mcpConfigPath!);
  if (run.jsonSchema !== undefined) unsupported.push(LANE_GAPS.jsonSchema!);
  if (run.settingsPath) unsupported.push(LANE_GAPS.settingsPath!);
  if (run.maxTurns !== undefined) unsupported.push(LANE_GAPS.maxTurns!);
  return { seat, bin: config.harness.pi.bin, args, unsupported };
}

/**
 * Map claude's PascalCase tool names onto pi's snake_case built-ins where the two name the same
 * capability, and drop the ones pi has no analogue for. A denylist entry pi doesn't recognize is
 * harmless (pi ignores unknown names), but an ALLOWLIST entry that never matches would starve the
 * run of every tool — so the mapping is applied to both and the unmapped names are dropped.
 */
export function piToolNames(names: string[]): string[] {
  const mapped = names.map((name) => CLAUDE_TO_PI_TOOLS[name] ?? (/^[a-z0-9_]+$/.test(name) ? name : ""));
  return [...new Set(mapped.filter(Boolean))];
}

/** claude tool name → pi's equivalent built-in, or "" where pi has none (sub-agents, web). */
const CLAUDE_TO_PI_TOOLS: Record<string, string> = {
  Bash: "bash",
  BashOutput: "",
  KillShell: "",
  Read: "read",
  Glob: "find",
  Grep: "grep",
  LS: "ls",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "",
  WebFetch: "",
  WebSearch: "",
  Task: "",
  TodoWrite: "",
};

// =======================================================================================
// Output
// =======================================================================================

/** What a finished lane process produced. */
export interface LaneOutput {
  /** The agent's final answer, trimmed. */
  text: string;
  /** Output tokens the harness reported, or null when it reported none. */
  outputTokens: number | null;
  /**
   * A provider/harness error the run ended on. pi exits 0 even when its last turn died on a
   * provider error (no credential, backend down), so a lane that only checks the exit code would
   * read that as an instantly-successful empty run.
   */
  error: string | null;
}

/**
 * Turn a finished lane process's stdout into {@link LaneOutput}. Tolerant by contract — a
 * malformed frame is skipped, never thrown on; a completely unparseable stdout degrades to the
 * raw text so a lane still has something to report.
 */
export function parseLaneOutput(harness: LaneHarness, output: "text" | "json", stdout: string): LaneOutput {
  return harness === "pi" ? parsePiLaneOutput(stdout) : parseClaudeLaneOutput(output, stdout);
}

function parseClaudeLaneOutput(output: "text" | "json", stdout: string): LaneOutput {
  const raw = stdout.trim();
  if (output === "text") return { text: raw, outputTokens: null, error: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text = typeof parsed.result === "string" ? parsed.result : raw;
    const usage = (parsed.usage ?? null) as Record<string, unknown> | null;
    const reported = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    return { text, outputTokens: reported, error: null };
  } catch {
    return { text: raw, outputTokens: null, error: null };
  }
}

/**
 * Read pi's `--mode json` NDJSON stream. Same frames {@link ./pi.ts} normalizes, read here
 * without the driver's event bus: the last completed assistant message is the answer, `turn_end`
 * carries the usage, and an assistant message with `stopReason:"error"` arms the error (a later
 * clean turn disarms it, so a transient error pi recovered from doesn't fail the run).
 */
function parsePiLaneOutput(stdout: string): LaneOutput {
  let text = "";
  let outputTokens: number | null = null;
  let error: string | null = null;
  let sawFrame = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawFrame = true;
    const message = frame.message as Record<string, unknown> | undefined;
    if (frame.type === "message_end" && message?.role === "assistant") {
      if (message.stopReason === "error") {
        error = typeof message.errorMessage === "string" ? message.errorMessage : "pi provider error";
      } else {
        error = null;
      }
      const content = piMessageText(message.content);
      if (content) text = content;
    } else if (frame.type === "turn_end") {
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output === "number" && Number.isFinite(usage.output)) {
        outputTokens = (outputTokens ?? 0) + usage.output;
      }
    } else if (frame.type === "error" && !text) {
      error = typeof frame.message === "string" ? frame.message : "pi error";
    }
  }

  // No recognizable frame at all (a pi that died before its first line, or a stubbed binary in a
  // test): fall back to raw stdout rather than reporting a successful empty run.
  if (!sawFrame && !text) text = stdout.trim();
  return { text: text.trim(), outputTokens, error };
}

/** Concatenate the text blocks of a pi message `content` array. */
function piMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("").trim();
}

// =======================================================================================
// Child environment
// =======================================================================================

/**
 * The env every lane child runs under: API keys stripped (subscription auth only — see
 * {@link ../env.ts#childEnv}) with `~/.local/bin` and `~/.bun/bin` prefixed onto PATH so `pi` both
 * RESOLVES and RUNS under the modern node there (the current pi package needs node >=22.19.0).
 * Identical to the shaping {@link ./pi.ts} does for worker children; each lane used to keep its own
 * copy, which is how a lane could quietly end up unable to find pi.
 *
 * Lanes that need extra vars (the browser lane's MCP timeouts) layer them on top of this.
 */
export function laneChildEnv(): Record<string, string | undefined> {
  const env = childEnv();
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
  return env;
}

// =======================================================================================
// Reporting
// =======================================================================================

/**
 * Log every affordance this lane asked for and did not get. Called by each lane at spawn so a
 * harness pin that quietly costs a capability shows up in the log with the exact gap named —
 * never as a mysterious empty run half an hour later.
 */
export function warnLaneGaps(logger: Logger, command: LaneCommand, fields: Record<string, unknown> = {}): void {
  if (command.unsupported.length === 0) return;
  logger.warn("lane harness is missing a requested capability", {
    lane: command.seat.lane,
    harness: command.seat.harness,
    missing: command.unsupported,
    ...fields,
  });
}
