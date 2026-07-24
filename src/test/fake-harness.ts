#!/usr/bin/env bun
/**
 * Beckett — fake harness binary (`src/test/fake-harness.ts`)
 * =======================================================================================
 * A drop-in stand-in for the `claude` CLI that speaks the *exact* `claude -p` stream-json
 * wire format but is **scripted, not a model** (Spec 12 §5.2). Point a test `config.toml`'s
 * `harness.claude.bin` at this file (`bun /abs/path/to/fake-harness.ts`) and the real
 * ClaudeDriver / WorkerManager / Supervisor / Orchestrator drive it end-to-end with no
 * subscription spend.
 *
 * What it does, faithfully:
 *   1. Parses the same launch flags the driver passes (Spec 02 §4.1): `--session-id`,
 *      `--model`, `--max-turns`, `--resume`/`--continue`, `--replay-user-messages`,
 *      `--input-format stream-json`, etc. Unknown flags are ignored.
 *   2. Emits `system/init` (with `session_id`) → assistant/tool_use → user/tool_result →
 *      … → `result`, one NDJSON line per stdout write, with realistic inter-turn delays so
 *      nudges can land between turns (loom-desk Risk-A: nudges apply at the next TURN
 *      boundary, never mid-tool).
 *   3. Honors stdin nudges. The FIRST stdin `user` line is the task prompt; every later
 *      `user` line is a nudge. With `--replay-user-messages` each nudge is echoed back on
 *      stdout as a `user` line (the ACK channel, Spec 02 §4.4). In the `mid-task-nudge`
 *      scenario a drained nudge BRANCHES the canned output — proving the nudge changed
 *      behavior.
 *   4. Performs the filesystem effects its tool_use frames claim (Write/delete inside the
 *      cwd worktree) so INTEGRATE/REVIEW/GATE see a real git diff — never fake success.
 *   5. Supports crash-and-resume: the `daemon-restart` scenario exits mid-turn with no
 *      `result`; a follow-up `--resume <session>` launch finishes the work.
 *
 * Scenario selection precedence: `--fake-scenario <name>` flag → `BECKETT_FAKE_SCENARIO`
 * env → a `[[scenario:NAME]]` tag in the prompt → `happy-path`. Timing is scaled by
 * `BECKETT_FAKE_SPEED` (default 1.0; set <1 to run fixtures faster in CI).
 *
 * Import style: explicit `.ts` extensions (Foundation contract). This module is both an
 * executable (guarded by `import.meta.main`) and importable (its parser/effects are unit-
 * testable).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getScenario,
  asScenarioName,
  parsePromptScenario,
  lineInit,
  lineUserEcho,
  renderResult,
  SCENARIO_NAMES,
  type Scenario,
  type ScenarioCtx,
  type Beat,
  type FsEffect,
  type RawLine,
} from "./scenarios.ts";

// =======================================================================================
// Argument parsing
// =======================================================================================

/** Flags that consume the following argv token as their value. */
const VALUE_FLAGS = new Set([
  "--session-id",
  "--model",
  "--max-turns",
  "--resume",
  "--input-format",
  "--output-format",
  "--append-system-prompt",
  "--mcp-config",
  "--json-schema",
  "--add-dir",
  "--permission-mode",
  "--max-budget-usd",
  "--settings",
  "--allowedTools",
  "--disallowedTools",
  "--permission-prompt-tool",
  "--effort",
  "--fake-scenario",
]);

/** Claude resolves bare model aliases to full ids (loom-desk: `sonnet` → claude-sonnet-4-6). */
const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-5",
  haiku: "claude-haiku-4-5",
};

export interface ParsedArgs {
  values: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
}

/** Parse claude-style argv (value flags consume the next token; the rest are booleans). */
export function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      // support --flag=value
      const eq = a.indexOf("=");
      if (eq > 0) {
        values[a.slice(0, eq)] = a.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(a)) {
        values[a] = argv[++i] ?? "";
      } else {
        flags.add(a);
      }
    } else {
      positionals.push(a);
    }
  }
  return { values, flags, positionals };
}

// =======================================================================================
// stdin: prompt + nudge channel
// =======================================================================================

/**
 * Reads the NDJSON stdin channel. The first `user` line is the prompt; later `user` lines
 * are nudges. Returns live accessors; the read loop runs in the background.
 */
class StdinChannel {
  readonly nudges: string[] = [];
  private promptText = "";
  private promptResolve!: (p: string) => void;
  readonly prompt: Promise<string> = new Promise((r) => (this.promptResolve = r));
  private sawPrompt: boolean;
  private bridgeTimer: ReturnType<typeof setInterval> | null = null;
  private bridgeOffset = 0;
  private bridgeBuf = "";

  /** @param promptKnown true when the prompt came from a positional arg (all stdin = nudges). */
  constructor(
    private readonly promptKnown: boolean,
    private readonly bridgePath?: string,
  ) {
    this.sawPrompt = promptKnown;
    if (promptKnown) this.promptResolve("");
  }

