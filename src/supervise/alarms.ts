/**
 * Beckett — smoke-alarms (`src/supervise/alarms.ts`)
 * =======================================================================================
 * The cheap, mechanical drift signals of the control plane (Spec 03 §2). A smoke-alarm is a
 * **pure function over the per-worker counters** ({@link WorkerCounters}, owned by
 * `./tailer.ts`). When a predicate flips false→true it produces a {@link SmokeAlarm}, which
 * the {@link Tailer} hands UP to the Brain/Orchestrator to *go look*.
 *
 * Canon (Spec 03 §2): **a smoke-alarm is never a verdict.** It is a prompt to think — the gap
 * between "alarm" and "decision" is the whole product (Spec 03 §7). Nothing here ever kills,
 * pauses, or nudges a worker. It only decides *whether a look is worth waking Opus for*, and
 * applies the debounce/dedupe that protects the expensive head from alarm-storms (Spec 03 §2.3).
 *
 * v0 scope: the five canonical alarm kinds (Spec 03 §2.1, the `SmokeAlarmKind` union):
 *   no_diff_progress · over_envelope · repeated_tool_calls · scope_violation · worker_blocked
 * (`worker_blocked` folds in the staleness sub-kind A6, Spec 03 §2.2).
 *
 * Contract note: the frozen `Config.supervise` block (Spec 01 §4) exposes only
 * `drift_no_progress_turns`, `repeated_tool_calls_n`, `overrun_factor`, `checkin_default_s`,
 * `tail_mode`. The finer §8 tuning knobs (min-progress, stale, cooldown, wall-factor) are NOT
 * in the frozen config, so they live here as documented module defaults ({@link ALARM_DEFAULTS}).
 * If they later graduate to config, derive them in {@link deriveThresholds}.
 */

import type { Config, SmokeAlarm, SmokeAlarmKind } from "../types.ts";
import type { WorkerCounters } from "./tailer.ts";

// =======================================================================================
// Thresholds
// =======================================================================================

/**
 * Tuning knobs that are NOT in the frozen `Config.supervise` block but are required by the
 * Spec 03 §8 alarm definitions. First-guess constants (Spec 03 §9 flags them for calibration).
 */
export const ALARM_DEFAULTS = {
  /** A1: minimum diff growth (in changed lines) per turn that counts as "progress". */
  noDiffMinProgressLines: 1,
  /** A3: arg-token Jaccard similarity above which two tool calls are "near-identical". */
  repeatedToolJaccard: 0.9,
  /** A6: seconds of total silence before a worker is treated as stale → worker_blocked. */
  staleSecs: 180,
  /** §2.3: per-(kind,worker) cooldown before an alarm of the same kind may re-fire. */
  alarmCooldownSecs: 120,
} as const;

/** The resolved numeric thresholds an {@link AlarmEngine} evaluates against. */
export interface AlarmThresholds {
  /** A1 `K`: turns of no meaningful diff before `no_diff_progress` fires. */
  noDiffK: number;
  /** A1: line delta that counts as diff progress. */
  noDiffMinProgressLines: number;
  /** A3 `N`: run-length of near-identical tool calls before `repeated_tool_calls` fires. */
  repeatedN: number;
  /** A3: arg-similarity threshold for "near-identical". */
  repeatedJaccard: number;
  /** A2: turns/wall-clock over `estimate × factor` fires `over_envelope` (turns + wall). */
  overrunFactor: number;
  /** A6: silence (ms) before `worker_blocked(stale)` fires. */
  staleMs: number;
  /** §2.3: per-(kind,worker) re-fire cooldown (ms). */
  cooldownMs: number;
}

/**
 * Build the alarm thresholds from the frozen `Config.supervise` knobs + {@link ALARM_DEFAULTS}.
 * `overrun_factor` is reused for BOTH the turn and wall-clock arms of A2 (the frozen config
 * has a single overrun knob, unlike Spec 03 §8's split over_turn/over_wall factors).
 */
export function deriveThresholds(config: Config): AlarmThresholds {
  const s = config.supervise;
  return {
    noDiffK: s.drift_no_progress_turns,
    noDiffMinProgressLines: ALARM_DEFAULTS.noDiffMinProgressLines,
    repeatedN: s.repeated_tool_calls_n,
    repeatedJaccard: ALARM_DEFAULTS.repeatedToolJaccard,
    overrunFactor: s.overrun_factor,
    staleMs: ALARM_DEFAULTS.staleSecs * 1000,
    cooldownMs: ALARM_DEFAULTS.alarmCooldownSecs * 1000,
  };
}

