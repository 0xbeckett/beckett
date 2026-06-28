/**
 * Beckett — read-only observation & the Supervisor impl (`src/supervise/tailer.ts`)
 * =======================================================================================
 * The Observation + Triggering layers of the control plane (Spec 03 §1–§3). The {@link Tailer}
 * is the concrete {@link Supervisor}: every worker gets exactly one, the instant it spawns. It
 * consumes the worker's normalized {@link WorkerEvent} stream (from the driver), maintains a
 * small mechanical counter set ({@link WorkerCounters}), fires {@link SmokeAlarm}s through the
 * {@link AlarmEngine}, and arms/fires Opus's self-scheduled {@link CheckIn}s.
 *
 * Non-negotiable canon (Spec 03 §1.1, §1.5): the Tailer is **read-only**. It never writes to a
 * worker's stdin, never touches its workspace, never calls a model, never nudges/pauses/aborts.
 * It only emits *signals* — a smoke-alarm or a fired check-in is a prompt for the Orchestrator
 * to pull Opus in to *look* (Spec 03 §4). Intervention is a separate, deliberate write owned by
 * the Orchestrator/WorkerManager. If the Tailer crashes the worker is unaffected; if the worker
 * dies the Tailer flushes and exits.
 *
 * The event parser tolerates unknown event kinds (switch on what we know, ignore the rest,
 * never throw — Spec 02 §7.2 / loom-desk Risk-A).
 */

import type {
  Supervisor,
  Worker,
  WorkerEvent,
  SmokeAlarm,
  CheckIn,
  CheckInRow,
  ResourceEnvelope,
  Config,
  Store,
  Logger,
} from "../types.ts";
import { WORKER_TERMINAL } from "../types.ts";
import { log } from "../log.ts";
import {
  AlarmEngine,
  deriveThresholds,
  toolSignature,
  argTokens,
  nearIdentical,
  type AlarmThresholds,
} from "./alarms.ts";

/**
 * The unified per-worker counter set (Spec 03 §1.3). The single source of truth the
 * smoke-alarms read; deliberately small, mechanical, and cheap. Tokens/diff/usd persisted via
 * the driver's {@link Worker.spend}; this struct owns only the supervise-specific derivations.
 */
export interface WorkerCounters {
  workerId: string;
  nodeId: string;
  harness: Worker["harness"];

  // ── progress / activity ──
  turns: number; // completed turns (turn_completed boundaries)
  toolCalls: number; // total tool invocations observed
  lastActivityTs: number; // epoch ms of the last observed event of ANY kind
  lastTurnEndTs: number; // epoch ms of the last turn boundary

  // ── change / diff progress (sampled from worker.spend at each turn boundary) ──
  diffTotal: number; // added + removed lines at the last sample
  filesChanged: number;
  turnsSinceDiffProgress: number; // turns since diff last grew by ≥ minProgress (drives A1)

  // ── repetition (drives A3) ──
  repeatedToolCallRun: number; // run-length of near-identical consecutive tool calls
  lastToolSig: string | null; // fingerprint of the most recent tool call
  lastToolTokens: Set<string> | null; // token set of the most recent tool call (Jaccard)

  // ── health flags ──
  scopeViolations: number; // hook/sandbox out-of-scope write denials (drives A4)
  blockedFlag: boolean; // worker waiting on input / a question (drives A5)
  errorFlag: boolean; // last turn errored (drives A5)

  // ── bookkeeping ──
  streamOffsetBytes: number; // on-disk transcript offset for restart re-tail (Spec 03 §1.2)
  envelope: ResourceEnvelope; // node envelope copied at dispatch (drives A2)
  startTs: number; // worker.spawnedAt — wall-clock basis
}

/** A subscriber to fired smoke-alarms. */
type AlarmCb = (alarm: SmokeAlarm, worker: Worker) => void;
/** A subscriber to fired check-ins (the "look now" signal Opus scheduled, Spec 03 §3). */
type CheckInCb = (checkIn: CheckIn, worker: Worker) => void;

/** Tool names that signal a worker is waiting on the user (sets `blockedFlag`). */
const BLOCKING_TOOLS = new Set(["askuserquestion", "ask_user_question", "askuser"]);

/**
 * The concrete {@link Supervisor}: one Observer per worker (Spec 03 §1.1), plus the check-in
 * scheduler (Spec 03 §3.2). The daemon constructs a single Tailer and routes every worker's
 * driver events into {@link ingest}.
 */