  /** Start consuming stdin lines (does not block; swallows errors on close). */
  start(): void {
    if (this.bridgePath) this.startBridge();
    else void this.run();
  }

  stop(): void {
    if (this.bridgeTimer) {
      clearInterval(this.bridgeTimer);
      this.bridgeTimer = null;
    }
  }

  private async run(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      // Use the Web Streams API directly; it is portable across Bun's DOM and Node typings.
      const reader = Bun.stdin.stream().getReader();
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (raw) this.handle(raw);
        }
      }
      const tail = (buf + decoder.decode()).trim();
      if (tail) this.handle(tail);
    } catch {
      // stdin closed / unreadable — nudges simply stop arriving.
    }
  }

  private handle(raw: string): void {
    let text: string | null;
    try {
      text = extractUserText(JSON.parse(raw));
    } catch {
      return; // not JSON / not a user message — ignore (tolerant parser)
    }
    if (text === null) return;
    if (!this.sawPrompt) {
      this.sawPrompt = true;
      this.promptText = text;
      this.promptResolve(text);
    } else {
      this.nudges.push(text);
    }
  }

  getPromptText(): string {
    return this.promptText;
  }

  private startBridge(): void {
    const poll = () => {
      if (!this.bridgePath || !existsSync(this.bridgePath)) return;
      let body = "";
      try {
        body = readFileSync(this.bridgePath, "utf8");
      } catch {
        return;
      }
      if (body.length <= this.bridgeOffset) return;
      const next = this.bridgeBuf + body.slice(this.bridgeOffset);
      this.bridgeOffset = body.length;
      const lines = next.split(/\r?\n/);
      this.bridgeBuf = lines.pop() ?? "";
      for (const line of lines) {
        const raw = line.trim();
        if (raw) this.handle(raw);
      }
    };
    poll();
    this.bridgeTimer = setInterval(poll, 10);
    this.bridgeTimer.unref?.();
  }
}

/**
 * Pull the plain text out of an inbound stream-json `user` message. Returns the text for a
 * string or text-block-array content, or null if the line is not a user message (e.g. a
 * tool_result echo we should not treat as a nudge).
 */
export function extractUserText(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "user") return null;
  const msg = o.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") return null; // a tool result, not a steer
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.length ? parts.join("\n") : "";
  }
  return null;
}

// =======================================================================================
// Filesystem effects (make the worktree diff real)
// =======================================================================================

/**
 * Perform a scripted filesystem effect, but ONLY inside the cwd worktree — an absolute or
 * traversal path that escapes cwd is skipped (logged to stderr), which also keeps the
 * scope-violation scenario's `/etc/passwd` write a no-op even if it were ever attached.
 * Records the changed relative path in `changed` (deduped).
 */
export function applyEffect(cwd: string, eff: FsEffect, changed: string[]): void {
  const abs = isAbsolute(eff.path) ? resolve(eff.path) : resolve(cwd, eff.path);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    process.stderr.write(`[fake-harness] refusing out-of-cwd effect on ${eff.path}\n`);
    return;
  }
  if (eff.op === "write") {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, eff.content);
  } else {
    rmSync(abs, { force: true });
  }
  if (!changed.includes(rel)) changed.push(rel);
}

// =======================================================================================
// Output + timing
// =======================================================================================

function emitLine(line: RawLine): void {
  process.stdout.write(JSON.stringify(line) + "\n");
}

function sleepFactory(speed: number): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms * speed))));
}

// =======================================================================================
// Main
// =======================================================================================