// =======================================================================================
// Tool-call fingerprinting (drives A3 `repeated_tool_calls`)
// =======================================================================================

/** Volatile arg keys stripped before fingerprinting so "same call" isn't masked by noise. */
const VOLATILE_ARG_KEYS = new Set([
  "timestamp",
  "ts",
  "time",
  "offset",
  "line",
  "line_offset",
  "lineoffset",
  "limit",
  "id",
  "request_id",
  "requestid",
]);

/** Stable, order-independent JSON of a tool's input with volatile fields stripped + lowercased. */
function normalizeArgs(input: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      return typeof v === "string" ? v.toLowerCase() : v;
    }
    if (seen.has(v as object)) return null; // cycle guard
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (VOLATILE_ARG_KEYS.has(key.toLowerCase())) continue;
      out[key] = walk(obj[key]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(input)) ?? "";
  } catch {
    return ""; // non-serializable input → empty signature (still comparable)
  }
}

/** A stable fingerprint of `(toolName, normalizedArgs)` (Spec 03 §1.4). */
export function toolSignature(tool: string, input: unknown): string {
  return `${tool}::${normalizeArgs(input)}`;
}

/** Lowercased word-ish tokens of a tool call's args, for the Jaccard fallback (Spec 03 §1.4). */
export function argTokens(tool: string, input: unknown): Set<string> {
  const text = `${tool} ${normalizeArgs(input)}`;
  const tokens = text.toLowerCase().match(/[a-z0-9_./-]+/g);
  return new Set(tokens ?? []);
}

/** Jaccard similarity of two token sets (|∩| / |∪|). Empty/empty = 1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Two consecutive tool calls are "near-identical" if their fingerprints match OR their arg
 * token sets are ≥ the Jaccard threshold similar (Spec 03 §1.4). Drives `repeatedToolCallRun`.
 */
export function nearIdentical(
  sigA: string,
  tokensA: Set<string>,
  sigB: string,
  tokensB: Set<string>,
  jaccardThreshold: number,
): boolean {
  if (sigA === sigB) return true;
  return jaccard(tokensA, tokensB) >= jaccardThreshold;
}

// =======================================================================================
// Alarm predicates (pure over counters)
// =======================================================================================

/** A candidate alarm produced by a predicate, before debounce/dedupe (Spec 03 §2). */
interface AlarmCandidate {
  kind: SmokeAlarmKind;
  detail: Record<string, number | string>;
  /** Monotonic severity for this kind; a higher value bypasses the cooldown (Spec 03 §2.3). */
  severity: number;
}

/**
 * Evaluate ALL five predicates against the current counters (Spec 03 §2.1). Pure — returns the
 * raw candidates that are currently true; the {@link AlarmEngine} applies cooldown/dedupe.
 */