export class Tailer implements Supervisor {
  private readonly thresholds: AlarmThresholds;
  private readonly engine: AlarmEngine;
  private readonly logger: Logger;

  /** Live counter state, keyed by workerId. */
  private readonly counters = new Map<string, WorkerCounters>();
  /** Latest known Worker handle, keyed by workerId (for alarm/check-in callbacks). */
  private readonly workers = new Map<string, Worker>();
  /** In-memory pending check-ins (turn-based ones are polled here), keyed by checkInId. */
  private readonly pendingCheckIns = new Map<string, CheckIn>();
  /** Armed time-trigger timers, keyed by checkInId. */
  private readonly checkInTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-worker staleness timers (re-armed on every event), keyed by workerId. */
  private readonly staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly alarmSubs = new Set<AlarmCb>();
  private readonly checkInSubs = new Set<CheckInCb>();

  constructor(
    private readonly store: Store,
    config: Config,
    logger: Logger = log.child("supervise"),
  ) {
    this.thresholds = deriveThresholds(config);
    this.engine = new AlarmEngine(this.thresholds);
    this.logger = logger;
  }

  // ── Supervisor: observation ──────────────────────────────────────────────────────────

  /**
   * Ingest one normalized event for a worker (read-only tail, Spec 03 §1). Updates counters,
   * persists telemetry at turn boundaries, evaluates smoke-alarms, and polls turn-based
   * check-ins. Never throws on an unknown kind (Spec 02 §7.2).
   */
  ingest(worker: Worker, event: WorkerEvent): void {
    this.workers.set(worker.id, worker);
    const c = this.counters.get(worker.id) ?? this.initCounters(worker);
    if (!this.counters.has(worker.id)) this.counters.set(worker.id, c);

    const now = event.ts || Date.now();
    c.lastActivityTs = now;
    this.armStaleTimer(worker, c);

    let turnBoundary = false;

    switch (event.kind) {
      case "tool_call":
        this.onToolCall(c, event.tool, event.input);
        if (BLOCKING_TOOLS.has(event.tool.toLowerCase())) c.blockedFlag = true;
        break;

      case "hook_decision":
        if (event.decision === "deny") {
          c.scopeViolations += 1;
          this.store.appendEvent({
            type: "supervise.scope_violation",
            worker_id: worker.id,
            node_id: worker.nodeId,
            task_id: worker.taskId,
            payload: { reason: event.reason ?? "", count: c.scopeViolations },
          });
        } else if (event.decision === "ask") {
          c.blockedFlag = true;
        }
        break;

      case "turn_started":
        // A new turn is underway → the worker is no longer waiting on us.
        c.blockedFlag = false;
        c.errorFlag = false;
        break;

      case "turn_completed":
        c.turns += 1;
        c.lastTurnEndTs = now;
        this.sampleDiff(c, worker);
        turnBoundary = true;
        break;

      case "file_change":
        c.filesChanged = Math.max(c.filesChanged, event.paths.length);
        break;

      case "finished":
        if (event.status === "error") c.errorFlag = true;
        this.onWorkerTerminal(worker);
        break;

      case "error":
        c.errorFlag = true;
        break;

      // session_started / assistant_text / tool_result / plan_update / user_echo / unknown:
      // activity already recorded via lastActivityTs; nothing else mechanical to derive.
      default:
        break;
    }

    if (turnBoundary) {
      this.persistTelemetry(worker, c);
    }

    this.fireAlarms(worker, c, now);

    if (turnBoundary) {
      this.checkOnTurn(worker, c.turns);
    }
  }

  /**
   * Re-arm counters + alarms + check-ins for a resumed worker from a saved transcript offset
   * (Spec 03 §1.2 / Spec 09 §4 recovery). Seeds counters from the persisted {@link Worker.spend}
   * so a resume doesn't instantly re-trip an alarm, and re-arms pending check-ins from SQLite.
   */
  rearm(worker: Worker, streamOffsetBytes: number): void {
    const c = this.initCounters(worker);
    c.turns = worker.spend.turns;
    c.toolCalls = worker.spend.toolCalls;
    c.diffTotal = worker.spend.diffLines.added + worker.spend.diffLines.removed;
    c.filesChanged = worker.spend.diffLines.files;
    c.streamOffsetBytes = streamOffsetBytes;
    c.lastActivityTs = worker.lastActivityTs || Date.now();
    this.counters.set(worker.id, c);
    this.workers.set(worker.id, worker);
    this.engine.reset(worker.id);
    this.armStaleTimer(worker, c);

    // Re-arm any check-ins that were pending at crash time (Spec 03 §3.2 rearmOnRestart).
    for (const row of this.store.pendingCheckIns(worker.id)) {
      const ci = this.checkInFromRow(row);
      this.pendingCheckIns.set(ci.id, ci);
      this.armCheckInTimer(ci);
    }
    this.logger.info("rearmed worker", {
      workerId: worker.id,
      turns: c.turns,
      offset: streamOffsetBytes,
    });
  }

