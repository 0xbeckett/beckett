/**
 * Beckett — PiDriver (`src/drivers/pi.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for the `pi` CLI (pi.dev / earendil-works) run as a
 * one-shot worker, exposing the SAME interface as {@link ClaudeDriver} / {@link CodexDriver}
 * so the dispatcher can cast any of the three interchangeably. pi is Beckett's malleable,
 * provider-agnostic coding agent; its default provider is the ChatGPT/Codex OAuth login
 * (`openai-codex`) driving gpt-5.5.
 *
 * Mechanism (verified against the installed `pi` 0.80.3, `--mode json` NDJSON stream):
 *
 *   # first launch — pi mints + persists its OWN session id (we capture it from the
 *   # `session` line); NO `--session-id` is passed (see the version-drift note below):
 *   pi -p --mode json --no-extensions --no-skills --no-themes \
 *      --provider <p> --model <m> --thinking <lvl> \
 *      --append-system-prompt "<systemAppend>" "<prompt>"
 *
 *   # resume — replay the persisted transcript by id (same cwd → pi finds it):
 *   pi -p --mode json --no-extensions --no-skills --no-themes \
 *      --provider <p> --model <m> --thinking <lvl> --session <id> "<prompt>"
 *
 * - cwd = the worktree (pi is rooted to its process cwd — there is no `-C`), set on spawn.
 * - `--mode json` emits a JSON Lines stream. The events we normalize (Spec 02 §7):
 *     `session`               → the session id (FIRST line)     → session_started + resolves spawn
 *     `turn_start`            → a model turn began              → turn_started
 *     `tool_execution_start`  → a tool is running (name+args)   → tool_call
 *     `tool_execution_end`    → a tool finished (isError)       → tool_result (+ file_change for edits)
 *     `message_end`(assistant)→ a completed assistant message   → assistant_text (+ provider-error check)
 *     `turn_end`              → a model turn ended (usage/cost)  → turn_completed
 *     `agent_end`             → the run is complete             → finished
 *   The parser is tolerant by contract (Spec 02 §7.2): a malformed line or unknown `type`
 *   routes to `kind:'unknown'`; high-frequency streaming chatter (`message_update`, …) is
 *   explicitly ignored so it doesn't flood the bus.
 *
 * ── OPS-56 root cause & the two hardening fixes this driver bakes in ──────────────────────
 *
 * (1) VERSION/PROTOCOL DRIFT → "process exited (code 1) before session line". The original
 *     outage: the driver minted a session id and passed `--session-id <uuid>` on the first
 *     launch. pi's session CLI has drifted repeatedly — a build (0.72.x) had NO `--session-id`
 *     flag (it resumes only an EXISTING session via `--session <id|path>`), so every fresh
 *     dispatch died with `Error: Unknown option: --session-id` → exit 1 BEFORE the `session`
 *     line. The driver's spawn(), waiting for that line, only saw the process die first and
 *     reported the opaque "exited before session line", silently killing the ticket.
 *     FIX — version-agnostic sessions: we NEVER pass `--session-id`. pi mints its own id on the
 *     first launch; we capture it from the `session` line as the source of truth and replay it
 *     via `--session <id>` on resume. `--session` exists in every pi build; `--session-id` does
 *     not — so a version rollback can never crash the child before its handshake again. The
 *     {@link piPreflight} also asserts the flags we DO emit are still advertised, so any future
 *     drift surfaces loudly at dispatch instead of as a dead child.
 *
 * (2) SILENT PROVIDER DEATH → a quota-exhausted / auth-broken / provider-down harness. When the
 *     provider is dead, pi still emits a clean `session` line, then an assistant turn that ends
 *     with `stopReason:"error"` + `errorMessage` (e.g. "Codex error: The usage limit has been
 *     reached"), then a normal `agent_end`, and exits 0. Treating `agent_end` as unconditional
 *     success would mask a dead provider as a "successful" empty worker.
 *     FIX — loud provider errors: we track the last assistant turn's provider error and, on
 *     `agent_end`, emit `finished status:"error"` (subtype `error_provider`) with the cause
 *     surfaced, so a dead provider fails LOUDLY instead of silently completing with no work.
 *
 * - sendNudge = pi -p is one-shot (no mid-turn steer), so a nudge is BUFFERED and replayed as
 *   the prompt of the next {@link resume} (`pi --session <id> "<instruction>"`). An `agent_end`
 *   with buffered steering auto-resumes to apply it rather than finishing (mirrors codex).
 * - abort() = SIGTERM→SIGKILL the process, retain the session id (Spec 02 §4.5).
 * - A driver-owned wall-clock watchdog guarantees no run exceeds `envelope.wallClockS`.
 *
 * Economics (Spec 00 §4): pi's JSONL carries a REAL per-turn dollar cost (`usage.cost.total`),
 * so `usdEstimate` in {@link getTelemetry} is the accumulated actual spend. Auth (Spec 00 §4):
 * subscription/OAuth only — the child env has any `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
 * stripped so pi always uses the `~/.pi/agent/auth.json` login.
 */

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

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
type Child = ReturnType<typeof Bun.spawn>;

