/**
 * Beckett — PiDriver (`src/drivers/pi.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `pi` (pi.dev / earendil-works) run as a one-shot
 * worker. Pi is Beckett's malleable, provider-agnostic coding agent and the REPLACEMENT for
 * codex as the non-claude worker: same {@link HarnessDriver} surface, so the dispatcher casts
 * `harness:"pi"` interchangeably with `claude`. Unlike codex it has NO network sandbox to
 * fight — its containment here is the same as every worker's: it runs inside the ticket's own
 * project repo (`~/Projects/<slug>`), which is the only thing it should touch.
 *
 * Mechanism (verified against `pi` 0.80.x, `--mode json` NDJSON stream):
 *
 *   # first launch — caller-mint the session id so Beckett's ledger knows it before handshake:
 *   pi -p --mode json --provider <p> --model <m> --thinking <lvl> \
 *      --session-id <uuid> --append-system-prompt <systemAppend> "<prompt>"
 *   # resume — pin the captured id so pi reloads the persisted transcript in the same cwd:
 *   pi -p --mode json --provider <p> --model <m> --thinking <lvl> --session <id> "<prompt>"
 *
 * - cwd = the project repo (pi is rooted to the process cwd — there is no `-C`), set on spawn.
 * - `--mode json` emits a JSON Lines stream. The events we normalize (Spec 02 §7):
 *     `session`               → the session id (first line)   → session_started + resolves spawn
 *     `turn_start`            → a model turn began            → turn_started
 *     `tool_execution_start`  → a tool is running (name+args) → tool_call
 *     `tool_execution_end`    → tool finished (isError)       → tool_result (+ file_change for edits)
 *     `message_end`(assistant)→ a completed assistant message → assistant_text (final answer capture)
 *     `turn_end`              → turn done (carries usage)     → turn_completed
 *     `agent_end`             → the run is complete           → finished (success)
 *   The parser is tolerant by contract: an unknown `type`, unknown tool, or malformed line
 *   becomes `kind:'unknown'` and NEVER throws.
 * - `pi -p` is STRICTLY ONE-SHOT: prompt in → run → exit. Like codex there is no mid-turn steer,
 *   so {@link sendNudge} BUFFERS the instruction and reports `queued`; it is replayed as the
 *   prompt of the next {@link resume} (`pi --session <id> "<instruction>"`, which reuses the
 *   persisted session transcript). A turn that ends with buffered steering auto-resumes to apply
 *   it rather than finishing.
 * - session id = Beckett mints the id and passes `--session-id` on the first launch. The preflight
 *   requires that flag and pi >=0.78 so a stale 0.72.x install fails loudly before dispatch instead
 *   of dying after spawn with `Error: Unknown option: --session-id` (OPS-56 / issue #12).
 * - Done-signal: pi has no `--output-schema`, so the structured done-signal is parsed leniently
 *   from the final assistant message (raw JSON, a ```json fence, or a trailing object).
 * - abort() = SIGTERM→SIGKILL of the whole process group, retain the session id. A driver-owned
 *   wall-clock watchdog enforces a GENEROUS, configurable backstop cap
 *   (`config.supervise.worker_hard_cap_s`) — a runaway safety net, not a work limit — and on a trip
 *   group-kills the tree then emits a terminal `finished` for graceful dispatcher handling (OPS-50).
 *
 * Auth (Spec 00 §4): subscription/OAuth only — the child env strips `OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` so pi uses the `~/.pi/agent/auth.json` login (the ChatGPT/Codex OAuth via
 * the `openai-codex` provider). The child PATH is prefixed with `~/.local/bin` + `~/.bun/bin` so
 * `pi` resolves AND runs under the modern node there (pi's TUI needs node ≥20; the system node is
 * older).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  Config,
  HarnessDriver,
  Logger,
  NudgeReceipt,
  SpawnResult,
  SpawnSpec,
  TokenUsage,
  WorkerEvent,
  WorkerState,
} from "../types.ts";
import { makeLogger } from "../log.ts";
import { hardCapSeconds, killGroup, killProcessTree, wrapProcessGroup } from "./proc.ts";

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
type Child = ReturnType<typeof Bun.spawn>;

/** How long spawn() waits for the `session` line before failing the launch. */
const SPAWN_TIMEOUT_MS = 60_000;
/** How long after SIGTERM we escalate to SIGKILL on abort. */
const SIGKILL_GRACE_MS = 4_000;
/** Watchdog poll interval. */
const WATCHDOG_INTERVAL_MS = 5_000;
/** Env keys that must never reach a child — subscription/OAuth auth only. */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
/** Fallback instruction when resume() is asked to continue with no buffered nudge. */
const DEFAULT_RESUME_PROMPT = "Please continue from where you left off.";
/** pi tool names that mutate files → we synthesize a file_change from their args.path. */
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch"]);

