/**
 * Beckett — ClaudeDriver (`src/drivers/claude.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `claude -p` run as a long-lived, *steerable*
 * worker (Spec 02 §4). One instance drives exactly one harness process inside one git
 * worktree.
 *
 * Mechanism (Spec 02 §4.1, verified on `claude 2.1.195` — my-docs/loom-desk-setup-log.md
 * Risk-A):
 *
 *   claude -p \
 *     --input-format stream-json --output-format stream-json --verbose \
 *     --replay-user-messages --permission-mode bypassPermissions \
 *     --model <model> --effort <effort> \
 *     --session-id <uuid> | --resume <session_id> \
 *     [--append-system-prompt <sys>] [--mcp-config <cfg>] [--json-schema <done>] \
 *     [<config extra_flags>]
 *
 * - cwd = the worktree (that is how Claude is rooted to its scope, Spec 02 §4.1).
 * - stdin is an open NDJSON pipe: the initial task and every later nudge are written as
 *   `{"type":"user",...}` lines (Spec 02 §4.4). Nudges land at the *next turn boundary*,
 *   never mid-tool; `--replay-user-messages` echoes them back on stdout = the delivery ack.
 * - stdout is consumed line-by-line and normalized into the {@link WorkerEvent} union.
 *   CONTRACT (Spec 02 §7.2 + Risk-A): the parser tolerates unknown `type`s AND unknown
 *   `system` subtypes — it switches on what it knows and routes the rest to `kind:'unknown'`;
 *   it never throws on a surprising line.
 * - session_id is captured the instant `system/init` carries it (durability — Spec 02 §2):
 *   surfaced as {@link SpawnResult} and a `session_started` event so the manager can persist
 *   it for `--resume`.
 * - abort() = SIGTERM→SIGKILL the process, retain the session id (Spec 02 §4.5). resume()
 *   relaunches the same invocation with `--resume <session_id>` from the same cwd, replaying
 *   any nudge buffered across the kill as the first user turn.
 * - A driver-owned wall-clock watchdog enforces a GENEROUS, configurable backstop cap
 *   (`config.supervise.worker_hard_cap_s`, drivers/proc.ts#hardCapSeconds) — a runaway safety net,
 *   not a work limit. On a trip it kills the whole process group (no orphans) then emits a terminal
 *   `finished` (subtype `error_wall_clock_cap`) so the dispatcher handles it gracefully (OPS-50).
 *
 * Economics (Spec 00 §4): tokens / `total_cost_usd` are telemetry only — never a budget gate.
 * Auth (Spec 00 §4): subscription only — the child env has any `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` stripped so `claude` always uses the `~/.claude` login.
 */

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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
type Child = ReturnType<typeof Bun.spawn>;

/**
 * Default worker permission mode (Spec 02 §4.1; Spec 12 §1.7): bounded by the worktree + the
 * PreToolUse scope hook, so the worker runs autonomously. Used only when the config does not
 * set `harness.claude.permission_mode`. The config key is honored (S3) — see
 * {@link ClaudeDriver.resolvedPermissionMode}; we never weaken this default.
 */
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/** How long sendNudge waits for the `--replay-user-messages` echo before reporting `queued`. */
const ACK_TIMEOUT_MS = 30_000;

/** How long spawn() waits for the `system/init` line before failing the launch. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long after SIGTERM we escalate to SIGKILL on abort (Spec 02 §4.5). */
const SIGKILL_GRACE_MS = 4_000;

/** Watchdog poll interval (Spec 02 §9.3). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** Env keys that must never reach a child — subscription auth only (Spec 00 §4). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** Tool names whose calls imply a worktree write (Spec 02 §7.1 — file_change is derived). */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * A rate-limit signal surfaced from the result/error shape. Risk-D (failover) is a v1
 * concern (Spec 02 §11); v0 only *exposes the hook* so the orchestrator can react later.
 */