/** How long spawn() waits for the `session` line before failing the launch. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long after SIGTERM we escalate to SIGKILL on abort (Spec 02 §4.5). */
const SIGKILL_GRACE_MS = 4_000;

/** Watchdog poll interval (Spec 02 §9.3). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** How long a preflight `pi --version` / `--help` probe may run before giving up. */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/** How long the OPTIONAL live probe (a real trivial turn) may run before giving up. */
const LIVE_PROBE_TIMEOUT_MS = 45_000;

/** pi needs a modern node to run; the daemon PATH must resolve at least this. */
const MIN_NODE_VERSION = "20.0.0";

/** Env keys that must never reach a child — subscription/OAuth auth only (Spec 00 §4). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * CLI flags the driver's invocation depends on. Their absence from `pi --help` signals the
 * exact version/protocol drift that took pi down (OPS-56). NOTE `--session-id` is DELIBERATELY
 * absent from this list — the driver never emits it, precisely so a build that lacks it does not
 * crash the child before its session line.
 */
const REQUIRED_PI_FLAGS = [
  "--mode",
  "--session",
  "--print",
  "--provider",
  "--thinking",
  "--append-system-prompt",
  "--no-extensions",
  "--no-skills",
  "--no-themes",
] as const;

/** pi tool names that mutate files → we synthesize a file_change from their args' path. */
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch"]);

/** Fallback instruction when resume() is asked to continue with no buffered nudge. */
const DEFAULT_RESUME_PROMPT = "Please continue from where you left off.";

/** The trivial prompt the live probe sends — cheap, and its answer is irrelevant. */
const LIVE_PROBE_PROMPT = "Reply with the single word: ok";

/** A subset of the diff stat used for derived telemetry counters. */
interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

// =======================================================================================
// Shared, process-free helpers (unit-tested against verbatim real pi output; OPS-56)
// =======================================================================================

/**
 * The PATH a pi child runs under: prefix `~/.local/bin` & `~/.bun/bin` so `pi` both RESOLVES
 * and RUNS under the modern node installed there (pi needs node ≥20; the system node may be
 * older). Shared by the live child env and {@link piPreflight} so preflight tests the SAME
 * binary a spawn would.
 */
export function piChildPath(base = process.env.PATH): string {
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  return base ? `${extra}:${base}` : extra;
}

/**
 * Extract a pi assistant message's provider-error text IFF the turn failed
 * (`stopReason:"error"`). The single source of truth for "did the model actually fail" — shared
 * by the driver's runtime path and the preflight live probe so a quota-exhausted / auth-broken /
 * provider-down turn is recognized identically in both (OPS-56 fix #2).
 */
export function providerErrorOf(message: Record<string, unknown> | undefined | null): string | null {
  if (!message || typeof message !== "object") return null;
  if (message.stopReason !== "error") return null;
  const msg = message.errorMessage;
  return typeof msg === "string" && msg.trim() ? msg.trim() : "provider error (no message)";
}

