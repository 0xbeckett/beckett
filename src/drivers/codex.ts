/**
 * Beckett — CodexDriver (`src/drivers/codex.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `codex exec` run as a one-shot worker (Spec 02 §5,
 * my-docs/codex-exec.md). One instance drives exactly one codex process inside one git
 * worktree, exposing the SAME interface as {@link ClaudeDriver} so the dispatcher can use
 * them interchangeably.
 *
 * Mechanism (verified against the installed `codex` CLI; my-docs/codex-exec.md §1–§2):
 *
 *   codex exec --json --skip-git-repo-check \
 *     -s <sandbox_mode> -C <worktree> -m <model> \
 *     [-c approval_policy=<policy>] [-c sandbox_workspace_write.network_access=true] \
 *     [--output-schema <done-schema>] "<prompt>"
 *
 * - cwd = the worktree (codex is rooted to its scope there); `-C` is also passed for the
 *   versions that honor it on the exec surface.
 * - With `--json`, stdout is a JSON Lines stream of *thread events* (`thread.started`,
 *   `turn.started/completed/failed`) and *item events* (`item.started/updated/completed`
 *   wrapping `command_execution` / `file_change` / `agent_message` / `reasoning` /
 *   `mcp_tool_call` / `web_search` / `todo_list` / item-level `error`). The parser is tolerant
 *   by contract (Spec 02 §7.2): unknown `type`s and unknown `item.type`s route to
 *   `kind:'unknown'`; a malformed line never throws.
 * - `codex exec` is STRICTLY ONE-SHOT (my-docs/codex-exec.md §2): prompt in → one turn →
 *   process exits. There is no mid-turn steer on the exec surface, so {@link sendNudge}
 *   *buffers* the instruction and reports `queued`; the buffered text is replayed as the
 *   prompt of the next {@link resume} via `codex exec resume --last "<instruction>"`, which
 *   carries the full prior transcript/plan/approvals (my-docs/codex-exec.md §2.1).
 * - session id = the `thread_id` from `thread.started` (codex does not accept a caller-minted
 *   id on exec — it is captured, not supplied). Surfaced as {@link SpawnResult} and a
 *   `session_started` event so the manager can persist it for `--resume`.
 * - abort() = SIGTERM→SIGKILL the process, retain the thread id (Spec 02 §4.5).
 * - A driver-owned wall-clock watchdog guarantees no run exceeds `envelope.wallClockS`
 *   (Spec 02 §9.3).
 *
 * Economics (Spec 00 §4): codex's JSONL carries token counts but NO dollar cost field, so
 * `usdEstimate` in {@link getTelemetry} is always `null` (per the {@link WorkerSpend}
 * contract). Auth (Spec 00 §4): subscription only — the child env has any `OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` stripped so `codex` always uses the `~/.codex` ChatGPT login.
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
import { hardCapSeconds, killProcessTree, wrapProcessGroup } from "./proc.ts";

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
type Child = ReturnType<typeof Bun.spawn>;

/** How long spawn() waits for the `thread.started` line before failing the launch. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long after SIGTERM we escalate to SIGKILL on abort (Spec 02 §4.5). */
const SIGKILL_GRACE_MS = 4_000;

/** Watchdog poll interval (Spec 02 §9.3). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** Env keys that must never reach a child — subscription auth only (Spec 00 §4). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** codex item `type`s that represent a tool invocation (counted once per item id). */
const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search"]);

/** Fallback instruction when resume() is asked to continue with no buffered nudge. */
const DEFAULT_RESUME_PROMPT = "Please continue from where you left off.";

/** A subset of the diff stat used for derived telemetry counters. */
interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

export class CodexDriver implements HarnessDriver {
  readonly kind = "codex-exec-oneshot" as const;

  private readonly config: Config;
  private readonly log: Logger;

  private child: Child | null = null;
  /** True when the child was launched as its own process-group leader (setsid) — enables tree-kill. */
  private groupKill = false;
  private spec: SpawnSpec | null = null;

  /** Source of truth for resume identity; captured from `thread.started` (not minted). */
  private sessionId: string | null = null;
  private pid: number | null = null;

  private workerState: WorkerState = "spawning";
  private finished = false;
  private spawnedAt = 0;
  private lastActivityTs = 0;
  /** Incremented per child process; an exit whose gen != current is a superseded child (ignored). */
  private childGen = 0;

  // ── normalized-stream parse state ────────────────────────────────────────────
  private readonly subscribers = new Set<(e: WorkerEvent) => void>();
  /** Item ids already counted as a tool call (dedup started/updated/completed). */
  private readonly seenToolIds = new Set<string>();
  /** The text of the most recent `agent_message` — the candidate structured done-signal. */
  private lastAgentMessage = "";

