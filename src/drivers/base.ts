/**
 * Beckett — shared harness-driver lifecycle (`src/drivers/base.ts`)
 * =======================================================================================
 * The ONE copy of the child-process plumbing that used to be hand-copied across
 * `claude.ts` / `codex.ts` / `pi.ts` (issue #19 — ~800 triplicated lines whose divergences
 * were exactly where the lifecycle bugs lived: a missing gen guard here, a missing
 * spawn-timeout kill there, a watchdog that outlived its worker).
 *
 * {@link BaseDriver} owns everything harness-agnostic:
 *   - launch scaffold: setsid process group, session-ready promise, spawn-timeout KILL,
 *     stdout pump → `handleLine`, stderr pump → ring buffer, exit watcher with childGen guard
 *   - the generous wall-clock backstop watchdog (`supervise.worker_hard_cap_s`) + graceful
 *     `error_wall_clock_cap` finish
 *   - unified `onProcessExit`: superseded-child sweep, launch-failure rejection with the
 *     stderr tail folded in, synthesized error finish with the issue-#17 failure taxonomy
 *   - state machine (`setState`/`isTerminal`), event fan-out, token accounting, diff sizing,
 *     telemetry snapshot, pause/abort
 *
 * Subclasses provide ONLY the format-specific surface: argv construction, line parsing, and
 * how the harness handshakes its session id. {@link OneShotDriver} adds the buffered-nudge /
 * relaunch-to-steer machinery shared by the one-shot harnesses (codex `exec`, pi `-p`).
 * Adding harness #4 should be ~150 lines of parsing, not another ~900-line hand-copy.
 */

import type {
  Config,
  Logger,
  NudgeReceipt,
  SpawnResult,
  SpawnSpec,
  TokenUsage,
  WorkerEvent,
  WorkerSpend,
  WorkerState,
} from "../types.ts";
import { makeLogger } from "../log.ts";
import { diffStatSync } from "../git/diff.ts";
import { childEnv } from "../env.ts";
import { hardCapSeconds, killGroup, killProcessTree, wrapProcessGroup } from "./proc.ts";
import { classifyHarnessFailure, StderrRing } from "./failure.ts";

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
export type Child = ReturnType<typeof Bun.spawn>;

/** How long spawn() waits for the harness's session handshake before failing the launch. */
export const SPAWN_TIMEOUT_MS = 60_000;

/** How long after SIGTERM we escalate to SIGKILL on abort (Spec 02 §4.5). */
export const SIGKILL_GRACE_MS = 4_000;

/** Watchdog poll interval (Spec 02 §9.3). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** Fallback instruction when a one-shot resume() has no buffered nudge to replay. */
export const DEFAULT_RESUME_PROMPT = "Please continue from where you left off.";

export abstract class BaseDriver {
  protected readonly config: Config;
  protected readonly log: Logger;

  protected child: Child | null = null;
  /** True when the child was launched as its own process-group leader (setsid) — enables tree-kill. */
  protected groupKill = false;
  protected spec: SpawnSpec | null = null;

  /** Resume identity (claude session id / codex thread id / pi session id). */
  protected sessionId: string | null = null;
  protected pid: number | null = null;

  protected workerState: WorkerState = "spawning";
  protected finished = false;
  protected spawnedAt = 0;
  protected lastActivityTs = 0;
  /** Incremented per child process; an exit whose gen != current is a superseded child (ignored). */
  protected childGen = 0;

  // ── event fan-out + diagnostics ────────────────────────────────────────────
  protected readonly subscribers = new Set<(e: WorkerEvent) => void>();
  /** Last ~20 stderr lines — the self-diagnosing tail folded into failure messages (issue #17). */
  protected readonly stderrRing = new StderrRing();

  // ── derived counters (Spec 02 §7.3) ────────────────────────────────────────
  protected turns = 0;
  protected toolCalls = 0;
  protected tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  // ── launch lifecycle plumbing ──────────────────────────────────────────────
  /** True once the harness's session handshake (init / thread.started / session line) arrived. */
  protected sessionEmitted = false;
  protected resolveSession: ((r: SpawnResult) => void) | null = null;
  protected rejectSession: ((e: Error) => void) | null = null;
  protected spawnTimer: ReturnType<typeof setTimeout> | null = null;
  protected watchdog: ReturnType<typeof setInterval> | null = null;
  protected readLoop: Promise<void> = Promise.resolve();