  // ── Supervisor: check-in scheduling (Spec 03 §3) ─────────────────────────────────────

  /**
   * Arm a check-in Opus scheduled (Spec 03 §3.1/§3.3). Persists FIRST for durability, then
   * arms the timer/turn-poll. One pending check-in per worker: scheduling a new one
   * supersedes the prior (Spec 03 §3.3) so they never pile up.
   */
  scheduleCheckIn(checkIn: CheckIn): void {
    this.supersedePending(checkIn.workerId, checkIn.id);
    // Persist first (durability) — store.insertCheckIn also emits supervise.checkin_scheduled.
    this.store.insertCheckIn(this.checkInToRow(checkIn));
    this.pendingCheckIns.set(checkIn.id, checkIn);
    this.armCheckInTimer(checkIn);
    this.logger.debug("check-in scheduled", {
      checkInId: checkIn.id,
      workerId: checkIn.workerId,
      trigger: checkIn.trigger,
    });
  }

  // ── subscriptions ────────────────────────────────────────────────────────────────────

  /** Subscribe to fired smoke-alarms (the Orchestrator pulls Opus in to look). */
  onAlarm(cb: AlarmCb): () => void {
    this.alarmSubs.add(cb);
    return () => this.alarmSubs.delete(cb);
  }

  /**
   * Subscribe to fired check-ins. NOT part of the frozen {@link Supervisor} interface (which
   * exposes only `onAlarm`); a fired check-in is the second "go look" trigger (Spec 03 §3) and
   * the daemon — which wires the concrete impls — subscribes here. See the contract gap note in
   * the module report.
   */
  onCheckInFired(cb: CheckInCb): () => void {
    this.checkInSubs.add(cb);
    return () => this.checkInSubs.delete(cb);
  }

  /** Clear all timers (shutdown hygiene). Counters are left for a final flush by the caller. */
  stop(): void {
    for (const t of this.checkInTimers.values()) clearTimeout(t);
    for (const t of this.staleTimers.values()) clearTimeout(t);
    this.checkInTimers.clear();
    this.staleTimers.clear();
  }

  // ── internals: counters ──────────────────────────────────────────────────────────────

  private initCounters(worker: Worker): WorkerCounters {
    return {
      workerId: worker.id,
      nodeId: worker.nodeId,
      harness: worker.harness,
      turns: 0,
      toolCalls: 0,
      lastActivityTs: worker.lastActivityTs || worker.spawnedAt || Date.now(),
      lastTurnEndTs: 0,
      diffTotal: 0,
      filesChanged: 0,
      turnsSinceDiffProgress: 0,
      repeatedToolCallRun: 0,
      lastToolSig: null,
      lastToolTokens: null,
      scopeViolations: 0,
      blockedFlag: false,
      errorFlag: false,
      streamOffsetBytes: 0,
      envelope: worker.resourceEnvelope,
      startTs: worker.spawnedAt || Date.now(),
    };
  }

  /** Update the repeated-tool-call run-length from a fresh tool call (Spec 03 §1.4). */
  private onToolCall(c: WorkerCounters, tool: string, input: unknown): void {
    c.toolCalls += 1;
    const sig = toolSignature(tool, input);
    const tokens = argTokens(tool, input);
    if (
      c.lastToolSig !== null &&
      nearIdentical(sig, tokens, c.lastToolSig, c.lastToolTokens ?? new Set(), this.thresholds.repeatedJaccard)
    ) {
      c.repeatedToolCallRun += 1;
    } else {
      c.repeatedToolCallRun = 1;
    }
    c.lastToolSig = sig;
    c.lastToolTokens = tokens;
  }