  // ── derived counters (Spec 02 §7.3) ──────────────────────────────────────────
  private turns = 0;
  private toolCalls = 0;
  private tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  private usd: number | null = null; // ALWAYS null for codex (no cost field; Spec 02 §2)

  // ── steering (exec is one-shot → every nudge is buffered for the next resume) ──
  private readonly bufferedNudges: string[] = [];

  // ── launch lifecycle plumbing ───────────────────────────────────────────────
  private threadStartedEmitted = false;
  private resolveSession: ((r: SpawnResult) => void) | null = null;
  private rejectSession: ((e: Error) => void) | null = null;
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readLoop: Promise<void> = Promise.resolve();

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child("driver.codex");
  }

  /** The current runtime lifecycle state (convenience for the WorkerManager). */
  get state(): WorkerState {
    return this.workerState;
  }

  /** The captured codex thread id, or null while still spawning. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /**
   * Launch the codex worker process and resolve once the `thread.started` line yields a
   * thread id (spawning→running). Rejects if the process dies, or never streams a thread,
   * before that point. The brief (`spec.prompt`, prefixed with `spec.systemAppend` since
   * exec has no system-prompt channel) is passed as the trailing CLI argument.
   */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("CodexDriver: already spawned (one driver = one process)");
    this.spec = spec;
    // codex exec does not accept a caller-minted id; it is captured from thread.started.
    this.sessionId = spec.sessionId ?? null;

    const args = this.buildSpawnArgs(this.composePrompt(spec));
    return this.launch(args, /*isResume*/ false);
  }

  // ===========================================================================
  // sendNudge
  // ===========================================================================

  /**
   * Steer the worker (Spec 02 §4.4). codex exec is one-shot — there is no mechanism to push a
   * message into an in-flight turn (my-docs/codex-exec.md §2) — so the instruction is ALWAYS
   * buffered and reported `queued`. It is replayed as the prompt of the next {@link resume}
   * (`codex exec resume --last "<instruction>"`), which restores the full prior context.
   */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    this.bufferedNudges.push(msg);
    this.log.info("nudge buffered for next resume (codex exec is one-shot)", {
      state: this.workerState,
      pending: this.bufferedNudges.length,
    });
    return { accepted: "queued", at: Date.now() };
  }

  // ===========================================================================
  // pause / resume / abort
  // ===========================================================================

  /**
   * Checkpoint without killing (Spec 02 §4.5; interface contract "codex: stop auto-resume").
   * The on-disk rollout JSONL + worktree git state are the durable checkpoint; nudges sent
   * while paused are buffered and flushed on resume.
   */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (auto-resume halted; thread retained)", {
      sessionId: this.sessionId,
    });
  }

  /**
   * Re-attach a paused/finished worker (Spec 02 §4.5). codex exec is one-shot, so a still-live
   * process means a turn is in flight: codex cannot be steered mid-turn, so resume() just lifts
   * the pause and leaves any buffered nudge to be applied after the turn ends. If the process
   * has exited, this relaunches with `codex exec resume --last "<buffered instruction>"`,
   * which replays the original transcript/plan/approvals and supplies the new instruction.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error("CodexDriver: resume before spawn");

    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.log.info("worker resumed (turn still in flight; nudge applies after it ends)", {
        pending: this.bufferedNudges.length,
      });
      return;
    }

    if (!this.sessionId) {
      // No thread id was ever captured → there is nothing to resume against.
      throw new Error("CodexDriver: resume without a captured thread id");
    }

    const prompt = this.takeBufferedPrompt();
    this.log.info("relaunching with `codex exec resume --last`", {
      sessionId: this.sessionId,
      promptLen: prompt.length,
    });

    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.threadStartedEmitted = false;
    this.seenToolIds.clear();
    this.lastAgentMessage = "";
    this.child = null;

    const args = this.buildResumeArgs(prompt);
    await this.launch(args, /*isResume*/ true);
  }

  /**
   * Hard stop (Spec 02 §4.5): SIGTERM, then SIGKILL after a short grace. The thread id is
   * retained so the supervisor can inspect the partial diff and optionally re-dispatch via
   * resume. Idempotent.
   */
  async abort(reason: string): Promise<void> {
    this.log.warn("aborting worker", { reason, sessionId: this.sessionId });
    this.setState("aborted");
    await this.killChild();
  }

  // ===========================================================================
  // onEvent / getTelemetry
  // ===========================================================================

  /** Subscribe to the normalized event stream; returns an unsubscribe fn (Spec 02 §3). */
  onEvent(cb: (e: WorkerEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Snapshot of derived counters (Spec 02 §7.3). Cheap: reads in-memory accumulators and
   * shells `git diff --numstat` (+ staged) in the worktree for the ground-truth diff size.
   * `usdEstimate` is always `null` — codex's JSONL has no cost field (Spec 02 §2).
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

  private async launch(args: string[], isResume: boolean): Promise<SpawnResult> {
    const spec = this.spec!;
    const bin = this.config.harness.codex.bin;
    this.setState("spawning");
    this.spawnedAt = this.spawnedAt || Date.now();
    this.lastActivityTs = Date.now();

    const sessionReady = new Promise<SpawnResult>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });

    this.log.info("spawning codex worker", {
      bin,
      workspace: spec.workspace,
      model: this.resolvedModel(),
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
        // codex exec blocks on stdin even when the prompt is an argument (loom-desk Risk note):
        // closing stdin (≈ `</dev/null`) gives it an immediate EOF so it proceeds.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: this.childEnv(),
      });
    } catch (err) {
      const e = new Error(`CodexDriver: failed to spawn ${bin} — ${(err as Error).message}`);
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;
    const gen = ++this.childGen;

    // Fail the launch if the thread never starts.
    this.spawnTimer = setTimeout(() => {
      this.rejectSession?.(
        new Error(`CodexDriver: no thread.started within ${SPAWN_TIMEOUT_MS}ms`),
      );
    }, SPAWN_TIMEOUT_MS);

    // Consume stdout (and drain stderr) without blocking the daemon.
    this.readLoop = this.consumeStdout(child).catch((err) => {
      this.log.error("stdout read loop crashed", { err: String(err) });
    });
    void this.drainStderr(child);

    // Watch for process exit (covers crashes that never emit a terminal turn line). The gen guard
    // means a child superseded by an auto-resume can't fire a spurious error-finish.
    void child.exited.then((code) => this.onProcessExit(code, gen));

    // Arm the wall-clock watchdog once (survives resumes).
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }

    return sessionReady;
  }

  private resolvedModel(): string {
    return this.spec?.model || this.config.harness.codex.default_model;
  }

  /**
   * codex exec has no system-prompt channel, so the businesslike `systemAppend` (scope +
   * criteria) is folded into the head of the prompt argument with a separator.
   */
  private composePrompt(spec: SpawnSpec): string {
    const sys = spec.systemAppend?.trim();
    return sys ? `${sys}\n\n---\n\n${spec.prompt}` : spec.prompt;
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
    return env;
  }

  private buildSpawnArgs(prompt: string): string[] {
    const spec = this.spec!;
    const codex = this.config.harness.codex;
    const args: string[] = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      codex.sandbox_mode,
      "-C",
      spec.workspace,
      // `-m` only when a model is explicitly cast; otherwise defer to codex's own config
      // (`~/.codex/config.toml`), which is authed for the account's supported models.
      ...this.modelFlag(),
      ...this.configOverrides(),
    ];
    if (spec.doneSchemaPath) args.push("--output-schema", spec.doneSchemaPath);
    args.push(prompt);
    return args;
  }

  /** `["-m", model]` only when a model was explicitly cast; else `[]` (use codex's default). */
  private modelFlag(): string[] {
    const m = this.resolvedModel().trim();
    return m ? ["-m", m] : [];
  }

  private buildResumeArgs(prompt: string): string[] {
    const spec = this.spec!;
    const codex = this.config.harness.codex;
    // `codex exec resume` does not accept `-s`/`-C`: the sandbox is supplied as a config
    // override and the worktree comes from the child's cwd (set in launch()).
    const args: string[] = [
      "exec",
      "resume",
      "--last",
      "--json",
      "--skip-git-repo-check",
      ...this.modelFlag(),
      "-c",
      `sandbox_mode=${codex.sandbox_mode}`,
      ...this.configOverrides(),
    ];
    if (spec.doneSchemaPath) args.push("--output-schema", spec.doneSchemaPath);
    args.push(prompt);
    return args;
  }

  /** Config-override (`-c key=value`) flags shared by spawn + resume (approvals + network). */
  private configOverrides(): string[] {
    const codex = this.config.harness.codex;
    const ov: string[] = ["-c", `approval_policy=${codex.approval_policy}`];
    const network = (this.spec?.envelope.network ?? false) || codex.network_default;
    if (network) ov.push("-c", "sandbox_workspace_write.network_access=true");
    return ov;
  }

  private async onProcessExit(code: number, gen: number): Promise<void> {
    // A child we've already moved past (e.g. replaced by an auto-resume) — its exit is not ours.
    if (gen !== this.childGen) return;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // Drain any final buffered stdout lines before deciding — codex flushes the terminal
    // turn line just before exit, and exec is one-shot so that line is the success signal.
    await this.readLoop;

    // If the launch promise is still pending, the process died before the thread started.
    if (this.resolveSession && !this.threadStartedEmitted) {
      this.rejectSession?.(
        new Error(`CodexDriver: process exited (code ${code}) before thread.started`),
      );
      this.resolveSession = null;
      this.rejectSession = null;
    }
    // If it exited without a terminal turn line, synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      this.emit({ kind: "error", message: `codex process exited (code ${code})`, ts });
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
        if (text) this.log.debug("codex stderr", { text });
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by
   * contract (Spec 02 §7.2; my-docs/codex-exec.md §1.6): a malformed line, an unknown `type`,
   * or an unknown `item.type` becomes a `kind:'unknown'` event — never a throw.
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
        case "thread.started":
          this.handleThreadStarted(obj);
          break;
        case "turn.started":
          this.handleTurnStarted();
          break;
        case "turn.completed":
          this.handleTurnCompleted(obj);
          break;
        case "turn.failed":
          this.handleTurnFailed(obj);
          break;
        case "item.started":
          this.handleItem("started", obj.item);
          break;
        case "item.updated":
          this.handleItem("updated", obj.item);
          break;
        case "item.completed":
          this.handleItem("completed", obj.item);
          break;
        case "error":
          this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
          break;
        default:
          this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
      }
    } catch (err) {
      // A surprising-but-parseable line must never take down the loop (Spec 02 §7.2).
      this.log.warn("event normalization error (routed to unknown)", { err: String(err) });
      this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleThreadStarted(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const tid = this.str(obj.thread_id) ?? this.sessionId;
    if (tid) this.sessionId = tid;
    this.threadStartedEmitted = true;
    this.emit({
      kind: "session_started",
      sessionId: this.sessionId ?? "",
      model: this.resolvedModel(),
      ts,
    });

    // The launch is confirmed running once the thread starts.
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    this.setState("running");
    this.resolveSession?.({ sessionId: this.sessionId ?? "", pid: this.pid ?? -1 });
    this.resolveSession = null;
    this.rejectSession = null;
  }

  private handleTurnStarted(): void {
    this.turns += 1;
    this.emit({ kind: "turn_started", ts: Date.now() });
  }

  private handleTurnCompleted(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const usage = this.mapUsage(obj.usage);
    if (usage) {
      this.addTokens(usage);
      this.emit({ kind: "turn_completed", usage, ts });
    }

    // Steering that arrived during this one-shot turn couldn't interrupt it; apply it now by
    // resuming with the buffered instruction(s) rather than finishing. The child-gen guard keeps
    // this turn's imminent process exit from firing a spurious error-finish.
    if (this.bufferedNudges.length > 0 && this.workerState !== "aborted") {
      this.log.info("turn completed with buffered steering — auto-resuming to apply it", {
        pending: this.bufferedNudges.length,
      });
      this.finished = true; // this turn's process is done; resume() will relaunch
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

    // exec is one-shot: a completed turn (with no pending steering) IS success (Spec 02 §5).
    this.emit({
      kind: "finished",
      status: "success",
      subtype: "success",
      structuredOutput: this.parseStructuredOutput(),
      usage: { ...this.tokens },
      ts,
    });
    this.finished = true;
    this.stopWatchdog(); // success sets the non-terminal "review" state, so clear the timer here
    if (!this.isTerminal()) this.setState("review"); // success → handed to GATE (Spec 11)
  }

  /** Clear the wall-clock watchdog interval (idempotent). */
  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private handleTurnFailed(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const error = obj.error as Record<string, unknown> | undefined;
    const message = this.str(error?.message) ?? "turn failed";
    this.emit({ kind: "error", message, ts });
    this.emit({
      kind: "finished",
      status: "error",
      subtype: "error_turn_failed",
      structuredOutput: null,
      usage: { ...this.tokens },
      ts,
    });
    this.finished = true;
    if (!this.isTerminal()) this.setState("failed");
  }

  /**
   * Normalize one `item.*` event. Items wrap a discrete unit of work; the same item id is seen
   * across started→updated→completed, so tool calls are counted once per id.
   */
  private handleItem(phase: "started" | "updated" | "completed", rawItem: unknown): void {
    const ts = Date.now();
    if (!rawItem || typeof rawItem !== "object") {
      this.emit({ kind: "unknown", raw: rawItem, ts });
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const itemType = this.str(item.type) ?? "unknown";
    const id = this.str(item.id) ?? "";

    switch (itemType) {
      case "agent_message": {
        const text = this.str(item.text) ?? "";
        if (text) this.lastAgentMessage = text;
        // codex emits the final message as item.completed; partial only on a non-completed phase.
        this.emit({ kind: "assistant_text", text, partial: phase !== "completed", ts });
        return;
      }
      case "command_execution":
      case "mcp_tool_call":
      case "web_search": {
        this.handleToolItem(phase, itemType, id, item, ts);
        return;
      }
      case "file_change": {
        if (phase === "completed") this.emitFileChange(item, ts);
        return;
      }
      case "todo_list": {
        this.emitPlanUpdate(item, ts);
        return;
      }
      case "error": {
        this.emit({ kind: "error", message: this.str(item.message) ?? "item error", ts });
        return;
      }
      // reasoning + any future item type: tolerated, surfaced as unknown (Spec 02 §7.2).
      default:
        this.emit({ kind: "unknown", raw: item, ts });
    }
  }

  private handleToolItem(
    phase: "started" | "updated" | "completed",
    itemType: string,
    id: string,
    item: Record<string, unknown>,
    ts: number,
  ): void {
    // Count + emit the tool_call exactly once per item id (first sighting).
    if (!TOOL_ITEM_TYPES.has(itemType)) return;
    const key = id || `${itemType}:${this.toolCalls}`;
    if (!this.seenToolIds.has(key)) {
      this.seenToolIds.add(key);
      this.toolCalls += 1;
      this.emit({ kind: "tool_call", tool: this.toolName(itemType, item), input: item, toolId: id, ts });
    }
    if (phase === "completed") {
      this.emit({ kind: "tool_result", toolId: id, isError: this.toolItemErrored(itemType, item), ts });
    }
  }

  private toolName(itemType: string, item: Record<string, unknown>): string {
    if (itemType === "mcp_tool_call") {
      const server = this.str(item.server) ?? "mcp";
      const tool = this.str(item.tool) ?? "tool";
      return `${server}.${tool}`;
    }
    if (itemType === "web_search") return "web_search";
    // command_execution
    return this.str(item.command) ?? "shell";
  }

  private toolItemErrored(itemType: string, item: Record<string, unknown>): boolean {
    if (this.str(item.status) === "failed") return true;
    if (itemType === "command_execution") {
      return typeof item.exit_code === "number" && item.exit_code !== 0;
    }
    if (itemType === "mcp_tool_call") {
      return item.error != null;
    }
    return false;
  }

  private emitFileChange(item: Record<string, unknown>, ts: number): void {
    const raw = Array.isArray(item.changes) ? item.changes : [];
    const paths: { path: string; kind: "add" | "update" | "delete" }[] = [];
    for (const c of raw) {
      const change = c as Record<string, unknown>;
      const path = this.str(change.path);
      if (!path) continue;
      const k = this.str(change.kind);
      const kind = k === "add" || k === "delete" ? k : "update";
      paths.push({ path, kind });
    }
    if (paths.length > 0) this.emit({ kind: "file_change", paths, ts });
  }

  private emitPlanUpdate(item: Record<string, unknown>, ts: number): void {
    const raw = Array.isArray(item.items) ? item.items : [];
    const items = raw.map((t) => {
      const entry = t as Record<string, unknown>;
      return { text: this.str(entry.text) ?? "", done: entry.completed === true };
    });
    this.emit({ kind: "plan_update", items, ts });
  }

  // ===========================================================================
  // internal — helpers
  // ===========================================================================

  /** The buffered steering instruction(s) to drive the next resume; cleared on take. */
  private takeBufferedPrompt(): string {
    if (this.bufferedNudges.length === 0) return DEFAULT_RESUME_PROMPT;
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    return pending.join("\n\n");
  }

  /** Best-effort parse of the final agent_message as the structured done-signal JSON. */
  private parseStructuredOutput(): unknown | null {
    const text = this.lastAgentMessage.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
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

  /** Map codex `turn.completed.usage` → the shared {@link TokenUsage} shape (Spec 02 §7.3). */
  private mapUsage(raw: unknown): TokenUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const u = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const usage: TokenUsage = {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cached_input_tokens),
      cacheCreate: 0, // codex has no cache-creation token field (my-docs/codex-exec.md §1.5)
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