export interface HarnessConfig {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

/**
 * Run the fake harness to completion. Resolves with the intended process exit code
 * (the executable wrapper calls process.exit with it). Crash beats exit() directly.
 */
export async function runHarness(cfg: HarnessConfig): Promise<number> {
  const { values, flags } = parseArgs(cfg.argv);
  const env = cfg.env;
  const speed = parseFloat(env.BECKETT_FAKE_SPEED ?? "") || 1;
  const sleep = sleepFactory(speed);

  // Identity + envelope from the launch flags (Spec 02 §4.1).
  const resumed = "--resume" in values || flags.has("--continue");
  const sessionId =
    values["--resume"] || values["--session-id"] || randomUUID();
  const rawModel = values["--model"] || "";
  const replay = flags.has("--replay-user-messages");
  const turnCap = Math.max(1, parseInt(values["--max-turns"] ?? "12", 10) || 12);
  const promptArg = ""; // claude -p with stream-json input takes the prompt over stdin

  // stdin channel (prompt + nudges). Start reading immediately.
  const stdin = new StdinChannel(Boolean(promptArg), env.BECKETT_STDIN_BRIDGE);
  stdin.start();

  // Scenario selection: flag → env → prompt tag → default.
  const explicit = values["--fake-scenario"] ?? env.BECKETT_FAKE_SCENARIO;
  if (explicit && !asScenarioName(explicit)) {
    process.stderr.write(
      `[fake-harness] unknown scenario "${explicit}". Known: ${SCENARIO_NAMES.join(", ")}\n`,
    );
    return 2;
  }
  let prompt = promptArg;
  let scenario: Scenario | undefined = getScenario(explicit);
  if (!scenario) {
    // Need the prompt to look for a [[scenario:...]] tag; wait briefly for the first line.
    prompt = await Promise.race([
      stdin.prompt,
      sleep(1500).then(() => stdin.getPromptText()),
    ]);
    scenario = getScenario(parsePromptScenario(prompt)) ?? getScenario("happy-path")!;
  } else if (!promptArg) {
    // Scenario already known; grab the prompt opportunistically (non-blocking-ish).
    prompt = await Promise.race([stdin.prompt, sleep(50).then(() => stdin.getPromptText())]);
  }

  const model = MODEL_ALIASES[rawModel] ?? rawModel ?? scenario.defaultModel;
  const ctx: ScenarioCtx = {
    sessionId,
    model: model || scenario.defaultModel,
    cwd: cfg.cwd,
    turnCap,
    prompt,
    resumed,
  };

  // 1. system/init — always the first line (carries session_id, Spec 02 §7.1).
  emitLine(lineInit(ctx));

  // 2. Choose the beat script: resume recovery vs fresh spawn.
  let beats: Beat[] =
    resumed && scenario.resumeBeats ? scenario.resumeBeats(ctx) : scenario.beats(ctx);

  const startedAt = Date.now();
  const changed: string[] = [];
  const receivedNudges: string[] = [];
  let processedNudges = 0;
  let branched = false;
  let turns = 0;
  // Running token accumulators (echoed in the terminal result.usage).
  let tokIn = 0;
  let tokOut = 0;
  let tokCacheRead = 0;

  /** Drain newly-arrived nudges: echo each (if replay on), record for branching. */
  const drainNudges = (): boolean => {
    let got = false;
    while (processedNudges < stdin.nudges.length) {
      const text = stdin.nudges[processedNudges++]!;
      receivedNudges.push(text);
      got = true;
      if (replay) emitLine(lineUserEcho(ctx, text));
    }
    return got;
  };

  // 3. Replay the script.
  let i = 0;
  while (i < beats.length) {
    const b = beats[i++]!;
    await sleep(b.delayMs);

    if (b.kind === "crash") {
      // Abrupt mid-turn death: no result line. The driver detects EOF-without-result and
      // recovers via --resume (Spec 04 §10). Exit immediately.
      await sleep(0);
      process.exit(b.exitCode);
    }

    if (b.kind === "result") {
      const numTurns = b.numTurns ?? Math.max(1, turns);
      emitLine(
        renderResult(ctx, {
          subtype: b.subtype,
          summary: b.summary,
          numTurns,
          filesChanged: changed.slice(),
          usage: {
            input_tokens: tokIn,
            output_tokens: tokOut,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: tokCacheRead,
          },
          durationMs: Date.now() - startedAt,
        }),
      );
      await flushStdout();
      stdin.stop();
      return 0;
    }

    // emit beat
    if (b.effect) applyEffect(ctx.cwd, b.effect, changed);
    emitLine(b.line);
    accumulateUsage(b.line, (di, dout, dcache) => {
      tokIn += di;
      tokOut += dout;
      tokCacheRead += dcache;
    });

    if (b.turnBoundary) {
      turns++;
      const got = drainNudges();
      // Branch the canned output the first time a nudge lands at a boundary.
      if (got && !branched && scenario.branchBeats) {
        beats = scenario.branchBeats(ctx, receivedNudges.slice());
        branched = true;
        i = 0;
      }
    }
  }

  // Script exhausted without an explicit result (defensive) — emit a clean success.
  emitLine(
    renderResult(ctx, {
      subtype: "success",
      summary: "Completed.",
      numTurns: Math.max(1, turns),
      filesChanged: changed.slice(),
      usage: {
        input_tokens: tokIn,
        output_tokens: tokOut,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokCacheRead,
      },
      durationMs: Date.now() - startedAt,
    }),
  );
  await flushStdout();
  stdin.stop();
  return 0;
}

/** Pull this beat's per-step token usage (if any) and feed it to the accumulator. */
function accumulateUsage(
  line: RawLine,
  add: (input: number, output: number, cacheRead: number) => void,
): void {
  if (line.type !== "assistant") return;
  const msg = line.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  add(
    Number(usage.input_tokens ?? 0),
    Number(usage.output_tokens ?? 0),
    Number(usage.cache_read_input_tokens ?? 0),
  );
}

/** Give piped stdout a tick to flush before the process exits. */
function flushStdout(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

// =======================================================================================
// Executable entrypoint
// =======================================================================================

if (import.meta.main) {
  runHarness({
    argv: Bun.argv.slice(2),
    env: Bun.env as Record<string, string | undefined>,
    cwd: process.cwd(),
  })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[fake-harness] fatal: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