/**
 * Scan a pi `--mode json` NDJSON stdout for the two facts the live probe needs: did pi emit its
 * `session` handshake (the harness STARTED), and did any assistant turn end in a provider error
 * (the harness is started-but-dead). Pure over a captured string so it's unit-testable without
 * spawning a process (OPS-56).
 */
export function scanProbeOutput(stdout: string): { sessionSeen: boolean; providerError: string | null } {
  let sessionSeen = false;
  let providerError: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "session") sessionSeen = true;
    if (obj.type === "error" && typeof obj.message === "string") providerError ??= obj.message;
    if (obj.type === "message_end" || obj.type === "turn_end") {
      providerError ??= providerErrorOf(obj.message as Record<string, unknown> | undefined);
    }
  }
  return { sessionSeen, providerError };
}

/** Compare dotted numeric versions: is `a` >= `b`? Tolerates a leading `v` and extra segments. */
export function semverGte(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const parse = (s: string) =>
    s.replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

// =======================================================================================
// Preflight
// =======================================================================================

/** The verdict of a {@link piPreflight} run: is the pi harness usable, and if not, why. */
export interface PiPreflight {
  ok: boolean;
  bin: string;
  nodeVersion: string | null;
  version: string | null;
  /** Human-readable reasons the harness is unusable; empty ⟺ `ok`. */
  problems: string[];
  /** True when a live probe actually ran a turn (only when `preflight_live_probe` is on). */
  liveProbed: boolean;
}

/**
 * Fast health check for the pi harness — run at dispatch so a broken pi surfaces LOUDLY and
 * immediately instead of silently killing whatever ticket happened to be cast to it (OPS-56).
 * Cheap local probes (no network unless the live probe is enabled):
 *   1. a modern node resolves on the child PATH (`node --version` ≥ 20; pi's runtime needs it);
 *   2. the binary resolves and reports a version (`pi --version`);
 *   3. the CLI still advertises every flag the driver emits (`pi --help`) — catches the exact
 *      version/protocol drift that took pi down, WITHOUT depending on `--session-id`;
 *   4. a pi login exists (`~/.pi/agent/auth.json`, non-empty) — subscription/OAuth auth present.
 * When `config.harness.pi.preflight_live_probe` is on, a fifth check runs a trivial real turn and
 * fails if pi never emits its session line, or if the provider turn errors (dead quota/login) —
 * catching a started-but-dead harness the offline checks can't see.
 */
export async function piPreflight(config: Config): Promise<PiPreflight> {
  const pi = config.harness.pi;
  const bin = pi.bin;
  const problems: string[] = [];
  const env = childEnv();

  // 1 — a modern node resolves on the child PATH (pi's runtime needs node ≥20).
  let nodeVersion: string | null = null;
  try {
    const n = Bun.spawnSync({ cmd: ["node", "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    nodeVersion = firstLine(`${n.stdout.toString()}\n${n.stderr.toString()}`);
    if (!n.success || !semverGte(nodeVersion, MIN_NODE_VERSION)) {
      problems.push(
        `the pi child PATH resolves node ${nodeVersion ?? "unknown"}; pi needs node >=${MIN_NODE_VERSION}. ` +
          `Put a modern node (e.g. ~/.local/bin) before /usr/bin.`,
      );
    }
  } catch (err) {
    problems.push(`could not run node from the pi child PATH (${(err as Error).message}).`);
  }

  // 2 — binary resolves + reports a version.
  let version: string | null = null;
  try {
    const v = Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    if (v.success) {
      version = firstLine(`${v.stdout.toString()}\n${v.stderr.toString()}`);
    } else {
      problems.push(`\`${bin} --version\` exited ${v.exitCode}: ${v.stderr.toString().trim() || "(no output)"}`);
    }
  } catch (err) {
    problems.push(
      `pi binary "${bin}" is not runnable on PATH (${(err as Error).message}). ` +
        `Install pi or fix config.harness.pi.bin.`,
    );
  }

  // 3 — CLI/protocol drift: confirm every flag the driver emits still exists.
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
    /* a --help failure is already implied by the --version failure in (2). */
  }

  // 4 — pi login present (subscription/OAuth; the child strips API keys and relies on this).
  const authPath = join(process.env.HOME ?? "", ".pi/agent/auth.json");
  try {
    const f = Bun.file(authPath);
    if (!(await f.exists()) || f.size === 0) {
      problems.push(`no pi login at ${authPath} — run \`pi\` once to sign in (subscription/OAuth).`);
    }
  } catch (err) {
    problems.push(`could not read pi login at ${authPath} (${(err as Error).message}).`);
  }

  // 5 — OPTIONAL live probe: only when the offline checks passed and the operator opted in. A
  //     trivial real turn is the only way to catch a started-but-dead harness (dead quota/login).
  let liveProbed = false;
  if (pi.preflight_live_probe && problems.length === 0) {
    liveProbed = true;
    const live = await runLiveProbe(bin, pi, env);
    if (live) problems.push(live);
  }

  return { ok: problems.length === 0, bin, nodeVersion, version, problems, liveProbed };
}

/** Run one trivial `pi -p --mode json` turn in a temp cwd; return a problem string or null. */
async function runLiveProbe(bin: string, pi: Config["harness"]["pi"], env: Record<string, string | undefined>): Promise<string | null> {
  const args = [
    "-p", "--mode", "json", "--no-extensions", "--no-skills", "--no-themes",
    "--no-session", "--provider", pi.default_provider,
  ];
  if (pi.default_model) args.push("--model", pi.default_model);
  args.push("--thinking", "low", LIVE_PROBE_PROMPT);
  try {
    const r = Bun.spawnSync({
      cmd: [bin, ...args],
      cwd: process.env.HOME || "/tmp",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
      timeout: LIVE_PROBE_TIMEOUT_MS,
    });
    const out = `${r.stdout.toString()}`;
    const { sessionSeen, providerError } = scanProbeOutput(out);
    if (!sessionSeen) {
      const tail = r.stderr.toString().trim().slice(-400);
      return `live probe: pi never emitted its session handshake (exit ${r.exitCode})${tail ? ` — ${tail}` : ""}.`;
    }
    if (providerError) {
      return `live probe: pi started but the provider turn FAILED — ${providerError} ` +
        `(check the ${pi.default_provider} login / quota in ~/.pi/agent/auth.json).`;
    }
    return null;
  } catch (err) {
    return `live probe could not run (${(err as Error).message}).`;
  }
}

/** First non-empty trimmed line of a blob (pi prints its version across std streams). */
function firstLine(blob: string): string | null {
  return blob.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
}

/** The child env: strip API keys (subscription auth only) + pin the modern-node PATH. */
function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: piChildPath(), ...overrides };
  for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
  return env;
}

// =======================================================================================
// PiDriver
// =======================================================================================

export class PiDriver implements HarnessDriver {
  readonly kind = "pi-cli-oneshot" as const;

  private readonly config: Config;
  private readonly log: Logger;

  private child: Child | null = null;
  private spec: SpawnSpec | null = null;

  /** Source of truth for resume identity; captured from the `session` line (pi mints it). */
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
  /** toolCallId → toolName (dedup + name lookup on tool_execution_end). */
  private readonly toolNames = new Map<string, string>();
  /** toolCallId → args captured on start (pi carries edit paths there, not on end). */
  private readonly toolArgs = new Map<string, unknown>();
  /** The text of the most recent completed assistant message — candidate done-signal. */
  private lastAgentMessage = "";
  /** The provider error of the last assistant turn, or null if it succeeded (OPS-56 fix #2). */
  private lastProviderError: string | null = null;

  // ── derived counters (Spec 02 §7.3) ──────────────────────────────────────────
  private turns = 0;
  private toolCalls = 0;
  private tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  private usd: number | null = null; // accumulated real cost (pi reports usage.cost.total)

  // ── steering (pi -p is one-shot → every nudge is buffered for the next resume) ──
  private readonly bufferedNudges: string[] = [];

  // ── launch lifecycle plumbing ───────────────────────────────────────────────
  private sessionEmitted = false;
  private resolveSession: ((r: SpawnResult) => void) | null = null;
  private rejectSession: ((e: Error) => void) | null = null;
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readLoop: Promise<void> = Promise.resolve();
  /** Ring buffer of the last chunk of child stderr — folded into a startup failure message. */
  private stderrTail = "";

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child("driver.pi");
  }

  /** The current runtime lifecycle state (convenience for the WorkerManager). */
  get state(): WorkerState {
    return this.workerState;
  }

  /** The captured pi session id, or null while still spawning. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /**
   * Launch the pi worker and resolve once the `session` line yields a session id
   * (spawning→running). Rejects if the process dies, or never streams a session, before that
   * point — with the captured stderr tail folded in so the REAL cause (e.g. an unknown flag) is
   * visible instead of the opaque bare "exited before session line" (OPS-56).
   *
   * A fast {@link piPreflight} runs FIRST so a broken pi surfaces loudly and immediately rather
   * than silently killing the ticket.
   */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("PiDriver: already spawned (one driver = one process)");
    this.spec = spec;

    const pf = await piPreflight(this.config);
    if (!pf.ok) {
      this.log.error("pi preflight FAILED — harness unusable", { bin: pf.bin, version: pf.version, problems: pf.problems });
      this.setState("failed");
      throw new Error(`PiDriver preflight failed (pi harness unusable): ${pf.problems.join("; ")}`);
    }
    this.log.info("pi preflight ok", { bin: pf.bin, nodeVersion: pf.nodeVersion, version: pf.version, liveProbed: pf.liveProbed });

    // Crash recovery: a caller-persisted session id relaunches `--session <id>` so pi reuses the
    // persisted transcript instead of re-paying the whole ticket's exploration cost. Otherwise pi
    // mints its own id, which we capture from the `session` line. We NEVER pass `--session-id`.
    const resumeId = spec.sessionId?.trim() || null;
    this.sessionId = resumeId;
    // pi takes the prompt as its trailing arg; the scope+criteria+persona go via
    // `--append-system-prompt` (first launch only — see buildArgs).
    const args = this.buildArgs(spec.prompt, /*isResume*/ Boolean(resumeId));
    return this.launch(args, /*isResume*/ Boolean(resumeId));
  }

  // ===========================================================================
  // sendNudge
  // ===========================================================================

  /**
   * Steer the worker (Spec 02 §4.4). pi -p is one-shot — no mechanism to push a message into an
   * in-flight turn — so the instruction is ALWAYS buffered and reported `queued`. It is replayed
   * as the prompt of the next {@link resume} (`pi --session <id> "<instruction>"`).
   */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    this.bufferedNudges.push(msg);
    this.log.info("nudge buffered for next resume (pi -p is one-shot)", {
      state: this.workerState,
      pending: this.bufferedNudges.length,
    });
    return { accepted: "queued", at: Date.now() };
  }

  // ===========================================================================
  // pause / resume / abort
  // ===========================================================================

  /** Checkpoint without killing (Spec 02 §4.5). The persisted session + worktree git state are
   * the durable checkpoint; nudges sent while paused are buffered and flushed on resume. */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (auto-resume halted; session retained)", { sessionId: this.sessionId });
  }

  /**
   * Re-attach a paused/finished worker (Spec 02 §4.5). pi -p is one-shot, so a still-live process
   * means a turn is in flight (can't steer mid-turn → resume() just lifts the pause). If the
   * process has exited, this relaunches with `pi --session <id> "<buffered instruction>"`, which
   * replays the persisted transcript and supplies the new instruction.
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

    if (!this.sessionId) {
      throw new Error("PiDriver: resume without a captured session id");
    }

    const prompt = this.takeBufferedPrompt();
    this.log.info("relaunching with `pi --session <id>`", { sessionId: this.sessionId, promptLen: prompt.length });

    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.sessionEmitted = false;
    this.lastProviderError = null;
    this.toolNames.clear();
    this.toolArgs.clear();
    this.lastAgentMessage = "";
    this.stderrTail = "";
    this.child = null;

    const args = this.buildArgs(prompt, /*isResume*/ true);
    await this.launch(args, /*isResume*/ true);
  }

  /** Hard stop (Spec 02 §4.5): SIGTERM, then SIGKILL after a short grace. Session id retained. */
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
   * Snapshot of derived counters (Spec 02 §7.3). Cheap: reads in-memory accumulators and shells
   * `git diff --numstat` (+ staged) in the worktree. `usdEstimate` is the accumulated real cost
   * pi reports per turn (`usage.cost.total`).
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
      model: this.resolvedModel(),
      thinking: this.resolvedThinking(),
      isResume,
      sessionId: this.sessionId,
    });

    let child: Child;
    try {
      child = Bun.spawn({
        cmd: [bin, ...args],
        cwd: spec.workspace,
        // pi -p reads its prompt from argv; close stdin so it never blocks awaiting input.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv(),
      });
    } catch (err) {
      const e = new Error(`PiDriver: failed to spawn ${bin} — ${(err as Error).message}`);
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;
    const gen = ++this.childGen;

    // Fail the launch if the session never starts.
    this.spawnTimer = setTimeout(() => {
      this.rejectSession?.(new Error(`PiDriver: no session line within ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    this.readLoop = this.consumeStdout(child).catch((err) => {
      this.log.error("stdout read loop crashed", { err: String(err) });
    });
    void this.drainStderr(child);

    void child.exited.then((code) => this.onProcessExit(code, gen));

    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }

    return sessionReady;
  }

  private resolvedModel(): string {
    return (this.spec?.model || this.config.harness.pi.default_model || "").trim();
  }

  /** pi `--thinking` reuses the resource envelope's effort (same low|medium|high|xhigh vocab). */
  private resolvedThinking(): string {
    return this.spec?.envelope.effort || this.config.harness.pi.default_effort;
  }

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
    // Version-agnostic sessions (OPS-56 fix #1): NEVER `--session-id`. On first launch we pass no
    // session flag → pi mints + persists its own id (captured from the `session` line). On resume
    // we replay it via `--session <id>` — the one selector present in EVERY pi build.
    if (isResume && this.sessionId) {
      args.push("--session", this.sessionId);
    }
    // System prompt (scope + criteria + persona) only on the FIRST launch — the persisted session
    // already carries it on resume, and re-appending would duplicate it.
    if (!isResume && this.spec?.systemAppend?.trim()) {
      args.push("--append-system-prompt", this.spec.systemAppend.trim());
    }
    args.push(prompt);
    return args;
  }

  private async onProcessExit(code: number | null, gen: number): Promise<void> {
    // A child we've already moved past (e.g. replaced by an auto-resume) — its exit is not ours.
    if (gen !== this.childGen) return;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // Drain the final buffered stdout lines before deciding — pi flushes agent_end just before exit.
    await this.readLoop;

    // Launch still pending → the process died before the session line. Fold in the captured
    // stderr tail so the REAL cause (e.g. `Error: Unknown option: --session-id`) is visible
    // instead of the opaque bare message (OPS-56).
    if (this.resolveSession && !this.sessionEmitted) {
      const tail = this.stderrTail.trim();
      const detail = tail ? ` — pi stderr: ${tail.slice(-600)}` : "";
      this.rejectSession?.(
        new Error(
          `PiDriver: pi process exited (code ${code}) before its session line${detail}. ` +
            `Likely a bad config.harness.pi.bin, a missing/expired pi login (~/.pi/agent/auth.json), ` +
            `or pi CLI/protocol drift. Run the pi preflight (\`beckett doctor pi\`).`,
        ),
      );
      this.resolveSession = null;
      this.rejectSession = null;
    }

    // Exited without a terminal event → synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      this.emit({ kind: "error", message: `pi process exited (code ${code})`, ts });
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
    const totalS = (Date.now() - this.spawnedAt) / 1000;
    if (totalS > this.spec.envelope.wallClockS) {
      this.log.warn("wall-clock cap exceeded — aborting", {
        wallClockS: this.spec.envelope.wallClockS,
        totalS: Math.round(totalS),
      });
      void this.abort(`wall-clock cap ${this.spec.envelope.wallClockS}s exceeded`);
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const killed = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), SIGKILL_GRACE_MS)),
    ]);
    if (!killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.exited;
    }
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
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          // Keep the last ~2KB so a startup failure can surface the real cause (OPS-56).
          this.stderrTail = (this.stderrTail + text).slice(-2048);
          this.log.debug("pi stderr", { text: text.trim() });
        }
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by contract
   * (Spec 02 §7.2): a malformed line or unknown `type` becomes `kind:'unknown'` — never a throw.
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
        // High-frequency streaming / lifecycle chatter we deliberately DON'T surface (the
        // per-token `message_update` alone fires hundreds of times a turn). Explicitly ignored —
        // only a genuinely unrecognized `type` falls through to `unknown`.
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
    // pi carries the tool args on the START event, so read from what we stashed there.
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
    // Provider-error tracking (OPS-56 fix #2): a `stopReason:"error"` turn means the model failed
    // (dead quota/login/provider). Remember it; a later successful assistant turn clears it. On
    // agent_end this decides success vs a LOUD error finish instead of masking a dead provider.
    const provErr = providerErrorOf(message);
    if (provErr) {
      this.lastProviderError = provErr;
      this.emit({ kind: "error", message: provErr, ts: Date.now() });
      return;
    }
    this.lastProviderError = null;
    const text = this.textOf(message.content);
    if (text) {
      this.lastAgentMessage = text;
      this.emit({ kind: "assistant_text", text, partial: false, ts: Date.now() });
    }
  }

  private handleTurnEnd(obj: Record<string, unknown>): void {
    const message = obj.message as Record<string, unknown> | undefined;
    // A turn that ends in a provider error also carries it here — capture it even if we somehow
    // missed the message_end (defensive; the two are redundant for a failed turn).
    const provErr = providerErrorOf(message);
    if (provErr) this.lastProviderError = provErr;

    const usage = this.mapUsage(message?.usage);
    if (usage) {
      this.addTokens(usage);
      this.emit({ kind: "turn_completed", usage, ts: Date.now() });
    }
    // pi reports a REAL per-turn dollar cost (`usage.cost.total`) — accumulate actual spend.
    const cost = (message?.usage as Record<string, unknown> | undefined)?.cost as Record<string, unknown> | undefined;
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

    // OPS-56 fix #2: a run whose last turn ended in a provider error is NOT success — surface the
    // cause LOUDLY so a quota-exhausted / auth-broken / provider-down pi fails instead of silently
    // "completing" with no work.
    if (this.lastProviderError) {
      this.log.error("pi run ended with a provider error — failing loudly (not masking as success)", {
        error: this.lastProviderError,
        provider: this.config.harness.pi.default_provider,
      });
      this.emit({ kind: "error", message: this.lastProviderError, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_provider",
        structuredOutput: null,
        usage: { ...this.tokens },
        ts,
      });
      this.finished = true;
      this.stopWatchdog();
      if (!this.isTerminal()) this.setState("failed");
      void this.killChild();
      return;
    }

    // A completed run (no pending steering, no provider error) IS success; the done-signal's own
    // status drives the dispatcher's pass/fail verdict downstream.
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

  /** Clear the wall-clock watchdog interval (idempotent). */
  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
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
      // pi may wrap JSON in a ```json fence — try the first {...} block.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /** Join the text blocks of a pi message `content` array into a single string. */
  private textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("");
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

  /** Map pi `usage` → the shared {@link TokenUsage} shape (Spec 02 §7.3). */
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