  /**
   * Sample diff progress at a turn boundary from the driver's authoritative
   * {@link Worker.spend} (Spec 03 §1.4: numstat sampled at turn end). Resets the no-progress
   * counter when the diff grew by ≥ the min-progress threshold; otherwise increments it (A1).
   */
  private sampleDiff(c: WorkerCounters, worker: Worker): void {
    const cur = worker.spend.diffLines.added + worker.spend.diffLines.removed;
    c.filesChanged = worker.spend.diffLines.files;
    if (cur - c.diffTotal >= this.thresholds.noDiffMinProgressLines) {
      c.diffTotal = cur;
      c.turnsSinceDiffProgress = 0;
    } else {
      c.turnsSinceDiffProgress += 1;
    }
  }

  /**
   * Persist counters at a turn boundary (Spec 03 §1.3: persist on change → a restart loses ≤
   * the in-flight turn). Telemetry is sourced from the driver's {@link Worker.spend} (the
   * authoritative tokens/diff/usd), tagged with the observer's last-activity + stream offset.
   */
  private persistTelemetry(worker: Worker, c: WorkerCounters): void {
    try {
      this.store.updateWorkerTelemetry(worker.id, worker.spend, c.lastActivityTs, c.streamOffsetBytes);
    } catch (err) {
      // Persistence is best-effort on the hot path; never let it stall observation.
      this.logger.warn("telemetry persist failed", {
        workerId: worker.id,
        error: (err as Error).message,
      });
    }
  }

  // ── internals: alarms ────────────────────────────────────────────────────────────────

  private fireAlarms(worker: Worker, c: WorkerCounters, now: number): void {
    const alarms = this.engine.evaluate(c, now);
    for (const alarm of alarms) this.emitAlarm(alarm, worker);
  }

  private emitAlarm(alarm: SmokeAlarm, worker: Worker): void {
    try {
      this.store.appendEvent({
        type: "supervise.smoke_alarm",
        worker_id: worker.id,
        node_id: worker.nodeId,
        task_id: worker.taskId,
        user_id: worker.userId,
        payload: { kind: alarm.kind, detail: alarm.detail, dedupeKey: alarm.dedupeKey },
      });
    } catch (err) {
      this.logger.warn("smoke_alarm persist failed", {
        workerId: worker.id,
        error: (err as Error).message,
      });
    }
    this.logger.info("smoke-alarm", { kind: alarm.kind, workerId: worker.id, detail: alarm.detail });
    for (const cb of this.alarmSubs) {
      try {
        cb(alarm, worker);
      } catch (err) {
        this.logger.error("alarm subscriber threw", { error: (err as Error).message });
      }
    }
  }

  // ── internals: staleness timer (A6) ──────────────────────────────────────────────────

  /** (Re)arm the per-worker staleness timer; fires a worker_blocked(stale) look on silence. */
  private armStaleTimer(worker: Worker, c: WorkerCounters): void {
    const prev = this.staleTimers.get(worker.id);
    if (prev) clearTimeout(prev);
    if (this.thresholds.staleMs <= 0) return;
    const timer = setTimeout(() => this.onStale(worker.id), this.thresholds.staleMs);
    if (typeof timer.unref === "function") timer.unref();
    this.staleTimers.set(worker.id, timer);
  }

  private onStale(workerId: string): void {
    const worker = this.workers.get(workerId);
    const c = this.counters.get(workerId);
    if (!worker || !c) return;
    // Paused/terminal workers legitimately go quiet — don't trip stale on them (Spec 03 §5.2).
    if (WORKER_TERMINAL.has(worker.state) || worker.state === "paused") return;
    this.fireAlarms(worker, c, Date.now());
  }

  // ── internals: check-in scheduler (Spec 03 §3.2) ─────────────────────────────────────

  /** Arm a time-trigger timer for a check-in; turn-trigger ones are polled in checkOnTurn. */
  private armCheckInTimer(c: CheckIn): void {
    let fireAt = c.fireAt;
    if (fireAt == null && c.trigger.afterSecs != null) {
      fireAt = c.createdAt + c.trigger.afterSecs * 1000;
    }
    if (fireAt == null) return; // pure turn-trigger
    const delay = Math.max(0, fireAt - Date.now());
    const timer = setTimeout(() => this.fireCheckIn(c.id), delay);
    if (typeof timer.unref === "function") timer.unref();
    this.checkInTimers.set(c.id, timer);
  }

  /** Poll turn-trigger check-ins for a worker when its turn count advances (Spec 03 §3.2). */
  private checkOnTurn(worker: Worker, turns: number): void {
    for (const c of this.pendingCheckIns.values()) {
      if (c.workerId !== worker.id) continue;
      const target = c.trigger.atTurnAbs ?? c.turnsAtCreate + (c.trigger.afterTurns ?? Infinity);
      if (turns >= target) this.fireCheckIn(c.id);
    }
  }