/** How long the preflight lets a `pi --version` / `--help` probe run before giving up. */
const PREFLIGHT_TIMEOUT_MS = 10_000;
/** Minimum pi CLI version with the `--session-id` create-if-missing contract. */
const MIN_PI_VERSION = "0.78.0";
/** CLI flags the driver's invocation depends on — their absence signals version/protocol drift. */
const REQUIRED_PI_FLAGS = [
  "--mode",
  "--session",
  "--session-id",
  "--print",
  "--no-extensions",
  "--no-skills",
  "--no-themes",
] as const;
/** Stderr ring size included in pi launch/process-exit diagnostics. */
const STDERR_TAIL_LINES = 20;

/** A subset of the diff stat used for derived telemetry counters. */
interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

/**
 * The PATH a pi child runs under: prefix `~/.local/bin` & `~/.bun/bin` so `pi` both RESOLVES and
 * RUNS under the modern node there (pi needs node ≥20; the system node is older). Shared by the
 * live child env and the {@link piPreflight} probe so preflight tests the SAME binary a spawn would.
 */
function piChildPath(base = process.env.PATH): string {
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  return base ? `${extra}:${base}` : extra;
}

/** The verdict of a {@link piPreflight} run: is the pi harness usable, and if not, why. */
export interface PiPreflight {
  ok: boolean;
  bin: string;
  nodeVersion: string | null;
  version: string | null;
  problems: string[];
}

/**
 * Fast, offline health check for the pi harness — run at dispatch so a broken pi surfaces LOUDLY
 * and immediately instead of silently killing whatever ticket happened to be cast to it (OPS-56).
 * Three cheap local probes, no network:
 *   1. the binary resolves and runs (`pi --version`);
 *   2. the CLI still advertises the flags the driver invokes (`--mode`, `--session`, `--print`) —
 *      catches the exact version/protocol drift that took pi down (the `--session-id` removal);
 *   3. a pi login exists (`~/.pi/agent/auth.json`, non-empty) — subscription/OAuth auth is present.
 */