export interface RateLimitSignal {
  source: "result" | "system";
  /** Optional retry hint in ms if the harness surfaced one. */
  retryAfterMs?: number;
  detail: string;
  ts: number;
}

interface PendingNudge {
  text: string;
  resolve: (r: NudgeReceipt) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A subset of the diff stat used for derived telemetry counters. */
interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

export class ClaudeDriver implements HarnessDriver {
  readonly kind = "claude-cli-stream" as const;

  private readonly config: Config;
  private readonly log: Logger;

  private child: Child | null = null;
  /** True when the child was launched as its own process-group leader (setsid) — enables tree-kill. */
  private groupKill = false;
  private spec: SpawnSpec | null = null;
  private stdinBridgePath: string | null = null;

  /** Source of truth for resume identity; minted at spawn or captured from init. */
  private sessionId: string | null = null;
  private pid: number | null = null;

  private workerState: WorkerState = "spawning";
  private finished = false;
  private spawnedAt = 0;
  private lastActivityTs = 0;

  // ── normalized-stream parse state ────────────────────────────────────────────
  private readonly subscribers = new Set<(e: WorkerEvent) => void>();
  private readonly rateLimitSubs = new Set<(s: RateLimitSignal) => void>();
  private readonly seenMsgIds = new Set<string>();
  private readonly seenToolIds = new Set<string>();
  private expectTurnStart = true;

  // ── derived counters (Spec 02 §7.3) ──────────────────────────────────────────
  private turns = 0;
  private toolCalls = 0;
  private tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  private tokensFromStream = false;
  private usd: number | null = null;

  // ── steering ──────────────────────────────────────────────────────────────────
  private readonly pendingNudges: PendingNudge[] = [];
  /** Nudges buffered while paused / between a kill and a resume (Spec 02 §4.5). */
  private readonly bufferedNudges: string[] = [];

  // ── launch lifecycle plumbing ───────────────────────────────────────────────
  private resolveSession: ((r: SpawnResult) => void) | null = null;
  private rejectSession: ((e: Error) => void) | null = null;
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readLoop: Promise<void> = Promise.resolve();

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child("driver.claude");
  }

  /** The current runtime lifecycle state (convenience for the WorkerManager). */
  get state(): WorkerState {
    return this.workerState;
  }

  /** The captured/minted harness session id, or null while still spawning. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /**
   * Launch the worker process, write the initial task line, and resolve once the
   * `system/init` line yields a session id (spawning→running). Rejects if the process
   * dies, or never streams init, before that point.
   */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("ClaudeDriver: already spawned (one driver = one process)");
    this.spec = spec;
    // Own resume identity from t=0: mint a UUID unless the caller supplied one (Spec 02 §4.1).
    this.sessionId = spec.sessionId ?? crypto.randomUUID();