  constructor(config: Config, logger: Logger | undefined, logComponent: string) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child(logComponent);
  }

  // ===========================================================================
  // subclass surface
  // ===========================================================================

  /** Short harness name ("claude" | "codex" | "pi") for log/error text. */
  protected abstract harnessName(): string;
  /** Parse one raw stdout line and fan out normalized events. MUST tolerate anything. */
  protected abstract handleLine(line: string): void;
  /** Driver-specific $ estimate for {@link getTelemetry} (stream cost / price table / null). */
  protected abstract usdEstimate(): number | null;

  /** stdin wiring for the child: one-shot harnesses take the prompt as argv → EOF stdin. */
  protected stdinMode(): "pipe" | "ignore" {
    return "ignore";
  }

  /** Child env (API keys stripped — src/env.ts). Override to layer driver-specific vars. */
  protected buildChildEnv(): Record<string, string | undefined> {
    return childEnv();
  }

  /** Hook fired right after a child is spawned and pumps are attached (claude: write prompt). */
  protected afterLaunch(_child: Child, _isResume: boolean): void {}

  /** The structured output attached to a synthesized crash finish (pi reports blocked). */
  protected exitFinishStructuredOutput(_message: string): unknown | null {
    return null;
  }

  /**
   * The Error a failed LAUNCH rejects with (child died / timed out before its handshake).
   * Includes the stderr tail so "exited before init" is self-diagnosing. Overridable for
   * harness-specific hints (pi names its common causes).
   */
  protected spawnFailureError(reason: string | number): Error {
    const tail = this.stderrRing.tail();
    const detail = tail ? ` stderr tail:\n${tail}` : " (nothing on stderr)";
    return new Error(
      `${this.constructor.name}: ${this.harnessName()} exited (${reason}) before its session handshake —` +
        ` the harness never started.${detail}`,
    );
  }

  /** Extra key/values for the "spawning worker" log line. */
  protected launchLogFields(): Record<string, unknown> {
    return {};
  }

  // ===========================================================================
  // HarnessDriver surface (shared)
  // ===========================================================================

  get state(): WorkerState {
    return this.workerState;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Subscribe to the normalized event stream; returns an unsubscribe fn (Spec 02 §3). */
  onEvent(cb: (e: WorkerEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Snapshot of derived counters (Spec 02 §7.3). Cheap: reads in-memory accumulators and
   * shells `git diff --numstat` (+ staged) in the workspace for the ground-truth diff size.
   */
  getTelemetry(): WorkerSpend {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      tokens: { ...this.tokens },
      diffLines: diffStatSync(this.spec?.workspace),
      usdEstimate: this.usdEstimate(),
    };
  }

  /** Epoch ms of the last parsed event (watchdog input, Spec 02 §7.3). */
  getLastActivityTs(): number {
    return this.lastActivityTs;
  }

  /** Checkpoint without killing — the persisted session + workspace git state are the checkpoint. */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (session retained)", { sessionId: this.sessionId });
  }

  /** Hard stop: SIGTERM→SIGKILL the whole group after a grace; retain the session id. Idempotent. */
  async abort(reason: string): Promise<void> {
    this.log.warn("aborting worker", { reason, sessionId: this.sessionId });
    this.setState("aborted");
    await this.killChild();
  }

  // ===========================================================================
  // launch scaffold (shared)
  // ===========================================================================

  /**
   * Spawn the harness child and resolve once its session handshake arrives. Owns: process-group
   * wrapping (tree-kill), the spawn-timeout KILL (a hung boot must not survive unsupervised),
   * stdout/stderr pumps, the exit watcher (childGen-guarded), and the wall-clock watchdog.
   */
  protected async launch(
    args: string[],
    opts: { isResume: boolean; initialPrompt?: string | null } = { isResume: false },
  ): Promise<SpawnResult> {
    const spec = this.spec!;
    const bin = this.binName();
    this.setState("spawning");
    this.spawnedAt = this.spawnedAt || Date.now();
    this.lastActivityTs = Date.now();

    const sessionReady = new Promise<SpawnResult>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });

    this.log.info(`spawning ${this.harnessName()} worker`, {
      bin,
      workspace: spec.workspace,
      isResume: opts.isResume,
      sessionId: this.sessionId,
      ...this.launchLogFields(),
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
        stdin: this.stdinMode(),
        stdout: "pipe",
        stderr: "pipe",
        env: this.buildChildEnv(),
      });
    } catch (err) {
      const e = new Error(
        `${this.constructor.name}: failed to spawn ${bin} — ${(err as Error).message}`,
      );
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;
    const gen = ++this.childGen;

    // Fail the launch — AND kill the child — if the handshake never arrives. A late-booting
    // harness left alive would run unsupervised and unaccounted (issue #11 leak 5).
    this.spawnTimer = setTimeout(() => {
      const err = this.spawnFailureError(`no session handshake within ${SPAWN_TIMEOUT_MS}ms`);
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

    // Arm the wall-clock watchdog once (survives resumes).
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }

    this.afterLaunch(child, opts.isResume);
    return sessionReady;
  }

  /** The harness binary from config (subclass points at its `harness.<h>.bin`). */
  protected abstract binName(): string;

  /**
   * Unified exit handling: superseded children are swept and ignored (gen guard); a death
   * before the handshake rejects the launch with the stderr tail; a death without a terminal
   * finish synthesizes an `error_process_exit` finish carrying the issue-#17 failure class;
   * and any descendants the harness left running are group-swept.
   */
  protected async onProcessExit(
    code: number,
    gen: number,
    pid: number,
    groupKill: boolean,
  ): Promise<void> {
    if (gen !== this.childGen) {
      killGroup(pid, groupKill, this.log);
      return; // superseded child (auto-resume relaunch) — not ours
    }
    this.child = null;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // Drain any final buffered stdout lines BEFORE deciding — the terminal line (result /
    // turn.completed / agent_end) often flushes immediately before exit.
    await this.readLoop;

    // Launch still pending → the process died before its handshake; fail it loudly.
    if (this.resolveSession && !this.sessionEmitted) {
      this.rejectSession?.(this.spawnFailureError(code));
      this.resolveSession = null;
      this.rejectSession = null;
    }
    // Exited without a terminal finish → synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      const message = this.processExitMessage(code);
      this.emit({ kind: "error", message, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_process_exit",
        structuredOutput: this.exitFinishStructuredOutput(message),
        usage: { ...this.tokens },
        errorClass: classifyHarnessFailure(message) ?? "crash",
        ts,
      });
      this.finished = true;
      this.setState("failed");
    }
    this.onExitCleanup();
    // Sweep any descendant the harness left running so a retry worker can't collide with an orphan.
    killGroup(this.pid ?? -1, this.groupKill, this.log);
  }

  /** Hook after exit bookkeeping, before the descendant sweep (claude fails pending nudges). */
  protected onExitCleanup(): void {}

  protected tickWatchdog(): void {
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
   * tree FIRST — so no orphan is still mutating the checkout when the dispatcher reacts — then
   * emit a terminal `finished` (subtype `error_wall_clock_cap`) the dispatcher keys on to commit
   * WIP, comment on the ticket, and retry / return it to a ready state.
   */
  protected async timeOut(capS: number, totalS: number): Promise<void> {
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
      errorClass: "timeout",
      ts: Date.now(),
    });
  }

  protected async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Kill the whole process group (harness + descendants) so nothing is orphaned (OPS-50).
    await killProcessTree(child, { groupKill: this.groupKill, graceMs: SIGKILL_GRACE_MS, log: this.log });
  }

  // ===========================================================================
  // stdout / stderr pumps (shared)
  // ===========================================================================

  protected async consumeStdout(child: Child): Promise<void> {
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

  protected async drainStderr(child: Child): Promise<void> {
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
          this.log.debug(`${this.harnessName()} stderr`, { text });
          this.stderrRing.record(text);
        }
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  /** "<harness> process exited (code N)" + the stderr tail — self-diagnosing (issue #17). */
  protected processExitMessage(code: number): string {
    const tail = this.stderrRing.tail();
    return tail
      ? `${this.harnessName()} process exited (code ${code}). stderr tail:\n${tail}`
      : `${this.harnessName()} process exited (code ${code})`;
  }

  // ===========================================================================
  // small shared helpers
  // ===========================================================================

  protected emit(e: WorkerEvent): void {
    this.lastActivityTs = e.ts;
    for (const cb of this.subscribers) {
      try {
        cb(e);
      } catch (err) {
        this.log.warn("event subscriber threw", { err: String(err), kind: e.kind });
      }
    }
  }

  protected setState(state: WorkerState): void {
    this.workerState = state;
    // Tear down the watchdog once the worker reaches a terminal state.
    if (this.isTerminal() && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  protected isTerminal(): boolean {
    return (
      this.workerState === "done" || this.workerState === "failed" || this.workerState === "aborted"
    );
  }

  protected addTokens(u: TokenUsage): void {
    this.tokens.input += u.input;
    this.tokens.output += u.output;
    this.tokens.cacheRead += u.cacheRead;
    this.tokens.cacheCreate += u.cacheCreate;
  }

  protected stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  protected str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
  }
}

// =======================================================================================
// OneShotDriver — the buffered-nudge / relaunch-to-steer layer (codex exec, pi -p)
// =======================================================================================

/**
 * A one-shot harness runs prompt → one agentic run → process exit; there is no mid-turn steer
 * channel. Steering is therefore ALWAYS buffered and applied by a full relaunch-with-resume
 * after the current run ends — the receipt says so honestly (`will-restart`, issue #19), and a
 * nudge after the terminal finish is reported `dropped` so the dispatcher can tell the human
 * instead of silently eating their words.
 */
export abstract class OneShotDriver extends BaseDriver {
  /** Steering buffered for the next resume (exec is one-shot). */
  protected readonly bufferedNudges: string[] = [];

  /** Rebuild the resume argv for a relaunch continuing this driver's persisted session. */
  protected abstract buildResumeArgs(prompt: string): string[];
  /** Reset per-process parse state before a relaunch (counters/session stay cumulative). */
  protected abstract resetParseState(): void;

  async sendNudge(msg: string): Promise<NudgeReceipt> {
    if (this.finished || this.isTerminal()) {
      this.log.warn("nudge arrived after finish — dropped (nothing will ever replay it)", {
        state: this.workerState,
      });
      return { accepted: "dropped", at: Date.now() };
    }
    this.bufferedNudges.push(msg);
    this.log.info(`nudge buffered for next resume (${this.harnessName()} is one-shot)`, {
      state: this.workerState,
      pending: this.bufferedNudges.length,
    });
    return { accepted: "will-restart", at: Date.now() };
  }

  /** Drain buffered nudges into one resume prompt (falls back to a generic "continue"). */
  protected takeBufferedPrompt(): string {
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    return pending.length ? pending.join("\n\n") : DEFAULT_RESUME_PROMPT;
  }

  /**
   * Re-attach a paused/finished worker. A still-live process means a run is in flight (one-shot
   * harnesses can't be steered mid-run) so resume just lifts the pause; buffered steering
   * applies after the run ends. If the process exited, relaunch against the persisted session
   * with the buffered instruction as the new prompt.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error(`${this.constructor.name}: resume before spawn`);
    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.log.info("worker resumed (run still in flight; steering applies after it ends)", {
        pending: this.bufferedNudges.length,
      });
      return;
    }
    if (!this.sessionId) {
      throw new Error(`${this.constructor.name}: resume without a captured session id`);
    }

    const prompt = this.takeBufferedPrompt();
    this.log.info(`relaunching ${this.harnessName()} against its persisted session (resume)`, {
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
    this.resetParseState();

    const args = this.buildResumeArgs(prompt);
    await this.launch(args, { isResume: true });
  }
}