export async function piPreflight(config: Config): Promise<PiPreflight> {
  const bin = config.harness.pi.bin;
  const problems: string[] = [];
  const env = { ...process.env, PATH: piChildPath() };
  for (const k of FORBIDDEN_ENV_KEYS) delete (env as Record<string, string | undefined>)[k];

  let nodeVersion: string | null = null;
  try {
    const n = Bun.spawnSync({ cmd: ["node", "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    const raw = `${n.stdout.toString()}\n${n.stderr.toString()}`.trim();
    nodeVersion = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
    if (!n.success || !nodeVersion || !semverGte(nodeVersion, "20.0.0")) {
      problems.push(
        `daemon PATH resolves node ${nodeVersion ?? "unknown"}; pi needs node >=20. ` +
          `Put a modern node before /usr/bin in the daemon PATH.`,
      );
    }
  } catch (err) {
    problems.push(`could not run node from the daemon PATH (${(err as Error).message}).`);
  }

  // 1 — binary resolves + reports a version.
  let version: string | null = null;
  try {
    const v = Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    if (v.success) {
      // pi prints its version to stderr; fall back across both streams.
      const raw = `${v.stdout.toString()}\n${v.stderr.toString()}`.trim();
      version = raw.split("\n").map((l) => l.trim()).find(Boolean) || null;
      if (!semverGte(version, MIN_PI_VERSION)) {
        problems.push(`installed pi ${version} is too old; need >=${MIN_PI_VERSION} for --session-id.`);
      }
    } else {
      problems.push(`\`${bin} --version\` exited ${v.exitCode}: ${v.stderr.toString().trim() || "(no output)"}`);
    }
  } catch (err) {
    problems.push(
      `pi binary "${bin}" is not runnable on PATH (${(err as Error).message}). ` +
        `Install pi or fix config.harness.pi.bin.`,
    );
  }

  // 2 — CLI/protocol drift: confirm the flags the driver emits still exist.
  try {
    const h = Bun.spawnSync({ cmd: [bin, "--help"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    const help = `${h.stdout.toString()}\n${h.stderr.toString()}`;
    if (!h.success) {
      problems.push(`\`${bin} --help\` exited ${h.exitCode}: ${h.stderr.toString().trim() || "(no output)"}`);
    } else if (help.trim()) {
      const missing = REQUIRED_PI_FLAGS.filter((f) => !help.includes(f));
      if (missing.length) {
        problems.push(
          `installed pi (${version ?? "unknown version"}) no longer advertises ${missing.join(", ")} — ` +
            `CLI/protocol drift; the PiDriver invocation needs updating.`,
        );
      }
    }
  } catch {
    /* a --help failure is already implied by the --version failure in (1) */
  }

  // 3 — pi login present (subscription/OAuth; the child strips API keys and relies on this).
  const authPath = join(process.env.HOME ?? "", ".pi/agent/auth.json");
  try {
    const f = Bun.file(authPath);
    if (!(await f.exists()) || f.size === 0) {
      problems.push(`no pi login at ${authPath} — run \`pi\` once to sign in (subscription/OAuth).`);
    } else {
      const auth = await f.text();
      const provider = config.harness.pi.default_provider;
      if (provider && !auth.includes(provider)) {
        problems.push(`pi login at ${authPath} does not include provider ${provider}.`);
      }
    }
  } catch (err) {
    problems.push(`could not read pi login at ${authPath} (${(err as Error).message}).`);
  }

  return { ok: problems.length === 0, bin, nodeVersion, version, problems };
}

function semverGte(raw: string | null, min: string): boolean {
  if (!raw) return false;
  const parse = (v: string): [number, number, number] => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const a = parse(raw);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

export class PiDriver implements HarnessDriver {
  readonly kind = "pi-cli-stream" as const;

  private readonly config: Config;
  private readonly log: Logger;

  private child: Child | null = null;
  /** True when the child was launched as its own process-group leader (setsid) — enables tree-kill. */
  private groupKill = false;
  private spec: SpawnSpec | null = null;

  /** Resume identity: caller-minted UUID, confirmed/captured from the `session` line. */
  private sessionId: string | null = null;
  private pid: number | null = null;

  private workerState: WorkerState = "spawning";
  /** Tail of the child's stderr (diagnostic) — folded into launch/process-failure messages. */
  private readonly stderrTailLines: string[] = [];
  private finished = false;
  private spawnedAt = 0;
  private lastActivityTs = 0;
  /** Incremented per child process; an exit whose gen != current is a superseded child (ignored). */
  private childGen = 0;

  // ── normalized-stream parse state ────────────────────────────────────────────
  private readonly subscribers = new Set<(e: WorkerEvent) => void>();
  /** The text of the most recent completed assistant message — the candidate done-signal. */
  private lastAgentMessage = "";
  /** tool call ids already counted (dedup) + their names (so an edit tool → file_change). */
  private readonly toolNames = new Map<string, string>();
  /** tool call id → its start `args` (pi carries args only on the start event, not the end). */
  private readonly toolArgs = new Map<string, unknown>();

  // ── derived counters ─────────────────────────────────────────────────────────
  private turns = 0;
  private toolCalls = 0;
  private tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  /** Accumulated real cost off `turn_end.message.usage.cost.total` (pi reports dollars). */
  private usd: number | null = null;

  // ── steering (exec is one-shot → every nudge is buffered for the next resume) ──
  private readonly bufferedNudges: string[] = [];

  // ── launch lifecycle plumbing ───────────────────────────────────────────────
  private sessionEmitted = false;
  private resolveSession: ((r: SpawnResult) => void) | null = null;
  private rejectSession: ((e: Error) => void) | null = null;
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readLoop: Promise<void> = Promise.resolve();

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child("driver.pi");
  }

  get state(): WorkerState {
    return this.workerState;
  }
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ===========================================================================
  // spawn / sendNudge / pause / resume / abort
  // ===========================================================================

  /** Launch the pi worker and resolve once the `session` line yields an id (spawning→running). */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("PiDriver: already spawned (one driver = one process)");
    this.spec = spec;
    // Preflight FIRST: a dead pi harness (missing binary, CLI drift, no login) must surface loudly
    // here — before we launch a child that would otherwise exit 1 before its session line and take
    // the ticket down silently (OPS-56).
    const pf = await piPreflight(this.config);
    if (!pf.ok) {
      this.log.error("pi preflight FAILED — harness unusable", {
        bin: pf.bin,
        nodeVersion: pf.nodeVersion,
        version: pf.version,
        problems: pf.problems,
      });
      throw new Error(`PiDriver preflight failed (pi harness unusable): ${pf.problems.join("; ")}`);
    }
    this.log.info("pi preflight ok", { bin: pf.bin, nodeVersion: pf.nodeVersion, version: pf.version });
    this.sessionId = spec.sessionId ?? randomUUID();
    const args = this.buildArgs(spec.prompt, /*isResume*/ false);
    return this.launch(args, /*isResume*/ false);
  }

  /** Steer: pi exec is one-shot, so ALWAYS buffer and report `queued` (replayed on resume). */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    this.bufferedNudges.push(msg);
    this.log.info("nudge buffered for next resume (pi -p is one-shot)", {
      state: this.workerState,
      pending: this.bufferedNudges.length,
    });
    return { accepted: "queued", at: Date.now() };
  }

  /** Checkpoint without killing — the persisted session + worktree git state are the checkpoint. */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (auto-resume halted; session retained)", { sessionId: this.sessionId });
  }

  /**
   * Re-attach a paused/finished worker. If the process is still live a turn is in flight (pi can't
   * be steered mid-turn) so we just lift the pause. If it exited, relaunch with `--session <id>`
   * and the buffered instruction as the new prompt — pi reuses the persisted session transcript.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error("PiDriver: resume before spawn");
    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.log.info("worker resumed (turn still in flight; nudge applies after it ends)", {
        pending: this.bufferedNudges.length,
      });
      return;
    }
    if (!this.sessionId) throw new Error("PiDriver: resume without a session id");

    const prompt = this.takeBufferedPrompt();
    this.log.info("relaunching pi with --session (resume)", {
      sessionId: this.sessionId,
      promptLen: prompt.length,
    });
    // Sweep the superseded child BEFORE relaunching (issue #11 leak 5): on the auto-resume path
    // the previous process may still be exiting — dropping its handle here would orphan it. A
    // no-op when it already exited; the childGen guard keeps its exit from firing spuriously.
    await this.killChild();

    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.sessionEmitted = false;
    this.lastAgentMessage = "";
    const args = this.buildArgs(prompt, /*isResume*/ true);
    await this.launch(args, /*isResume*/ true);
  }

  /** Hard stop: SIGTERM→SIGKILL after a grace; retain the session id. Idempotent. */
  async abort(reason: string): Promise<void> {
    this.log.warn("aborting worker", { reason, sessionId: this.sessionId });
    this.setState("aborted");
    await this.killChild();
  }

  // ===========================================================================
  // onEvent / getTelemetry
  // ===========================================================================

  onEvent(cb: (e: WorkerEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getTelemetry() {
    const diff = this.diffStat();
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      tokens: { ...this.tokens },
      diffLines: diff,
      usdEstimate: this.usd,
    };
  }

  getLastActivityTs(): number {
    return this.lastActivityTs;
  }

  // ===========================================================================
  // internal — argv construction
  // ===========================================================================

  private buildArgs(prompt: string, isResume: boolean): string[] {
    const pi = this.config.harness.pi;
    // Pin the worker environment: pi auto-discovers extensions/skills/themes from the ticket repo
    // AND the user dirs, so a stray install on the box would change worker behavior invisibly.
    // Context-file discovery (AGENTS.md/CLAUDE.md in the ticket repo) stays ON — that's desirable.
    const args: string[] = [
      "-p",
      "--mode",
      "json",
      "--no-extensions",
      "--no-skills",
      "--no-themes",
      "--provider",
      pi.default_provider,
    ];
    const model = this.resolvedModel();
    if (model) args.push("--model", model);
    args.push("--thinking", this.resolvedThinking());
    // Fresh runs use the modern create-if-missing flag. Resumes use the existing-session selector.
    if (this.sessionId) args.push(isResume ? "--session" : "--session-id", this.sessionId);
    // System prompt (scope + criteria + persona) only on the FIRST launch — the persisted session
    // already carries it on resume, and re-appending would duplicate it.
    if (!isResume && this.spec?.systemAppend?.trim()) {
      args.push("--append-system-prompt", this.spec.systemAppend.trim());
    }
    args.push(prompt);
    return args;
  }

  private resolvedModel(): string {
    return (this.spec?.model || this.config.harness.pi.default_model || "").trim();
  }

  /** pi `--thinking` reuses the resource envelope's effort (same low|medium|high|xhigh vocabulary). */
  private resolvedThinking(): string {
    return this.spec?.envelope.effort || this.config.harness.pi.thinking;
  }

  // ===========================================================================
  // internal — launch / process lifecycle
  // ===========================================================================

  private async launch(args: string[], isResume: boolean): Promise<SpawnResult> {
    const spec = this.spec!;
    const bin = this.config.harness.pi.bin;
    this.setState("spawning");
    this.spawnedAt = this.spawnedAt || Date.now();
    this.lastActivityTs = Date.now();

    const sessionReady = new Promise<SpawnResult>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });

    this.log.info("spawning pi worker", {
      bin,
      workspace: spec.workspace,
      provider: this.config.harness.pi.default_provider,
      model: this.resolvedModel() || "(pi default)",
      thinking: this.resolvedThinking(),
      isResume,
      sessionId: this.sessionId,
    });

    // Launch as a NEW process group (setsid) so abort/timeout can kill the whole tree with one
    // group signal, leaving no orphaned descendant to keep mutating the checkout (OPS-50).
    const { cmd, groupKill } = wrapProcessGroup(bin, args);
    this.groupKill = groupKill;

    let child: Child;
    try {
      child = Bun.spawn({
        cmd,
        cwd: spec.workspace,
        stdin: "ignore", // prompt is an arg; give pi an immediate stdin EOF
        stdout: "pipe",
        stderr: "pipe",
        env: this.childEnv(),
      });
    } catch (err) {
      const e = new Error(`PiDriver: failed to spawn ${bin} — ${(err as Error).message}`);
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;
    const gen = ++this.childGen;

    this.spawnTimer = setTimeout(() => {
      const err = new Error(this.startupFailureMessage(`no session line within ${SPAWN_TIMEOUT_MS}ms`));
      this.rejectSession?.(err);
      this.resolveSession = null;
      this.rejectSession = null;
      this.setState("failed");
      void this.killChild();
    }, SPAWN_TIMEOUT_MS);

    this.readLoop = this.consumeStdout(child).catch((err) => {
      this.log.error("stdout read loop crashed", { err: String(err) });
    });
    void this.drainStderr(child);
    void child.exited.then((code) => this.onProcessExit(code, gen, child.pid, groupKill));

    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }
    return sessionReady;
  }

  /** Child env: strip API keys (force OAuth login) + prefix ~/.local/bin & ~/.bun/bin onto PATH. */
  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
    env.PATH = piChildPath(env.PATH);
    return env;
  }

  /**
   * A loud, actionable message for the #1 pi failure: the child dies before its `session`
   * handshake. Folds in the captured stderr tail (e.g. `Error: Unknown option: --session-id`)
   * so the real cause is visible instead of the opaque bare "exited before session line" (OPS-56).
   */
  private startupFailureMessage(reason: number | string): string {
    const tail = this.stderrTail();
    const detail = tail
      ? ` pi stderr: ${JSON.stringify(tail)}.`
      : " pi printed nothing to stderr.";
    return (
      `PiDriver: pi exited (${reason}) before emitting its session line — the harness never ` +
      `started.${detail} Common causes: a pi CLI/version drift (an unknown flag), a bad ` +
      `harness.pi.bin, or a missing/expired pi login (~/.pi/agent/auth.json). Run the pi preflight.`
    );
  }

  private async onProcessExit(
    code: number,
    gen: number,
    pid: number,
    groupKill: boolean,
  ): Promise<void> {
    if (gen !== this.childGen) {
      killGroup(pid, groupKill, this.log);
      return; // superseded child (auto-resume) — not ours
    }
    this.child = null;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    await this.readLoop; // drain any final stdout (agent_end may be the last line before exit)

    if (this.resolveSession && !this.sessionEmitted) {
      this.rejectSession?.(new Error(this.startupFailureMessage(code)));
      this.resolveSession = null;
      this.rejectSession = null;
    }
    // Exited without a clean agent_end → synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      const message = this.processExitMessage(code);
      this.emit({ kind: "error", message, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_process_exit",
        structuredOutput: {
          status: "blocked",
          summary: message,
          filesChanged: [],
          checksRun: [],
          blockedReason: message,
        },
        usage: { ...this.tokens },
        ts,
      });
      this.finished = true;
      this.setState("failed");
    }
    // Sweep any descendant the harness left running so a retry worker can't collide with an orphan.
    killGroup(this.pid ?? -1, this.groupKill, this.log);
  }

  private tickWatchdog(): void {
    if (!this.spec || this.finished || this.isTerminal()) return;
    const capS = hardCapSeconds(this.config);
    const totalS = (Date.now() - this.spawnedAt) / 1000;
    if (totalS <= capS) return;
    // Trip the generous backstop cap. Set finished up-front so this can't re-enter and so
    // onProcessExit (fired by the kill below) won't also synthesize a finish.
    this.finished = true;
    void this.timeOut(capS, totalS);
  }

  /**
   * Handle a hard-cap timeout GRACEFULLY (never a silent death, OPS-50): kill the whole process
   * tree FIRST — so no orphan is still mutating the checkout when the dispatcher reacts — then emit
   * a terminal `finished` (subtype `error_wall_clock_cap`) the dispatcher keys on to commit WIP,
   * comment on the ticket, and retry / return it to a ready state.
   */
  private async timeOut(capS: number, totalS: number): Promise<void> {
    this.log.warn("hard wall-clock cap hit — timing out worker (backstop, not a work limit)", {
      hardCapS: capS,
      totalS: Math.round(totalS),
    });
    this.setState("aborted");
    await this.killChild();
    this.emit({
      kind: "finished",
      status: "error",
      subtype: "error_wall_clock_cap",
      structuredOutput: null,
      usage: { ...this.tokens },
      ts: Date.now(),
    });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Kill the whole process group (harness + descendants) so nothing is orphaned (OPS-50).
    await killProcessTree(child, { groupKill: this.groupKill, graceMs: SIGKILL_GRACE_MS, log: this.log });
  }

  // ===========================================================================
  // internal — stdout consumption + normalization
  // ===========================================================================

  private async consumeStdout(child: Child): Promise<void> {
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.handleLine(line);
        }
      }
      const tail = buf.trim();
      if (tail) this.handleLine(tail);
    } finally {
      reader.releaseLock();
    }
  }

  private async drainStderr(child: Child): Promise<void> {
    const stream = child.stderr;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) {
          this.recordStderr(text);
        }
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  private recordStderr(text: string): void {
    this.log.debug("pi stderr", { text });
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      this.stderrTailLines.push(line);
      while (this.stderrTailLines.length > STDERR_TAIL_LINES) this.stderrTailLines.shift();
    }
  }

  private stderrTail(): string {
    return this.stderrTailLines.join("\n").trim();
  }

  private processExitMessage(code: number): string {
    const tail = this.stderrTail();
    return tail
      ? `pi process exited (code ${code}). stderr tail:\n${tail}`
      : `pi process exited (code ${code})`;
  }

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by contract:
   * a malformed line or unknown `type` becomes `kind:'unknown'` — never a throw.
   */
  handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({ kind: "unknown", raw: line, ts: Date.now() });
      return;
    }
    try {
      switch (obj.type) {
        case "session":
          this.handleSession(obj);
          break;
        case "turn_start":
          this.turns += 1;
          this.emit({ kind: "turn_started", ts: Date.now() });
          break;
        case "tool_execution_start":
          this.handleToolStart(obj);
          break;
        case "tool_execution_end":
          this.handleToolEnd(obj);
          break;
        case "message_end":
          this.handleMessageEnd(obj);
          break;
        case "turn_end":
          this.handleTurnEnd(obj);
          break;
        case "agent_end":
          this.handleAgentEnd();
          break;
        case "error":
          this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
          break;
        // High-frequency streaming / lifecycle chatter we deliberately DON'T surface: the per-token
        // `message_update` alone fires hundreds of times a turn, so routing these to `unknown` would
        // flood the event bus. Explicitly ignored (not unknown) — only a genuinely unrecognized
        // `type` falls through to `unknown`.
        case "agent_start":
        case "message_start":
        case "message_update":
        case "tool_execution_update":
        case "queue_update":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
          break;
        default:
          this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
      }
    } catch (err) {
      this.log.warn("event normalization error (routed to unknown)", { err: String(err) });
      this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleSession(obj: Record<string, unknown>): void {
    const id = this.str(obj.id) ?? this.sessionId;
    if (id) this.sessionId = id;
    this.sessionEmitted = true;
    this.emit({ kind: "session_started", sessionId: this.sessionId ?? "", model: this.resolvedModel(), ts: Date.now() });
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    this.setState("running");
    this.resolveSession?.({ sessionId: this.sessionId ?? "", pid: this.pid ?? -1 });
    this.resolveSession = null;
    this.rejectSession = null;
  }

  private handleToolStart(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const id = this.str(obj.toolCallId) ?? `${this.toolCalls}`;
    const tool = this.str(obj.toolName) ?? "tool";
    if (!this.toolNames.has(id)) {
      this.toolNames.set(id, tool);
      this.toolCalls += 1;
    }
    this.toolArgs.set(id, obj.args ?? {});
    this.emit({ kind: "tool_call", tool, input: obj.args ?? {}, toolId: id, ts });
  }

  private handleToolEnd(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const id = this.str(obj.toolCallId) ?? "";
    const isError = obj.isError === true;
    this.emit({ kind: "tool_result", toolId: id, isError, ts });
    // pi has no dedicated file_change event — synthesize one from a successful edit/write tool.
    // pi carries the tool args on the START event, so read them from what we stashed there.
    const tool = (this.str(obj.toolName) ?? this.toolNames.get(id) ?? "").toLowerCase();
    if (!isError && EDIT_TOOL_NAMES.has(tool)) {
      const args = this.toolArgs.get(id) as Record<string, unknown> | undefined;
      const path = this.str(args?.path) ?? this.str(args?.file_path);
      if (path) this.emit({ kind: "file_change", paths: [{ path, kind: "update" }], ts });
    }
    this.toolArgs.delete(id);
  }

  private handleMessageEnd(obj: Record<string, unknown>): void {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") return;
    const text = this.textOf(message.content);
    if (text) {
      this.lastAgentMessage = text;
      this.emit({ kind: "assistant_text", text, partial: false, ts: Date.now() });
    }
  }

  private handleTurnEnd(obj: Record<string, unknown>): void {
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = this.mapUsage(message?.usage);
    if (usage) {
      this.addTokens(usage);
      this.emit({ kind: "turn_completed", usage, ts: Date.now() });
    }
    // pi reports a REAL per-turn dollar cost (`usage.cost.total`) — accumulate it so
    // getTelemetry() surfaces actual spend instead of discarding it.
    const cost = (message?.usage as Record<string, unknown> | undefined)?.cost as
      | Record<string, unknown>
      | undefined;
    if (cost && typeof cost.total === "number" && Number.isFinite(cost.total)) {
      this.usd = (this.usd ?? 0) + cost.total;
    }
  }

  private handleAgentEnd(): void {
    const ts = Date.now();
    // Steering that arrived during this one-shot run couldn't interrupt it; apply it now by
    // resuming with the buffered instruction rather than finishing (mirrors codex).
    if (this.bufferedNudges.length > 0 && this.workerState !== "aborted") {
      this.log.info("agent_end with buffered steering — auto-resuming to apply it", {
        pending: this.bufferedNudges.length,
      });
      this.finished = true; // this process is done; resume() relaunches
      void this.resume().catch((err) => {
        this.log.error("auto-resume after steering failed", { err: String(err) });
        this.emit({
          kind: "finished",
          status: "error",
          subtype: "error_resume",
          structuredOutput: null,
          usage: { ...this.tokens },
          ts: Date.now(),
        });
        this.finished = true;
        this.stopWatchdog();
        if (!this.isTerminal()) this.setState("failed");
      });
      return;
    }

    // A completed run (no pending steering) IS success; the done-signal's own status drives the
    // dispatcher's pass/fail verdict downstream.
    this.emit({
      kind: "finished",
      status: "success",
      subtype: "success",
      structuredOutput: this.parseStructuredOutput(),
      usage: { ...this.tokens },
      ts,
    });
    this.finished = true;
    this.stopWatchdog();
    if (!this.isTerminal()) this.setState("review");
    // pi -p can linger after agent_end; free the slot deterministically.
    void this.killChild();
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  // ===========================================================================
  // internal — helpers
  // ===========================================================================

  private takeBufferedPrompt(): string {
    if (this.bufferedNudges.length === 0) return DEFAULT_RESUME_PROMPT;
    return this.bufferedNudges.splice(0, this.bufferedNudges.length).join("\n\n");
  }

  /** Concatenate the text blocks of a pi message `content` array. */
  private textOf(content: unknown): string {
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("").trim();
  }

  /**
   * Lenient parse of the final assistant message as the structured done-signal. pi has no
   * output-schema enforcement, so the worker's JSON may be raw, fenced in ```json, or trail some
   * prose. Try each shape; return null when nothing parses (the dispatcher then falls back to the
   * summary text).
   */
  private parseStructuredOutput(): unknown | null {
    const text = this.lastAgentMessage.trim();
    if (!text) return null;
    // 1. whole message is JSON
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
    // 2. a ```json … ``` fenced block
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* fall through */
      }
    }
    // 3. the last balanced {...} object in the text
    const lastOpen = text.lastIndexOf("{");
    const lastClose = text.lastIndexOf("}");
    if (lastOpen >= 0 && lastClose > lastOpen) {
      try {
        return JSON.parse(text.slice(lastOpen, lastClose + 1));
      } catch {
        /* give up */
      }
    }
    return null;
  }

  private emit(e: WorkerEvent): void {
    this.lastActivityTs = e.ts;
    for (const cb of this.subscribers) {
      try {
        cb(e);
      } catch (err) {
        this.log.warn("event subscriber threw", { err: String(err), kind: e.kind });
      }
    }
  }

  private setState(state: WorkerState): void {
    this.workerState = state;
    if (this.isTerminal() && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private isTerminal(): boolean {
    return this.workerState === "done" || this.workerState === "failed" || this.workerState === "aborted";
  }

  /** Map pi's `usage` block → the shared {@link TokenUsage} shape. */
  private mapUsage(raw: unknown): TokenUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const u = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const usage: TokenUsage = {
      input: n(u.input),
      output: n(u.output),
      cacheRead: n(u.cacheRead),
      cacheCreate: n(u.cacheWrite),
    };
    if (usage.input + usage.output + usage.cacheRead + usage.cacheCreate === 0) return null;
    return usage;
  }

  private addTokens(u: TokenUsage): void {
    this.tokens.input += u.input;
    this.tokens.output += u.output;
    this.tokens.cacheRead += u.cacheRead;
    this.tokens.cacheCreate += u.cacheCreate;
  }

  /** Ground-truth diff size from git: uncommitted + staged, distinct files. */
  private diffStat(): DiffStat {
    const ws = this.spec?.workspace;
    if (!ws) return { added: 0, removed: 0, files: 0 };
    const paths = new Set<string>();
    let added = 0;
    let removed = 0;
    for (const staged of [false, true]) {
      const cmd = ["git", "-C", ws, "diff", "--numstat"];
      if (staged) cmd.push("--staged");
      let out = "";
      try {
        const r = Bun.spawnSync(cmd);
        out = r.success ? r.stdout.toString() : "";
      } catch {
        out = "";
      }
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const [a, rem, ...rest] = parts;
        const path = rest.join("\t");
        paths.add(path);
        if (a !== "-") added += Number(a) || 0;
        if (rem !== "-") removed += Number(rem) || 0;
      }
    }
    return { added, removed, files: paths.size };
  }

  private str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
  }
}