    const args = this.buildArgs({ kind: "spawn", sessionId: this.sessionId });
    return this.launch(args, /*isResume*/ false, spec.prompt);
  }

  // ===========================================================================
  // sendNudge
  // ===========================================================================

  /**
   * Write one NDJSON `user` line to the child's stdin and flush (Spec 02 §4.4). Resolves
   * `delivered` when the `--replay-user-messages` echo confirms ingestion, or `queued` if
   * the echo never arrives within {@link ACK_TIMEOUT_MS}. When the process is paused, dead,
   * or terminal the nudge is *buffered* and reported `queued` — it is replayed as the first
   * user turn of the next resume (Spec 02 §4.5).
   */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    const deliverable =
      this.child !== null &&
      !this.finished &&
      this.workerState !== "paused" &&
      !this.isTerminal();

    if (!deliverable) {
      this.bufferedNudges.push(msg);
      this.log.info("nudge buffered (worker not live)", { state: this.workerState });
      return { accepted: "queued", at: Date.now() };
    }

    return new Promise<NudgeReceipt>((resolve) => {
      const timer = setTimeout(() => {
        // No echo in time → it is buffered inside claude but unacked; report honestly.
        const idx = this.pendingNudges.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pendingNudges.splice(idx, 1);
        if (this.workerState === "nudging") this.setState("running");
        resolve({ accepted: "queued", at: Date.now() });
      }, ACK_TIMEOUT_MS);
      this.pendingNudges.push({ text: msg, resolve, timer });
      try {
        this.writeUserLine(msg);
        this.setState("nudging");
        this.log.info("nudge written to stdin", { len: msg.length });
      } catch (err) {
        const idx = this.pendingNudges.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pendingNudges.splice(idx, 1);
        clearTimeout(timer);
        this.bufferedNudges.push(msg);
        this.log.warn("nudge write failed; buffered for resume", { error: String(err) });
        resolve({ accepted: "queued", at: Date.now() });
      }
    });
  }

  // ===========================================================================
  // pause / resume / abort
  // ===========================================================================

  /**
   * Checkpoint without killing (Spec 02 §4.5): the process is left alive but idle and the
   * driver stops feeding stdin. The on-disk transcript + worktree git state are the durable
   * checkpoint; nudges sent while paused are buffered and flushed on resume.
   */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (stdin quiesced; session retained)", {
      sessionId: this.sessionId,
    });
  }

  /**
   * Re-attach a paused/crashed worker (Spec 02 §4.5). If the process is still alive this
   * just lifts the pause and flushes buffered nudges. If it has exited, the same invocation
   * is relaunched with `--resume <session_id>` from the same cwd, restoring full context.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error("ClaudeDriver: resume before spawn");
    if (!this.sessionId) throw new Error("ClaudeDriver: resume without a session id");

    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.flushBufferedNudges();
      this.log.info("worker resumed (process still alive)");
      return;
    }

    this.log.info("relaunching with --resume", { sessionId: this.sessionId });
    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.expectTurnStart = true;
    this.seenMsgIds.clear();
    this.seenToolIds.clear();

    const args = this.buildArgs({ kind: "resume", sessionId: this.sessionId });
    await this.launch(args, /*isResume*/ true, null);
    this.flushBufferedNudges();
  }

  /**
   * Hard stop (Spec 02 §4.5): SIGTERM, then SIGKILL after a short grace. The session id is
   * retained so the supervisor can inspect the partial diff and optionally re-dispatch via
   * resume. Idempotent.
   */
  async abort(reason: string): Promise<void> {
    this.log.warn("aborting worker", { reason, sessionId: this.sessionId });
    this.setState("aborted");
    await this.killChild();
  }

  // ===========================================================================
  // onEvent / getTelemetry / onRateLimit
  // ===========================================================================

  /** Subscribe to the normalized event stream; returns an unsubscribe fn (Spec 02 §3). */
  onEvent(cb: (e: WorkerEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Subscribe to rate-limit signals derived from the result/error shape. v0 exposes the
   * seam for Risk-D failover (Spec 02 §11) without acting on it. Returns an unsubscribe fn.
   */
  onRateLimit(cb: (s: RateLimitSignal) => void): () => void {
    this.rateLimitSubs.add(cb);
    return () => this.rateLimitSubs.delete(cb);
  }

  /**
   * Snapshot of derived counters (Spec 02 §7.3). Cheap: reads in-memory accumulators and
   * shells `git diff --numstat` (+ staged) in the worktree for the ground-truth diff size.
   */
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

  /** Epoch ms of the last parsed event (watchdog input, Spec 02 §7.3). */
  getLastActivityTs(): number {
    return this.lastActivityTs;
  }

  // ===========================================================================
  // internal — launch / process lifecycle
  // ===========================================================================

  private async launch(
    args: string[],
    isResume: boolean,
    initialPrompt: string | null,
  ): Promise<SpawnResult> {
    const spec = this.spec!;
    const bin = this.config.harness.claude.bin;
    this.setState("spawning");
    this.spawnedAt = this.spawnedAt || Date.now();
    this.lastActivityTs = Date.now();
    this.prepareStdinBridge(spec);

    const sessionReady = new Promise<SpawnResult>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });

    this.log.info("spawning claude worker", {
      bin,
      workspace: spec.workspace,
      model: this.resolvedModel(),
      isResume,
      sessionId: this.sessionId,
    });

    // Launch as a NEW process group (setsid) so abort/timeout can kill the whole tree — the
    // harness plus every bash/MCP/sub-agent child it forks — with one group signal, leaving no
    // orphan behind to keep mutating the checkout (OPS-45/OPS-50).
    const { cmd, groupKill } = wrapProcessGroup(bin, args);
    this.groupKill = groupKill;

    let child: Child;
    try {
      child = Bun.spawn({
        cmd,
        cwd: spec.workspace,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: this.childEnv(),
      });
    } catch (err) {
      const e = new Error(`ClaudeDriver: failed to spawn ${bin} — ${(err as Error).message}`);
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;

    // Fail the launch if init never arrives.
    this.spawnTimer = setTimeout(() => {
      const err = new Error(`ClaudeDriver: no system/init within ${SPAWN_TIMEOUT_MS}ms`);
      this.rejectSession?.(err);
      this.resolveSession = null;
      this.rejectSession = null;
      this.setState("failed");
      void this.killChild();
    }, SPAWN_TIMEOUT_MS);

    // Consume stdout (and drain stderr) without blocking the daemon.
    this.readLoop = this.consumeStdout(child).catch((err) => {
      this.log.error("stdout read loop crashed", { err: String(err) });
    });
    void this.drainStderr(child);

    // Watch for process exit (covers crashes that never emit a result line).
    void child.exited.then((code) => this.onProcessExit(code));

    // Arm the wall-clock watchdog once (survives resumes).
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }

    // Send the initial task as the first user line (skipped on resume — context restored).
    if (initialPrompt !== null) this.writeUserLine(initialPrompt);

    return sessionReady;
  }

  private resolvedModel(): string {
    return this.spec?.model || this.config.harness.claude.default_model;
  }

  /**
   * The reasoning effort passed to `--effort` (claude 2.1.197: low|medium|high|xhigh|max). The
   * per-stage cast effort (carried on the envelope) wins; otherwise the configured worker default.
   */
  private resolvedEffort(): string {
    return this.spec?.envelope.effort || this.config.harness.claude.default_effort;
  }

  /**
   * The permission mode passed to `--permission-mode`, honoring the config key (S3 — the key
   * was dead before this). Falls back to {@link DEFAULT_PERMISSION_MODE} when unset/blank so
   * the default is never weakened (Spec 02 §4.1; Spec 12 §1.7).
   */
  private resolvedPermissionMode(): string {
    const mode = this.config.harness.claude.permission_mode;
    return mode && mode.trim().length > 0 ? mode : DEFAULT_PERMISSION_MODE;
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
    if (this.stdinBridgePath) env.BECKETT_STDIN_BRIDGE = this.stdinBridgePath;
    return env;
  }

  private buildArgs(mode: { kind: "spawn" | "resume"; sessionId: string }): string[] {
    const spec = this.spec!;
    const args: string[] = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode",
      this.resolvedPermissionMode(),
      "--model",
      this.resolvedModel(),
      "--effort",
      this.resolvedEffort(),
      // No --max-turns: envelopes are ESTIMATES, not caps (Spec 02 §7 / canon). turnCap drives the
      // supervisor's drift look, never a hard kill — capping here truncates legitimate long work.
    ];

    if (mode.kind === "spawn") args.push("--session-id", mode.sessionId);
    else args.push("--resume", mode.sessionId);

    if (spec.systemAppend && spec.systemAppend.trim().length > 0) {
      args.push("--append-system-prompt", spec.systemAppend);
    }
    if (spec.mcpConfigPath) args.push("--mcp-config", spec.mcpConfigPath);
    // v3.1: the scope-guard hook rides here (NOT the worktree's .claude/settings.json) so a
    // checkout's own settings are never clobbered — claude layers --settings on top of them.
    if (spec.settingsPath) args.push("--settings", spec.settingsPath);
    // claude's --json-schema takes the schema JSON INLINE, not a file path (verified on 2.1.195;
    // a path makes claude exit 1 before init). Read the done-schema file and pass its contents.
    if (spec.doneSchemaPath) {
      try {
        args.push("--json-schema", readFileSync(spec.doneSchemaPath, "utf8"));
      } catch {
        /* if the schema file is unreadable, skip it rather than crash the worker spawn */
      }
    }

    // Append configured extra flags (e.g. --include-hook-events) without duplicating ours.
    for (const f of this.config.harness.claude.extra_flags) {
      if (!args.includes(f)) args.push(f);
    }
    return args;
  }

  private async onProcessExit(code: number): Promise<void> {
    this.child = null;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // If the launch promise is still pending, the process died before init — fail it.
    if (this.resolveSession && !this.sessionStartedEmitted) {
      this.rejectSession?.(new Error(`ClaudeDriver: process exited (code ${code}) before init`));
      this.resolveSession = null;
      this.rejectSession = null;
    }
    // If it exited without a terminal result, synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      this.emit({ kind: "error", message: `claude process exited (code ${code})`, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_process_exit",
        structuredOutput: null,
        usage: { ...this.tokens },
        ts,
      });
      this.finished = true;
      this.setState("failed");
    }
    this.failPendingNudges();
    // Sweep any descendant the harness left running so a retry worker can't collide with an orphan.
    killGroup(this.pid ?? -1, this.groupKill, this.log);
  }

  private tickWatchdog(): void {
    if (!this.spec || this.finished || this.isTerminal()) return;
    const capS = hardCapSeconds(this.config);
    const totalS = (Date.now() - this.spawnedAt) / 1000;
    if (totalS <= capS) return;
    // Trip the generous backstop cap. Set finished up-front so this can't re-enter on the next tick
    // and so onProcessExit (fired by the kill below) won't also synthesize a finish.
    this.finished = true;
    void this.timeOut(capS, totalS);
  }

  /**
   * Handle a hard-cap timeout GRACEFULLY (never a silent death, OPS-50). The whole process tree is
   * killed FIRST — so no orphan is still mutating the checkout when the dispatcher reacts — and only
   * then do we emit a terminal `finished` (subtype `error_wall_clock_cap`). The dispatcher keys on
   * that to commit/push the worker's WIP, comment on the ticket, and retry / return it to a ready
   * state, instead of leaving it silently wedged in in_progress.
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
    this.failPendingNudges();
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
      // flush any trailing partial line
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
        if (text) this.log.debug("claude stderr", { text });
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse one raw NDJSON line and fan out normalized {@link WorkerEvent}s. Tolerant by
   * contract (Spec 02 §7.2): a malformed line, an unknown `type`, or an unknown `system`
   * subtype becomes a `kind:'unknown'` event — never a throw.
   */
  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({ kind: "unknown", raw: line, ts: Date.now() });
      return;
    }

    try {
      switch (obj.type) {
        case "system":
          this.handleSystem(obj);
          break;
        case "assistant":
          this.handleAssistant(obj);
          break;
        case "user":
          this.handleUser(obj);
          break;
        case "stream_event":
          this.handleStreamEvent(obj);
          break;
        case "result":
          this.handleResult(obj);
          break;
        case "error":
          this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
          break;
        default:
          this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
      }
    } catch (err) {
      // A surprising-but-parseable line must never take down the loop (Risk-A).
      this.log.warn("event normalization error (routed to unknown)", { err: String(err) });
      this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private sessionStartedEmitted = false;

  private handleSystem(obj: Record<string, unknown>): void {
    const ts = Date.now();
    if (obj.subtype === "init") {
      const sid = this.str(obj.session_id) ?? this.sessionId;
      const model = this.str(obj.model) ?? this.resolvedModel();
      if (sid) this.sessionId = sid;
      this.sessionStartedEmitted = true;
      this.emit({ kind: "session_started", sessionId: this.sessionId!, model, ts });

      // The launch is confirmed running once init streams.
      if (this.spawnTimer) {
        clearTimeout(this.spawnTimer);
        this.spawnTimer = null;
      }
      this.setState("running");
      this.resolveSession?.({ sessionId: this.sessionId!, pid: this.pid ?? -1 });
      this.resolveSession = null;
      this.rejectSession = null;
      return;
    }

    // api_retry / overloaded notices can carry a rate-limit hint (Spec 02 §11 seam).
    if (typeof obj.subtype === "string" && /rate.?limit|overload|api_retry/i.test(obj.subtype)) {
      this.emitRateLimit({ source: "system", detail: `system/${obj.subtype}`, ts });
    }

    // Any other system subtype (thinking_tokens, task_started, …) is tolerated as unknown.
    this.emit({ kind: "unknown", raw: obj, ts });
  }

  private handleAssistant(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) {
      this.emit({ kind: "unknown", raw: obj, ts });
      return;
    }
    const id = this.str(message.id);
    const firstSight = !!id && !this.seenMsgIds.has(id);
    if (id) this.seenMsgIds.add(id);

    // Synthesize a turn_started on the first assistant line of a turn (Spec 02 §7.1).
    if (this.expectTurnStart && firstSight) {
      this.expectTurnStart = false;
      this.turns += 1;
      this.emit({ kind: "turn_started", ts });
    }

    // Token usage: count once per message.id (dedup parallel tool-call lines, §7.3).
    if (firstSight) {
      const usage = this.mapUsage(message.usage);
      if (usage) {
        this.addTokens(usage);
        this.emit({ kind: "turn_completed", usage, ts });
      }
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block.type === "text" && firstSight) {
        this.emit({ kind: "assistant_text", text: this.str(block.text) ?? "", partial: false, ts });
      } else if (block.type === "tool_use") {
        const toolId = this.str(block.id) ?? "";
        if (toolId && this.seenToolIds.has(toolId)) continue;
        if (toolId) this.seenToolIds.add(toolId);
        const tool = this.str(block.name) ?? "unknown";
        this.toolCalls += 1;
        this.emit({ kind: "tool_call", tool, input: block.input ?? null, toolId, ts });
        this.maybeFileChange(tool, block.input, ts);
      }
    }
  }

  /** Derive a file_change event from a write-tool call (Spec 02 §7.1 — not a claude event). */
  private maybeFileChange(tool: string, input: unknown, ts: number): void {
    if (!WRITE_TOOLS.has(tool)) return;
    const inp = (input ?? {}) as Record<string, unknown>;
    const path = this.str(inp.file_path) ?? this.str(inp.notebook_path);
    if (!path) return;
    const kind = tool === "Write" ? "add" : "update";
    this.emit({ kind: "file_change", paths: [{ path, kind }], ts });
  }

  private handleUser(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Replayed nudge as a bare string (Spec 02 §4.4 ack).
    if (typeof content === "string") {
      this.emitUserEcho(content, ts);
      return;
    }
    if (!Array.isArray(content)) {
      this.emit({ kind: "unknown", raw: obj, ts });
      return;
    }

    const toolResults = content.filter(
      (b) => (b as Record<string, unknown>)?.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const raw of toolResults) {
        const b = raw as Record<string, unknown>;
        this.emit({
          kind: "tool_result",
          toolId: this.str(b.tool_use_id) ?? "",
          isError: b.is_error === true,
          ts,
        });
      }
      // A tool batch resolved → the next assistant line opens a new turn.
      this.expectTurnStart = true;
      return;
    }

    // Otherwise this is a replayed user input (our nudge) carrying text blocks.
    const text = content
      .map((b) => (b as Record<string, unknown>)?.type === "text" ? this.str((b as Record<string, unknown>).text) ?? "" : "")
      .join("");
    this.emitUserEcho(text, ts);
  }

  private emitUserEcho(text: string, ts: number): void {
    this.emit({ kind: "user_echo", text, ts });
    this.matchNudgeEcho(text);
  }

  private handleStreamEvent(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const event = obj.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      this.emit({ kind: "assistant_text", text: this.str(delta.text) ?? "", partial: true, ts });
      return;
    }
    this.emit({ kind: "unknown", raw: obj, ts });
  }

  private handleResult(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const subtype = this.str(obj.subtype) ?? "unknown";
    const isError = obj.is_error === true || subtype !== "success";

    // Authoritative cumulative counters from the result line (Spec 02 §7.3).
    if (typeof obj.num_turns === "number") this.turns = obj.num_turns;
    if (typeof obj.total_cost_usd === "number") this.usd = obj.total_cost_usd;
    const usage = this.mapUsage(obj.usage);
    // Prefer the streamed per-turn sum; fall back to result.usage if we never saw any.
    if (usage && !this.tokensFromStream) this.tokens = usage;

    this.emit({
      kind: "finished",
      status: isError ? "error" : "success",
      subtype,
      structuredOutput: obj.structured_output ?? null,
      usage: { ...this.tokens },
      ts,
    });
    this.finished = true;
    this.stopWatchdog();
    this.closeChildStdin();

    // success → handed to GATE (review); error subtypes → failed (Spec 02 §7.1 table).
    if (this.isTerminal()) {
      // abort already won the race; keep that terminal state.
    } else if (subtype === "success") {
      this.setState("review");
    } else {
      this.setState("failed");
    }

    // Rate-limit detection seam (Spec 02 §11, Risk-D is v1).
    this.detectRateLimitFromResult(obj, subtype, ts);
    this.failPendingNudges();
  }

  private closeChildStdin(): void {
    const child = this.child;
    if (!child) return;
    const sink = child.stdin as { end?: () => void; close?: () => void } | undefined;
    try {
      sink?.end?.();
      sink?.close?.();
    } catch (err) {
      this.log.debug("stdin close after result failed", { err: String(err) });
    }
  }

  private detectRateLimitFromResult(
    obj: Record<string, unknown>,
    subtype: string,
    ts: number,
  ): void {
    const status = typeof obj.api_error_status === "number" ? obj.api_error_status : undefined;
    const errors = Array.isArray(obj.errors) ? obj.errors.join(" ").toLowerCase() : "";
    const hit =
      status === 429 ||
      /rate.?limit|too many requests|overloaded|quota/.test(errors) ||
      (subtype === "error_during_execution" && /rate.?limit|overload/.test(errors));
    if (hit) {
      this.emitRateLimit({
        source: "result",
        detail: `result/${subtype}${status ? ` status=${status}` : ""}`,
        ts,
      });
    }
  }

  // ===========================================================================
  // internal — helpers
  // ===========================================================================

  private writeUserLine(content: string): void {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      }) + "\n";

    if (this.stdinBridgePath) {
      try {
        appendFileSync(this.stdinBridgePath, line);
      } catch (err) {
        this.log.debug("stdin bridge write failed", { err: String(err) });
      }
    }

    const child = this.child;
    if (!child) return;
    const sink = child.stdin;
    if (!sink || typeof (sink as { write?: unknown }).write !== "function") return;
    const fileSink = sink as { write: (s: string) => void; flush?: () => void };
    try {
      fileSink.write(line);
      fileSink.flush?.();
    } catch (err) {
      this.log.debug("stdin pipe write failed after bridge write (continuing)", {
        err: String(err),
      });
    }
  }

  private prepareStdinBridge(spec: SpawnSpec): void {
    // Bun 1.3.x can fail live subprocess stdin writes in some sandboxes with
    // `EPERM: send`. The fake harness reads this bridge when present, while real
    // claude ignores the env var and continues using the stdin pipe above.
    const bin = this.config.harness.claude.bin;
    const fakeHarness =
      process.env.BECKETT_FAKE_SPEED !== undefined ||
      process.env.BECKETT_FAKE_SCENARIO !== undefined ||
      /fake-(claude|harness)/.test(bin);
    if (!fakeHarness) {
      this.stdinBridgePath = null;
      return;
    }
    const path = join(spec.workspace, ".beckett", `stdin-${this.sessionId ?? "session"}.ndjson`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
      this.stdinBridgePath = path;
    } catch (err) {
      this.stdinBridgePath = null;
      this.log.debug("stdin bridge unavailable", { err: String(err) });
    }
  }

  private flushBufferedNudges(): void {
    if (this.bufferedNudges.length === 0) return;
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    for (const msg of pending) this.writeUserLine(msg);
    this.log.info("flushed buffered nudges", { count: pending.length });
  }

  private matchNudgeEcho(text: string): void {
    if (this.pendingNudges.length === 0) return;
    // S1: an EXACT echo across all pending wins first; a substring/loose match must NOT let a
    // later exact match be acked early (two pending "stop"/"stop now" → "stop now" must ack
    // "stop now", not "stop"). claude replays nudges in FIFO order, so when no pending text is
    // an exact match (e.g. the echo was reformatted) we fall back to the OLDEST pending nudge.
    let idx = this.pendingNudges.findIndex((p) => p.text === text);
    if (idx < 0) idx = 0; // FIFO-oldest fallback
    const p = this.pendingNudges.splice(idx, 1)[0];
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve({ accepted: "delivered", at: Date.now() });
    if (this.pendingNudges.length === 0 && this.workerState === "nudging") {
      this.setState("running");
    }
  }

  private failPendingNudges(): void {
    if (this.pendingNudges.length === 0) return;
    const pending = this.pendingNudges.splice(0, this.pendingNudges.length);
    for (const p of pending) {
      clearTimeout(p.timer);
      p.resolve({ accepted: "queued", at: Date.now() });
    }
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

  private emitRateLimit(s: RateLimitSignal): void {
    this.log.warn("rate-limit signal", { source: s.source, detail: s.detail });
    for (const cb of this.rateLimitSubs) {
      try {
        cb(s);
      } catch (err) {
        this.log.warn("rate-limit subscriber threw", { err: String(err) });
      }
    }
  }

  /** Clear the wall-clock watchdog interval (idempotent). */
  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private setState(state: WorkerState): void {
    this.workerState = state;
    // Tear down the watchdog once the worker reaches a terminal state.
    if (this.isTerminal() && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private isTerminal(): boolean {
    return (
      this.workerState === "done" ||
      this.workerState === "failed" ||
      this.workerState === "aborted"
    );
  }

  private mapUsage(raw: unknown): TokenUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const u = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const usage: TokenUsage = {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheCreate: n(u.cache_creation_input_tokens),
    };
    if (usage.input + usage.output + usage.cacheRead + usage.cacheCreate === 0) return null;
    return usage;
  }

  private addTokens(u: TokenUsage): void {
    this.tokens.input += u.input;
    this.tokens.output += u.output;
    this.tokens.cacheRead += u.cacheRead;
    this.tokens.cacheCreate += u.cacheCreate;
    this.tokensFromStream = true;
  }

  /** Ground-truth diff size from git (Spec 02 §7.4): uncommitted + staged, distinct files. */
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