  /** Fire a check-in once: mark fired, clear its timer, emit the "look now" signal (Spec 03 §3.2). */
  private fireCheckIn(id: string): void {
    const c = this.pendingCheckIns.get(id);
    if (!c) return; // already fired/superseded
    this.pendingCheckIns.delete(id);
    const timer = this.checkInTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.checkInTimers.delete(id);
    }
    try {
      this.store.setCheckInState(id, "fired");
      this.store.appendEvent({
        type: "supervise.checkin_fired",
        worker_id: c.workerId,
        node_id: c.nodeId,
        payload: { checkInId: id, reason: c.reason },
      });
    } catch (err) {
      this.logger.warn("checkin_fired persist failed", { checkInId: id, error: (err as Error).message });
    }
    const worker = this.workers.get(c.workerId);
    if (!worker) {
      this.logger.warn("check-in fired with no live worker handle", { checkInId: id, workerId: c.workerId });
      return;
    }
    this.logger.info("check-in fired", { checkInId: id, workerId: c.workerId, reason: c.reason });
    for (const cb of this.checkInSubs) {
      try {
        cb(c, worker);
      } catch (err) {
        this.logger.error("check-in subscriber threw", { error: (err as Error).message });
      }
    }
  }

  /** Supersede any other pending check-ins for a worker (Spec 03 §3.3). */
  private supersedePending(workerId: string, exceptId: string): void {
    for (const c of [...this.pendingCheckIns.values()]) {
      if (c.workerId !== workerId || c.id === exceptId) continue;
      this.pendingCheckIns.delete(c.id);
      const timer = this.checkInTimers.get(c.id);
      if (timer) {
        clearTimeout(timer);
        this.checkInTimers.delete(c.id);
      }
      try {
        this.store.setCheckInState(c.id, "superseded");
      } catch (err) {
        this.logger.warn("supersede persist failed", { checkInId: c.id, error: (err as Error).message });
      }
    }
  }

  /** Tear down a worker's observation once it reaches a terminal state (driver `finished`). */
  private onWorkerTerminal(worker: Worker): void {
    const staleTimer = this.staleTimers.get(worker.id);
    if (staleTimer) {
      clearTimeout(staleTimer);
      this.staleTimers.delete(worker.id);
    }
    // Cancel any still-pending check-ins — there's nothing left to look at.
    for (const c of [...this.pendingCheckIns.values()]) {
      if (c.workerId !== worker.id) continue;
      this.pendingCheckIns.delete(c.id);
      const t = this.checkInTimers.get(c.id);
      if (t) {
        clearTimeout(t);
        this.checkInTimers.delete(c.id);
      }
      try {
        this.store.setCheckInState(c.id, "cancelled");
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ── internals: CheckIn ⇄ CheckInRow mapping (Spec 09 §2.8) ────────────────────────────

  private checkInToRow(c: CheckIn): CheckInRow {
    const fireAt =
      c.fireAt ??
      (c.trigger.afterSecs != null ? c.createdAt + c.trigger.afterSecs * 1000 : null);
    return {
      id: c.id,
      worker_id: c.workerId,
      node_id: c.nodeId,
      created_by_decision_id: c.createdByDecisionId || null,
      after_turns: c.trigger.afterTurns ?? null,
      after_secs: c.trigger.afterSecs ?? null,
      at_turn_abs: c.trigger.atTurnAbs ?? null,
      turns_at_create: c.turnsAtCreate,
      fire_at: fireAt,
      reason: c.reason,
      state: c.state,
      created_at: c.createdAt,
    };
  }

  private checkInFromRow(r: CheckInRow): CheckIn {
    return {
      id: r.id,
      workerId: r.worker_id,
      nodeId: r.node_id,
      createdByDecisionId: r.created_by_decision_id ?? "",
      createdAt: r.created_at,
      trigger: {
        afterTurns: r.after_turns ?? undefined,
        afterSecs: r.after_secs ?? undefined,
        atTurnAbs: r.at_turn_abs ?? undefined,
      },
      turnsAtCreate: r.turns_at_create,
      fireAt: r.fire_at ?? undefined,
      reason: r.reason,
      state: r.state,
    };
  }
}

/** Compile-time check: the Tailer satisfies the frozen Supervisor contract. */
const _supervisorCheck: new (s: Store, c: Config, l?: Logger) => Supervisor = Tailer;
void _supervisorCheck;