export function detectAlarms(
  c: WorkerCounters,
  t: AlarmThresholds,
  now: number,
): AlarmCandidate[] {
  const out: AlarmCandidate[] = [];

  // ── A1 no_diff_progress: K turns elapsed with no meaningful diff growth ───────────────
  if (c.turnsSinceDiffProgress >= t.noDiffK) {
    out.push({
      kind: "no_diff_progress",
      detail: {
        turnsSinceProgress: c.turnsSinceDiffProgress,
        K: t.noDiffK,
        diffLines: c.diffTotal,
      },
      severity: Math.floor(c.turnsSinceDiffProgress / Math.max(1, t.noDiffK)),
    });
  }

  // ── A2 over_envelope: turns OR wall-clock over the node estimate × factor ─────────────
  const turnBudget = c.envelope.turnCap * t.overrunFactor;
  const wallBudgetMs = c.envelope.wallClockS * t.overrunFactor * 1000;
  const elapsedMs = now - c.startTs;
  const turnRatio = turnBudget > 0 ? c.turns / turnBudget : 0;
  const wallRatio = wallBudgetMs > 0 ? elapsedMs / wallBudgetMs : 0;
  if (turnRatio >= 1 || wallRatio >= 1) {
    out.push({
      kind: "over_envelope",
      detail: {
        turns: c.turns,
        turnCap: c.envelope.turnCap,
        elapsedSecs: Math.round(elapsedMs / 1000),
        wallClockS: c.envelope.wallClockS,
        factor: t.overrunFactor,
        over: turnRatio >= wallRatio ? "turns" : "wall_clock",
      },
      severity: Math.max(1, Math.floor(Math.max(turnRatio, wallRatio))),
    });
  }

  // ── A3 repeated_tool_calls: run of N near-identical consecutive calls ─────────────────
  if (c.repeatedToolCallRun >= t.repeatedN) {
    out.push({
      kind: "repeated_tool_calls",
      detail: {
        run: c.repeatedToolCallRun,
        N: t.repeatedN,
        tool: c.lastToolSig ?? "",
      },
      severity: Math.floor(c.repeatedToolCallRun / Math.max(1, t.repeatedN)),
    });
  }

  // ── A4 scope_violation: a hook/sandbox denied an out-of-scope write (Δ ≥ 1) ───────────
  if (c.scopeViolations > 0) {
    out.push({
      kind: "scope_violation",
      detail: { violations: c.scopeViolations },
      severity: c.scopeViolations,
    });
  }

  // ── A5/A6 worker_blocked: errored, explicitly blocked, OR stale (silent > staleMs) ────
  const idleMs = now - c.lastActivityTs;
  const stale = t.staleMs > 0 && idleMs > t.staleMs;
  if (c.errorFlag || c.blockedFlag || stale) {
    const reason = c.errorFlag ? "error" : c.blockedFlag ? "blocked" : "stale";
    out.push({
      kind: "worker_blocked",
      detail: { reason, idleSecs: Math.round(idleMs / 1000) },
      severity: 1,
    });
  }

  return out;
}

// =======================================================================================
// AlarmEngine — debounce + dedupe over the raw candidates (Spec 03 §2.3)
// =======================================================================================

interface KindState {
  lastFiredAt: number;
  lastSeverity: number;
}

/**
 * Stateful gate in front of {@link detectAlarms}. Holds per-(kind,worker) cooldown state so a
 * tripped predicate doesn't wake Opus on every subsequent event (Spec 03 §2.3). An alarm
 * re-fires only after its cooldown OR when its severity strictly escalates (e.g. K crossed
 * again at 2×K). Cross-worker / look coalescing is the orchestrator's concern (Spec 03 §2.3).
 */
export class AlarmEngine {
  /** key = `${kind}:${workerId}` → cooldown state. */
  private state = new Map<string, KindState>();

  constructor(private readonly thresholds: AlarmThresholds) {}

  /**
   * Evaluate the current counters and return the alarms that should fire *now* (post-dedupe).
   * Each returned {@link SmokeAlarm} carries the `dedupeKey` from Spec 03 §2.3
   * (`kind:workerId:floor(elapsed/cooldown)`), so identical fires in one window collapse.
   */
  evaluate(c: WorkerCounters, now: number): SmokeAlarm[] {
    const fired: SmokeAlarm[] = [];
    for (const cand of detectAlarms(c, this.thresholds, now)) {
      if (!this.shouldFire(cand.kind, c.workerId, now, cand.severity)) continue;
      const bucket = Math.floor((now - c.startTs) / this.thresholds.cooldownMs);
      fired.push({
        kind: cand.kind,
        workerId: c.workerId,
        nodeId: c.nodeId,
        firedAt: now,
        detail: cand.detail,
        dedupeKey: `${cand.kind}:${c.workerId}:${bucket}`,
      });
    }
    return fired;
  }

  /** Drop all cooldown state for a worker (on rearm/recovery or terminal reap). */
  reset(workerId: string): void {
    for (const key of [...this.state.keys()]) {
      if (key.endsWith(`:${workerId}`)) this.state.delete(key);
    }
  }

  /** Cooldown + severity-escalation gate (Spec 03 §2.3 `shouldFireLook`). */
  private shouldFire(
    kind: SmokeAlarmKind,
    workerId: string,
    now: number,
    severity: number,
  ): boolean {
    const key = `${kind}:${workerId}`;
    const prev = this.state.get(key);
    const cooled = !prev || now - prev.lastFiredAt >= this.thresholds.cooldownMs;
    const escalated = prev !== undefined && severity > prev.lastSeverity;
    if (!cooled && !escalated) return false;
    this.state.set(key, {
      lastFiredAt: now,
      lastSeverity: Math.max(severity, prev?.lastSeverity ?? 0),
    });
    return true;
  }
}
