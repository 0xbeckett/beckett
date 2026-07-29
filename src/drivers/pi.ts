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
 * All process lifecycle (spawn scaffold, watchdog, exit handling, pumps) lives in
 * {@link BaseDriver} (issue #19); this file is ONLY the pi-specific surface: preflight, argv
 * construction, `--mode rpc` JSONL parsing, and the live steering channel.
 *
 * ── STEERING IS LIVE (issue #122) ──────────────────────────────────────────────────────
 * pi used to run here as one-shot `pi -p --mode json`: a nudge that arrived mid-run had nowhere
 * to go, so it was BUFFERED and applied only after `agent_end` by relaunching with `--session`.
 * On a long turn a correction sat unread for the whole turn, and a cancel raced process teardown.
 * With pi the default harness (#85.1) that latency stopped being acceptable.
 *
 * pi does expose a mid-turn input path: `--mode rpc` is a persistent JSONL command channel on
 * stdin (pi docs `docs/rpc.md`). The driver now runs pi that way and steers over it live:
 *
 *   {"type":"prompt","message":"<the task>"}   → start the run
 *   {"type":"steer","message":"<the nudge>"}   → inject mid-run, no relaunch
 *   {"type":"abort"}                           → cancel the in-flight turn
 *
 * The honest bound on "immediately": pi's agent loop drains its steering queue at the END of the
 * current turn and injects the message as a user turn BEFORE the next LLM call
 * (`pi-agent-core/dist/agent-loop.js` `runLoop`). So a nudge lands at the next turn boundary —
 * after the running tool batch finishes, not in the middle of a `sleep 600`. That is the SAME
 * bound the claude driver's live stdin channel has, and it costs no relaunch and loses no work.
 *
 * Mechanism (verified against `pi` 0.82.1, `--mode rpc` JSONL stream):
 *
 *   # first launch — caller-mint the session id so Beckett's ledger knows it before handshake:
 *   pi --mode rpc --provider <p> --model <m> --thinking <lvl> \
 *      --session-id <uuid> --append-system-prompt <systemAppend>
 *   # resume — pin the captured id so pi reloads the persisted transcript in the same cwd:
 *   pi --mode rpc --provider <p> --model <m> --thinking <lvl> --session <id>
 *
 * The prompt is NOT an argv positional any more: it rides the stdin channel as a `prompt` command
 * once the handshake lands, so the same open channel carries every later nudge.
 *
 * `<p>` is the pi PROVIDER — the backend the model actually runs on, and a per-stage cast field
 * since #121 (`{"harness":"pi","provider":"anthropic","model":"claude-opus-5"}`). Absent from the
 * cast it falls back to `config.harness.pi.default_provider`, so an un-cast stage behaves exactly
 * as before. Two backends are in use:
 *   - `openai-codex` (the config default) — gpt-5.6-* through codex (0.144) on the ChatGPT-account
 *     OAuth. The default model is `gpt-5.6-terra` (config.harness.pi.default_model);
 *     `gpt-5.6-luna` is the cheap/mechanical lane. SOL and bare `gpt-5.6` are NOT usable on this
 *     tier ("not supported with a ChatGPT account"), so don't cast them.
 *   - `anthropic` — claude-* (opus/fable/sonnet) on the Claude subscription OAuth. This is what
 *     lets pi be the ONE harness without giving up the Claude models.
 *
 * - cwd = the project repo (pi is rooted to the process cwd — there is no `-C`), set on spawn.
 * - `--mode rpc` emits the same JSON Lines event stream `--mode json` did, plus per-command
 *   `response` frames. The events we normalize (Spec 02 §7):
 *     `response`(get_state)   → the handshake (session id)    → session_started + resolves spawn
 *     `turn_start`            → a model turn began            → turn_started
 *     `tool_execution_start`  → a tool is running (name+args) → tool_call
 *     `tool_execution_end`    → tool finished (isError)       → tool_result (+ file_change for edits)
 *     `message_end`(assistant)→ a completed assistant message → assistant_text (final answer capture)
 *     `turn_end`              → turn done (carries usage+cost)→ turn_completed
 *     `queue_update`          → pi's own pending-steering queue (the no-lost-nudge guard)
 *     `agent_settled`         → the run is FULLY settled      → finished (success)
 *   `agent_end` is deliberately NOT terminal here: pi emits it per low-level run, and a retry,
 *   a compaction retry, or a queued steering continuation can still follow. `agent_settled` is
 *   pi's own "nothing more will happen automatically" signal, so that is the one we finish on.
 *   The parser is tolerant by contract: an unknown `type`, unknown tool, or malformed line
 *   becomes `kind:'unknown'` and NEVER throws.
 * - session id = Beckett mints the id and passes `--session-id` on the first launch. The preflight
 *   requires that flag and pi >=0.80.4 (the release that added `agent_settled`) so a stale install
 *   fails loudly before dispatch instead of dying after spawn (OPS-56 / issue #12).
 * - cancel = `{"type":"abort"}` on the channel to stop the in-flight turn, then the shared
 *   SIGTERM→SIGKILL process-GROUP kill. pi's own SIGTERM handler reaps the detached children it
 *   tracks, and the group kill sweeps anything it missed, so a cancel leaves no orphan pi.
 * - Done-signal: pi has no `--output-schema`, so the structured done-signal is parsed leniently
 *   from the final assistant message (raw JSON, a ```json fence, or a trailing object).
 *
 * Auth (Spec 00 §4): subscription/OAuth only — the child env strips API keys (src/env.ts) so pi
 * uses the `~/.pi/agent/auth.json` login (the ChatGPT/Codex OAuth via the `openai-codex`
 * provider). The child PATH is prefixed with `~/.local/bin` + `~/.bun/bin` so `pi` resolves AND
 * runs under the modern node there (the current Pi package needs node >=22.19.0).
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
} from "../types.ts";
import { childEnv } from "../env.ts";
import { BaseDriver, DEFAULT_RESUME_PROMPT, type Child } from "./base.ts";
import { classifyHarnessFailure } from "./failure.ts";
import { probeCommand } from "./preflight-probe.ts";

/** pi tool names that mutate files → we synthesize a file_change from their args.path. */
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch"]);

/**
 * Escalating budgets (ms) for a `pi --version` probe: a first try that survives ordinary machine
 * load, then a roomier retry if that one is KILLED. The old flat 10s died under two heavy workers
 * (`pi --version` runs in ~0.9s idle) and — because `Bun.spawnSync` reports a timeout kill as
 * `exitCode: null` — that transient starvation was misread as a broken pi and silently downgraded
 * the cast to another harness (issue #54). 30s clears the load spike; the 60s retry is the backstop.
 */
const PREFLIGHT_BUDGETS_MS = [30_000, 60_000] as const;
/** Single-shot budget for the secondary probes (`node --version`, `pi --help`) — no retry needed. */
const PREFLIGHT_TIMEOUT_MS = 30_000;
/**
 * Minimum pi CLI with BOTH contracts this driver rides: `--session-id` create-if-missing (0.78)
 * and the `agent_settled` RPC event the run's terminal finish keys on (added in 0.80.4). A pi
 * below this would run but never finish a turn — fail it at preflight instead (issue #122).
 */
const MIN_PI_VERSION = "0.80.4";
/** CLI flags the driver's invocation depends on — their absence signals version/protocol drift. */
const REQUIRED_PI_FLAGS = [
  "--mode",
  "--session",
  "--session-id",
  "--no-extensions",
  "--no-skills",
  "--no-themes",
] as const;

/**
 * How long {@link PiDriver.sendNudge} waits for pi's `response` ack before reporting `queued`.
 * The ack is cheap (pi answers a `steer` as soon as it enqueues it), so a miss here means the
 * channel is wedged, not that pi is busy — matches the claude driver's echo-ack budget.
 */
const NUDGE_ACK_TIMEOUT_MS = 30_000;

/**
 * How long a cancel gives pi to ack `{"type":"abort"}` before signalling anyway. Deliberately
 * tiny: this is a courtesy that lets pi cancel its LLM call and flush its transcript, NOT a
 * dependency — cancel must stay prompt, and the group kill is what actually reaps the worker.
 */
const ABORT_ACK_TIMEOUT_MS = 750;

/** RPC correlation ids the driver reserves for its own commands. */
const HANDSHAKE_ID = "beckett-handshake";
const PROMPT_ID = "beckett-prompt";
const ABORT_ID = "beckett-abort";
/**
 * The settle-time drain prompt gets its OWN id, distinct from {@link PROMPT_ID}. A rejected TASK
 * prompt means the run never happened and must fail the worker; a rejected DRAIN prompt happens
 * after a run already succeeded, so it must degrade to "surface the leftover steering" instead of
 * retroactively turning that success into an error finish.
 */
const DRAIN_PROMPT_ID = "beckett-drain";

/**
 * Safety valve on the {@link PiDriver} settle-time steering drain: a nudge that lands in the same
 * instant a run settles is re-prompted so pi's own queue drains into a fresh run, but a pi whose
 * queue never empties must not spin forever. After this many drain re-prompts we finish and let
 * the leftover surface through `drainUnappliedNudges()` instead.
 */
const MAX_SETTLE_DRAINS = 3;

/**
 * The PATH a pi child runs under: prefix `~/.local/bin` & `~/.bun/bin` so `pi` both RESOLVES and
 * RUNS under the modern node there (the current Pi package needs node >=22.19.0). Shared by the
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
  const env = childEnv({ PATH: piChildPath() });

  let nodeVersion: string | null = null;
  try {
    const n = Bun.spawnSync({ cmd: ["node", "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    const raw = `${n.stdout.toString()}\n${n.stderr.toString()}`.trim();
    nodeVersion = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
    if (!n.success || !nodeVersion || !semverGte(nodeVersion, "22.19.0")) {
      problems.push(
        `daemon PATH resolves node ${nodeVersion ?? "unknown"}; pi needs node >=22.19.0. ` +
          `Put a modern node before /usr/bin in the daemon PATH.`,
      );
    }
  } catch (err) {
    problems.push(`could not run node from the daemon PATH (${(err as Error).message}).`);
  }

  // 1 — binary resolves + reports a version. probeCommand draws the KILL vs FAIL line the old code
  // erased: a timed-out probe (exitCode null) retries at a longer budget and, if it still can't
  // answer, surfaces as an explicit TIMEOUT — never as a bare "exited null" that reads like a broken
  // pi and silently downgrades the cast (issue #54).
  let version: string | null = null;
  const probe = probeCommand([bin, "--version"], env, { budgets: PREFLIGHT_BUDGETS_MS });
  if (probe.spawnError) {
    problems.push(
      `pi binary "${bin}" is not runnable on PATH (${probe.spawnError.message}). ` +
        `Install pi or fix config.harness.pi.bin.`,
    );
  } else if (probe.ok) {
    // pi prints its version to stderr; fall back across both streams.
    const raw = `${probe.stdout}\n${probe.stderr}`.trim();
    version = raw.split("\n").map((l) => l.trim()).find(Boolean) || null;
    if (!semverGte(version, MIN_PI_VERSION)) {
      problems.push(
        `installed pi ${version} is too old; need >=${MIN_PI_VERSION} for --session-id and the ` +
          `\`agent_settled\` rpc event the driver finishes runs on.`,
      );
    }
  } else if (probe.timedOut) {
    // KILLED, not failed: the probe never got to answer. Say TIMED OUT explicitly so the dispatcher's
    // substitution comment blames machine load, not a broken/unauthenticated pi — and so this stops
    // poisoning the "pi is genuinely down" diagnosis it used to mimic.
    problems.push(
      `\`${bin} --version\` TIMED OUT — killed by ${probe.signalCode ?? "signal"} after ${probe.attempts} ` +
        `attempt(s), the last with a ${probe.budgetMs / 1000}s budget. pi was NOT confirmed broken; ` +
        `the probe was starved (likely heavy concurrent load). Retry when the box is quieter or raise the budget.`,
    );
  } else {
    // A real, self-chosen non-zero exit: pi ran and rejected the invocation. This one IS a fault.
    problems.push(`\`${bin} --version\` exited ${probe.exitCode}: ${probe.stderr.trim() || "(no output)"}`);
  }

  // 2 — CLI/protocol drift: confirm the flags the driver emits still exist. A KILLED --help probe
  // (timeout under load) is silently tolerated — the same load already surfaced on the --version
  // probe in (1), and a flag-drift verdict can't be trusted off a probe that never printed.
  const h = probeCommand([bin, "--help"], env, { budgets: PREFLIGHT_BUDGETS_MS });
  const help = `${h.stdout}\n${h.stderr}`;
  if (h.spawnError || h.timedOut) {
    /* a --help spawn failure / timeout is already implied by the --version probe in (1) */
  } else if (!h.ok) {
    problems.push(`\`${bin} --help\` exited ${h.exitCode}: ${h.stderr.trim() || "(no output)"}`);
  } else if (help.trim()) {
    const missing = REQUIRED_PI_FLAGS.filter((f) => !help.includes(f));
    if (missing.length) {
      problems.push(
        `installed pi (${version ?? "unknown version"}) no longer advertises ${missing.join(", ")} — ` +
          `CLI/protocol drift; the PiDriver invocation needs updating.`,
      );
    }
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

/** A nudge written to the channel and awaiting pi's `response` ack. */
interface PendingSteer {
  id: string;
  /** The nudge text — kept so a REJECTED nudge can be re-buffered instead of vanishing. */
  text: string;
  resolve: (r: NudgeReceipt) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiDriver extends BaseDriver implements HarnessDriver {
  readonly kind = "pi-cli-stream" as const;

  // ── pi-specific parse state ─────────────────────────────────────────────────
  /** The text of the most recent completed assistant message — the candidate done-signal. */
  private lastAgentMessage = "";
  /**
   * The provider error carried on the LAST assistant message (`stopReason:"error"`), or null if
   * the run's most recent assistant turn completed normally. pi still emits a clean `agent_end`
   * after a dead-on-arrival turn (e.g. "No API key for provider: openai-codex"), so without this
   * an unauthenticated run would finish as an instant empty "success" and the dispatcher would
   * happily advance the ticket on nothing.
   */
  private runError: string | null = null;
  /** tool call ids already counted (dedup) + their names (so an edit tool → file_change). */
  private readonly toolNames = new Map<string, string>();
  /** tool call id → its start `args` (pi carries args only on the start event, not the end). */
  private readonly toolArgs = new Map<string, unknown>();
  /** Accumulated real cost off `turn_end.message.usage.cost.total` (pi reports dollars). */
  private usd: number | null = null;

  // ── live steering channel (`--mode rpc` stdin; issue #122) ──────────────────
  /**
   * The prompt to send as soon as the handshake lands. pi's RPC channel refuses a `prompt` before
   * the session exists, so the initial task waits here rather than riding argv.
   */
  private pendingInitialPrompt: string | null = null;
  /** Nudges written to the channel, awaiting pi's `response` ack (id-correlated). */
  private readonly pendingSteers: PendingSteer[] = [];
  /**
   * Steering that could NOT ride the live channel — the process is dead or paused. This is the
   * ONLY buffer left, and it is drained by exactly one consumer (`resume()` or
   * `drainUnappliedNudges()`) via splice, so a nudge can never be applied twice.
   */
  private readonly bufferedNudges: string[] = [];
  /** True between `agent_start` and `agent_settled` — i.e. a run is in flight and `steer` applies. */
  private runActive = false;
  /**
   * pi's OWN pending steering queue, mirrored from its `queue_update` events. pi emits this both
   * when a message is enqueued and when it is injected as a user turn, so a non-empty queue at
   * settle time is the exact "a nudge arrived too late to be drained" signal (issue #122).
   */
  private piSteeringQueue: string[] = [];
  /** How many settle-time drains we have already issued (bounded by {@link MAX_SETTLE_DRAINS}). */
  private settleDrains = 0;
  /** Monotonic suffix for steer correlation ids. */
  private steerSeq = 0;
  /** Resolver for the bounded cancel-time wait on pi's `abort` ack (null when not waiting). */
  private resolveAbortAck: (() => void) | null = null;
  /** True once pi has acked an abort — a second cancel must not wait on the channel again. */
  private abortAcked = false;

  constructor(config: Config, logger?: Logger) {
    super(config, logger, "driver.pi");
  }

  // ===========================================================================
  // BaseDriver hooks
  // ===========================================================================

  protected harnessName(): string {
    return "pi";
  }

  protected binName(): string {
    return this.config.harness.pi.bin;
  }

  protected usdEstimate(): number | null {
    return this.usd;
  }

  /** Child env: strip API keys (force OAuth login) + prefix ~/.local/bin & ~/.bun/bin onto PATH. */
  protected override buildChildEnv(): Record<string, string | undefined> {
    const env = childEnv();
    env.PATH = piChildPath(env.PATH);
    return env;
  }

  /** pi's stdin stays an open JSONL command channel — the task and every nudge ride it (#122). */
  protected override stdinMode(): "pipe" | "ignore" {
    return "pipe";
  }

  /**
   * `--mode rpc` has no startup `session` line to handshake on, so ASK: a `get_state` command
   * answers with the session id pi actually bound. Its `response` both resolves the spawn promise
   * and releases {@link pendingInitialPrompt} onto the channel.
   */
  protected override afterLaunch(_child: Child, _isResume: boolean): void {
    this.writeCommand({ id: HANDSHAKE_ID, type: "get_state" });
  }

  /** A dead process can never ack a pending nudge — fail them rather than hang their callers. */
  protected override onExitCleanup(): void {
    this.failPendingSteers();
    this.runActive = false;
    // A dead process will never ack the cancel — release the bounded wait instead of sitting it out.
    this.resolveAbortAck?.();
    this.resolveAbortAck = null;
  }

  /**
   * A loud, actionable message for the #1 pi failure: the child dies before its `session`
   * handshake. Folds in the captured stderr tail (e.g. `Error: Unknown option: --session-id`)
   * so the real cause is visible instead of the opaque bare "exited before session line" (OPS-56).
   */
  protected override spawnFailureError(reason: string | number): Error {
    const tail = this.stderrRing.tail();
    const detail = tail ? ` pi stderr: ${JSON.stringify(tail)}.` : " pi printed nothing to stderr.";
    return new Error(
      `PiDriver: pi exited (${reason}) before answering the RPC handshake — the harness never ` +
        `started.${detail} Common causes: a pi CLI/version drift (an unknown flag), a bad ` +
        `harness.pi.bin, or a missing/expired pi login (~/.pi/agent/auth.json). Run the pi preflight.`,
    );
  }

  /** pi reports crash exits as a blocked done-signal so the dispatcher sees a reason. */
  protected override exitFinishStructuredOutput(message: string): unknown {
    return { status: "blocked", summary: message, filesChanged: [], checksRun: [], blockedReason: message };
  }

  protected override launchLogFields(): Record<string, unknown> {
    return {
      provider: this.resolvedProvider(),
      model: this.resolvedModel() || "(pi default)",
      thinking: this.resolvedThinking(),
    };
  }

  /** Reset per-process parse/channel state before a relaunch (counters/session stay cumulative). */
  private resetParseState(): void {
    this.lastAgentMessage = "";
    this.runError = null;
    this.runActive = false;
    this.piSteeringQueue = [];
    this.settleDrains = 0;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /** Launch the pi worker and resolve once the RPC handshake yields an id (spawning→running). */
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
    // Crash recovery (issue #20): a caller-persisted session id relaunches `--session <id>` so pi
    // reuses the persisted transcript instead of re-paying the whole ticket's exploration cost.
    const resume = spec.resumeSessionId?.trim();
    this.sessionId = resume || (spec.sessionId ?? randomUUID());
    // The task rides the RPC channel, not argv — hold it until the handshake response lands.
    this.pendingInitialPrompt = spec.prompt;
    const args = this.buildArgs(/*isResume*/ Boolean(resume));
    return this.launch(args, { isResume: Boolean(resume) });
  }

  // ===========================================================================
  // argv construction
  // ===========================================================================

  /**
   * The `--mode rpc` argv. Note what is ABSENT versus the old one-shot invocation: no `-p` and no
   * trailing prompt positional. rpc mode is a persistent channel — the prompt is a stdin command,
   * which is exactly what makes later nudges deliverable without a relaunch (issue #122).
   */
  private buildArgs(isResume: boolean): string[] {
    // Pin the worker environment: pi auto-discovers extensions/skills/themes from the ticket repo
    // AND the user dirs, so a stray install on the box would change worker behavior invisibly.
    // Context-file discovery (AGENTS.md/CLAUDE.md in the ticket repo) stays ON — that's desirable.
    const args: string[] = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-themes",
      "--provider",
      this.resolvedProvider(),
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
    return args;
  }

  private resolvedModel(): string {
    return (this.spec?.model || this.config.harness.pi.default_model || "").trim();
  }

  /**
   * The pi BACKEND this run talks to (#121). pi is provider-agnostic, so the cast owns the
   * choice: `{"harness":"pi","provider":"anthropic","model":"claude-opus-5"}` routes the stage at
   * the Claude subscription instead of the ChatGPT-account `openai-codex` default. An un-cast
   * stage keeps the configured default exactly as before.
   */
  private resolvedProvider(): string {
    // Trim BEFORE the fallback: a whitespace-only cast field is not a routing decision, and an
    // empty `--provider ""` would send pi to its own built-in default (google), not ours.
    return this.spec?.provider?.trim() || (this.config.harness.pi.default_provider ?? "").trim();
  }

  /** pi `--thinking` reuses the resource envelope's effort (same low|medium|high|xhigh vocabulary). */
  private resolvedThinking(): string {
    return this.spec?.envelope.effort || this.config.harness.pi.thinking;
  }

  // ===========================================================================
  // the RPC command channel (issue #122)
  // ===========================================================================

  /**
   * Write one JSONL command to pi's stdin. pi's reader is strict JSONL with LF as the ONLY record
   * delimiter (`docs/rpc.md` §Framing), so the payload is `JSON.stringify`d — which escapes any
   * embedded newline — and terminated with a single `\n`. Throws if the channel is gone; every
   * caller decides for itself whether that is fatal or merely a reason to buffer.
   */
  private writeCommand(cmd: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || typeof (stdin as { write?: unknown }).write !== "function") {
      throw new Error("PiDriver: no live RPC channel (pi stdin is not writable)");
    }
    (stdin as { write: (s: string) => unknown; flush?: () => unknown }).write(
      `${JSON.stringify(cmd)}\n`,
    );
    (stdin as { flush?: () => unknown }).flush?.();
  }

  /** Best-effort {@link writeCommand} — for teardown paths where a dead channel is not an error. */
  private tryWriteCommand(cmd: Record<string, unknown>): boolean {
    try {
      this.writeCommand(cmd);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // sendNudge — LIVE steering over the rpc channel (issue #122)
  // ===========================================================================

  /**
   * Steer a running pi worker without restarting it. Three cases, in priority order:
   *
   *  1. the worker already finished → `dropped`, exactly as claude does: nothing will ever replay
   *     it, so say so instead of handing back a receipt for a delivery that cannot happen (#22);
   *  2. the channel is not live (process dead, or paused) → buffered for the next {@link resume},
   *     reported `queued` — this is the ONLY remaining buffered path;
   *  3. the channel IS live → written straight to pi. A run in flight takes `steer` (pi injects it
   *     at the next turn boundary); an IDLE worker between runs takes `prompt`, which starts a run
   *     immediately rather than letting the words sit in a queue nothing will drain.
   *
   * The receipt resolves `delivered` on pi's own `response` ack and degrades to `queued` if that
   * ack does not arrive within {@link NUDGE_ACK_TIMEOUT_MS}.
   */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    if (this.finished || this.isTerminal()) {
      this.log.warn("nudge arrived after finish — dropped (nothing will ever replay it)", {
        state: this.workerState,
      });
      return { accepted: "dropped", at: Date.now() };
    }

    const deliverable = this.child !== null && this.workerState !== "paused" && this.sessionEmitted;
    if (!deliverable) {
      this.bufferedNudges.push(msg);
      this.log.info("nudge buffered (rpc channel not live)", {
        state: this.workerState,
        pending: this.bufferedNudges.length,
      });
      return { accepted: "queued", at: Date.now() };
    }

    const id = `beckett-steer-${++this.steerSeq}`;
    // `steer` only means anything while a run is streaming; between runs pi would queue it behind
    // a drain that never comes, so an idle worker gets a `prompt` instead.
    const type = this.runActive ? "steer" : "prompt";
    return new Promise<NudgeReceipt>((resolve) => {
      const timer = setTimeout(() => {
        this.takePendingSteer(id);
        if (this.workerState === "nudging") this.setState("running");
        this.log.warn("no pi ack for the nudge within the budget — reporting queued", { id, type });
        resolve({ accepted: "queued", at: Date.now() });
      }, NUDGE_ACK_TIMEOUT_MS);
      this.pendingSteers.push({ id, text: msg, resolve, timer });
      try {
        this.writeCommand({ id, type, message: msg });
        this.setState("nudging");
        this.log.info("nudge written to the live pi rpc channel", { id, type, len: msg.length });
      } catch (err) {
        this.takePendingSteer(id);
        clearTimeout(timer);
        this.bufferedNudges.push(msg);
        this.log.warn("nudge write failed; buffered for resume", { error: String(err) });
        resolve({ accepted: "queued", at: Date.now() });
      }
    });
  }

  /** Pull a pending steer off the list by id (and stop its ack timer). */
  private takePendingSteer(id: string): PendingSteer | undefined {
    const idx = this.pendingSteers.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    const [p] = this.pendingSteers.splice(idx, 1);
    if (p) clearTimeout(p.timer);
    return p;
  }

  /** Resolve every in-flight nudge as `queued` — the process died before it could ack. */
  private failPendingSteers(): void {
    const pending = this.pendingSteers.splice(0, this.pendingSteers.length);
    for (const p of pending) {
      clearTimeout(p.timer);
      p.resolve({ accepted: "queued", at: Date.now() });
    }
  }

  /**
   * Steering that was buffered but never reached the model (issue #22). Drained by splice, so the
   * one consumer that gets a nudge is the only one — a nudge can never be replayed twice.
   */
  drainUnappliedNudges(): string[] {
    return this.bufferedNudges.splice(0, this.bufferedNudges.length);
  }

  // ===========================================================================
  // cancel / resume
  // ===========================================================================

  /**
   * Hard stop. Ask pi to abandon the in-flight turn FIRST (`{"type":"abort"}` on the channel) so it
   * cancels the LLM call and releases the tools it is running — pi then flushes its session
   * transcript, which is what makes a later resume-after-cancel pick up real work instead of a
   * truncated one. Then fall through to the shared SIGTERM→SIGKILL process-GROUP kill.
   *
   * The ack wait is tightly bounded ({@link ABORT_ACK_TIMEOUT_MS}) and never load-bearing: cancel
   * has to be PROMPT, and it is the group kill — not pi's cooperation — that guarantees neither
   * the harness nor anything it forked survives (issue #122).
   */
  override async abort(reason: string): Promise<void> {
    if (this.child && !this.abortAcked) {
      const sent = this.tryWriteCommand({ id: ABORT_ID, type: "abort" });
      this.log.info("cancel: asking pi to abort the in-flight turn before the kill", { sent });
      if (sent) {
        await Promise.race([
          new Promise<void>((resolve) => {
            this.resolveAbortAck = resolve;
          }),
          Bun.sleep(ABORT_ACK_TIMEOUT_MS),
        ]);
        this.resolveAbortAck = null;
      }
    }
    this.runActive = false;
    this.failPendingSteers();
    await super.abort(reason);
  }

  /**
   * Re-attach a paused/crashed worker. A live process just lifts the pause and flushes anything
   * that was buffered while it was down — no relaunch, because the channel is still open. A dead
   * process is relaunched against its persisted session (`--session <id>`), and the buffered
   * steering becomes the first prompt of the new run.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error("PiDriver: resume before spawn");

    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.log.info("worker resumed (rpc channel still open)", { pending: this.bufferedNudges.length });
      this.flushBufferedNudges();
      return;
    }
    if (!this.sessionId) throw new Error("PiDriver: resume without a captured session id");

    // splice, not read: the buffer is drained EXACTLY once, so a nudge already carried into this
    // relaunch's prompt can never be replayed by a later resume (issue #122).
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    const prompt = pending.length ? pending.join("\n\n") : DEFAULT_RESUME_PROMPT;
    this.log.info("relaunching pi against its persisted session (resume)", {
      sessionId: this.sessionId,
      promptLen: prompt.length,
      nudges: pending.length,
    });

    // Sweep the superseded child BEFORE relaunching (issue #11 leak 5): the previous process may
    // still be exiting — dropping its handle here would orphan it. The childGen guard keeps its
    // exit from firing spuriously.
    await this.killChild();

    this.finished = false;
    this.sessionEmitted = false;
    this.resetParseState();
    this.pendingInitialPrompt = prompt;

    await this.launch(this.buildArgs(/*isResume*/ true), { isResume: true });
  }

  /**
   * Push nudges buffered while the worker was down onto the now-live channel, exactly once.
   * Deliberately NOT awaited: each `sendNudge` waits out an ack budget, and resume() must not
   * block for minutes behind a queue of them. The writes still land in order (they are synchronous
   * on the channel), and sendNudge never rejects — a failed write re-buffers rather than throwing.
   */
  private flushBufferedNudges(): void {
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    for (const msg of pending) void this.sendNudge(msg);
  }

  // ===========================================================================
  // JSONL parsing (`--mode rpc`)
  // ===========================================================================

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by contract:
   * a malformed line or unknown `type` becomes `kind:'unknown'` — never a throw.
   */
  // Public (widened from the protected abstract): pi.test.ts drives the parser through
  // `driver.handleLine(...)` directly. The shared parse/try-catch envelope lives in base.
  handleLine(line: string): void {
    this.normalizeLine(line, (obj) => this.dispatchFrame(obj));
  }

  /** Route one parsed `--mode rpc` frame by `type` (shared envelope in normalizeLine). */
  private dispatchFrame(obj: Record<string, unknown>): void {
    switch (obj.type) {
      case "response":
        this.handleResponse(obj);
        break;
      // A `session` header line is what `--mode json` opened with. rpc mode does not emit one, but
      // keep handling it: it costs nothing and keeps a session id we are handed authoritative.
      case "session":
        this.handleSession(obj);
        break;
      case "agent_start":
        this.runActive = true;
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
      case "queue_update":
        this.handleQueueUpdate(obj);
        break;
      case "agent_settled":
        this.handleAgentSettled();
        break;
      case "error":
        this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
        break;
      // High-frequency streaming / lifecycle chatter we deliberately DON'T surface: the per-token
      // `message_update` alone fires hundreds of times a turn, so routing these to `unknown` would
      // flood the event bus. Explicitly ignored (not unknown) — only a genuinely unrecognized
      // `type` falls through to `unknown`.
      //
      // `agent_end` is in here on purpose: in rpc mode it marks the end of ONE low-level run, and a
      // retry, a compaction retry, or a queued steering continuation can still follow it. Finishing
      // the worker on it would cut a run short mid-steer. `agent_settled` is the terminal one.
      case "agent_end":
      case "message_start":
      case "message_update":
      case "tool_execution_update":
      case "bash_execution_update":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "extension_error":
      case "extension_ui_request":
        break;
      default:
        this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleSession(obj: Record<string, unknown>): void {
    // Shared handshake tail in base: capture id, emit session_started, clear spawn timer, resolve.
    const id = this.str(obj.id) ?? this.sessionId;
    this.emitSessionStarted(id, this.resolvedModel(), Date.now());
    this.sendPendingPrompt();
  }

  /**
   * A per-command `response` frame. Three correlation ids matter:
   *   - {@link HANDSHAKE_ID}: the `get_state` answer — carries the session id pi actually bound, so
   *     it IS the handshake (rpc mode has no startup `session` line). Releases the initial prompt.
   *   - {@link PROMPT_ID}: a rejected prompt is a dead run, not a slow one — surface it now instead
   *     of waiting out the wall-clock cap for a settle that will never come.
   *   - a `beckett-steer-*` id: the nudge ack that resolves {@link sendNudge}'s receipt.
   */
  private handleResponse(obj: Record<string, unknown>): void {
    const id = this.str(obj.id);
    const ok = obj.success === true;

    if (id === HANDSHAKE_ID) {
      const data = obj.data as Record<string, unknown> | undefined;
      this.emitSessionStarted(this.str(data?.sessionId) ?? this.sessionId, this.resolvedModel(), Date.now());
      this.sendPendingPrompt();
      return;
    }

    if (id === ABORT_ID) {
      this.abortAcked = true;
      this.resolveAbortAck?.();
      this.resolveAbortAck = null;
      return;
    }

    if (id === DRAIN_PROMPT_ID) {
      if (!ok) {
        // The run already succeeded; a refused drain only means the queued words stay unapplied.
        this.log.warn("pi refused the steering-drain prompt — surfacing the steering as unapplied", {
          err: this.str(obj.error),
          queued: this.piSteeringQueue.length,
        });
        this.bufferedNudges.push(...this.piSteeringQueue);
        this.piSteeringQueue = [];
        this.handleAgentSettled();
      }
      return;
    }

    if (id === PROMPT_ID) {
      if (!ok) {
        const message = this.str(obj.error) ?? "pi rejected the prompt";
        this.runError = message;
        this.emit({ kind: "error", message, ts: Date.now() });
        this.finishRun("error", "error_provider", message);
      }
      return;
    }

    const steer = id ? this.takePendingSteer(id) : undefined;
    if (!steer) return;
    if (this.workerState === "nudging" && this.pendingSteers.length === 0 && !this.isTerminal()) {
      this.setState("running");
    }
    if (ok) {
      this.log.info("pi acked the nudge — it lands at the next turn boundary", { id });
      steer.resolve({ accepted: "delivered", at: Date.now() });
    } else {
      // pi refused the command outright, so it holds NOTHING — the commonest cause is the reverse
      // of our live/idle race (we sent `prompt` believing the worker idle; pi was already
      // streaming). The words exist only here, so re-buffer them or they vanish while the receipt
      // claims otherwise. Safe against duplication: a rejected command was never queued inside pi.
      const err = this.str(obj.error) ?? "pi rejected the steer";
      this.bufferedNudges.push(steer.text);
      this.log.warn("pi REJECTED the nudge — re-buffered it for the next resume", { id, err });
      steer.resolve({ accepted: "queued", at: Date.now() });
    }
  }

  /** Release the held task/resume prompt onto the channel once the handshake has landed. */
  private sendPendingPrompt(): void {
    const prompt = this.pendingInitialPrompt;
    if (prompt === null) return;
    this.pendingInitialPrompt = null;
    try {
      this.writeCommand({ id: PROMPT_ID, type: "prompt", message: prompt });
    } catch (err) {
      this.log.error("failed to write the initial prompt to the pi rpc channel", { err: String(err) });
    }
  }

  /**
   * Mirror pi's own pending-steering queue. This is the no-lost-nudge guard: pi emits `queue_update`
   * both when it enqueues a steer AND when it injects one as a user turn, so whatever is still
   * listed here at settle time is precisely the steering that arrived too late for the run's last
   * drain — {@link handleAgentSettled} re-prompts to flush it instead of finishing on top of it.
   */
  private handleQueueUpdate(obj: Record<string, unknown>): void {
    const steering = obj.steering;
    this.piSteeringQueue = Array.isArray(steering) ? steering.filter((s): s is string => typeof s === "string") : [];
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
    // Track the run's error state off the LATEST assistant message: a turn that ends with
    // `stopReason:"error"` (auth missing, provider down) arms it; any later successful turn
    // clears it, so a transient mid-run error that pi recovered from doesn't fail the run.
    if (message.stopReason === "error") {
      this.runError = this.str(message.errorMessage) ?? "pi provider error";
      this.emit({ kind: "error", message: this.runError, ts: Date.now() });
    } else {
      this.runError = null;
    }
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

  /**
   * `agent_settled` — pi's own "nothing more will happen automatically" signal, and therefore the
   * run's terminal event here (NOT `agent_end`, which one retry or queued continuation can follow).
   *
   * Before finishing, close the one hole the live channel leaves: a nudge that landed in the same
   * instant the run settled is still sitting in pi's steering queue, past the loop's last drain.
   * pi reports that queue itself via `queue_update`, so when it is non-empty we send a continuation
   * `prompt` — pi drains its OWN queued text into that run, which is why this cannot duplicate the
   * nudge (we never re-send the words, only wake the loop that already holds them).
   */
  private handleAgentSettled(): void {
    const ts = Date.now();
    this.runActive = false;

    if (this.piSteeringQueue.length > 0 && !this.isTerminal() && !this.finished) {
      if (this.settleDrains < MAX_SETTLE_DRAINS) {
        this.settleDrains += 1;
        this.log.info("run settled with steering still queued inside pi — re-prompting to drain it", {
          queued: this.piSteeringQueue.length,
          drain: this.settleDrains,
        });
        // No message text of our own: pi injects the queued steering at the start of the new run.
        if (this.tryWriteCommand({ id: DRAIN_PROMPT_ID, type: "prompt", message: DEFAULT_RESUME_PROMPT })) {
          return;
        }
        this.log.warn("could not re-prompt to drain queued steering — finishing instead");
      } else {
        // Never spin: hand the leftover back through the unapplied-nudge path so the dispatcher
        // tells the human rather than us looping on a queue pi will not drain (issue #22).
        this.log.warn("steering still queued after the drain budget — surfacing it as unapplied", {
          queued: this.piSteeringQueue.length,
        });
        this.bufferedNudges.push(...this.piSteeringQueue);
        this.piSteeringQueue = [];
      }
    }

    // pi settles cleanly even when the run's last turn DIED on a provider error (no auth, provider
    // down) — the run produced nothing, so surfacing it as success would advance the ticket on an
    // empty result. Fail it with the provider's own message instead.
    if (this.runError) {
      this.finishRun("error", "error_provider", this.runError, ts);
      return;
    }

    // A settled run IS success; the done-signal's own status drives the dispatcher's verdict.
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
    this.shutdownChannel();
  }

  /** Emit a terminal error finish carrying pi's own message, then tear the process down. */
  private finishRun(
    status: "error",
    subtype: string,
    message: string,
    ts = Date.now(),
  ): void {
    if (this.finished) return;
    this.emit({
      kind: "finished",
      status,
      subtype,
      structuredOutput: this.exitFinishStructuredOutput(message),
      usage: { ...this.tokens },
      errorClass: classifyHarnessFailure(message) ?? "crash",
      ts,
    });
    this.finished = true;
    this.stopWatchdog();
    if (!this.isTerminal()) this.setState("failed");
    this.shutdownChannel();
  }

  /**
   * Close the run down. Ending stdin is pi's OWN clean-shutdown trigger in rpc mode (its stdin
   * `end` handler disposes the runtime and exits), so try that first — but never rely on it: the
   * group kill follows regardless so a pi that ignores EOF, or a bash child it forked, cannot
   * linger holding the worker slot (issue #122).
   */
  private shutdownChannel(): void {
    try {
      (this.child?.stdin as { end?: () => unknown } | undefined)?.end?.();
    } catch {
      /* channel already gone — the kill below is what actually guarantees teardown */
    }
    void this.killChild();
  }

  // ===========================================================================
  // pi-format helpers
  // ===========================================================================

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

  /** Map pi's `usage` block → the shared {@link TokenUsage} shape (field-map in base). */
  private mapUsage(raw: unknown): TokenUsage | null {
    return this.mapTokenUsage(raw, {
      input: "input",
      output: "output",
      cacheRead: "cacheRead",
      cacheCreate: "cacheWrite",
    });
  }
}
