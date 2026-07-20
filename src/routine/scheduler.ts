/**
 * Beckett — Routine scheduler (`src/routine/scheduler.ts`)
 * =======================================================================================
 * The daemon hook that fires routines (issue #62). Modeled on `startRoutineMaintenance`
 * ({@link ../memory/maintain.ts}): a self-scheduling `setInterval` whose failures are logged
 * and swallowed so a broken routine never takes the daemon down. Wired in `boot()`.
 *
 * Each tick, for every enabled routine, it re-reads the store (single source of truth) and:
 *
 *   1. **Rolls** a concrete fire time if the current period has no chosen time yet — and
 *      persists it. A restart mid-window sees `state.periodKey` already equal to the current
 *      period, so it does NOT re-roll (the day's time is stable across restarts).
 *   2. **Fires** when now ≥ the chosen time and this period hasn't fired. Firing is idempotent
 *      per period: it CLAIMS the period (writes `lastFiredPeriodKey` + persists) BEFORE
 *      dispatching, so a crash mid-dispatch can never double-post.
 *
 * Dispatch runs OFF this process: the injected `dispatch` executor hands the plan to the
 * `beckett browser` background lane. The scheduler never blocks on browser work.
 */

import type { Logger } from "../types.ts";
import type { RoutineStore } from "./store.ts";
import type { Routine } from "./types.ts";
import { periodKey, rollFireTime } from "./schedule.ts";
import { buildDispatchPlan, type RoutineDispatchPlan } from "./plan.ts";

/** Default tick cadence — 30s keeps the fired minute within half a minute of the chosen time. */
export const ROUTINE_TICK_MS = 30_000;

export interface RoutineDispatcher {
  /** Execute a plan through the background lane. Resolves once the lane has TAKEN the work. */
  dispatch(plan: RoutineDispatchPlan, routine: Routine): Promise<void>;
}

export interface RoutineSchedulerDeps {
  store: RoutineStore;
  dispatcher: RoutineDispatcher;
  logger: Logger;
  /** Injectable clock + RNG so schedule/compose behavior is deterministic in tests. */
  now?: () => Date;
  rng?: () => number;
  intervalMs?: number;
}

export interface RoutineScheduler {
  /** One scheduling pass over all routines (exposed for tests + boot priming). */
  tick(): Promise<void>;
  /** Fire one routine now. `force` bypasses the schedule; `dryRun` builds+returns the plan only. */
  fireNow(id: string, opts?: { force?: boolean; dryRun?: boolean }): Promise<RoutineDispatchPlan>;
  stop(): void;
}

export function startRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const interval = deps.intervalMs ?? ROUTINE_TICK_MS;

  async function evaluate(routine: Routine): Promise<void> {
    if (!routine.enabled) return;
    const at = now();
    const key = periodKey(routine.schedule.cadence, routine.schedule.window, at);
    let state = routine.state;

    // 1. New period → roll a fresh fire time and persist. Same period → keep the chosen time
    //    (restart-safe: never re-roll a day that's already been rolled).
    if (state.periodKey !== key || !state.chosenFireAt) {
      const chosen = rollFireTime(routine.schedule, key, rng);
      state = { ...state, periodKey: key, chosenFireAt: chosen.toISOString() };
      await deps.store.setState(routine.id, state);
      deps.logger.info("routine period rolled", { id: routine.id, period: key, fireAt: state.chosenFireAt });
    }

    // 2. Fire once per period, at/after the chosen time.
    if (state.lastFiredPeriodKey === key) return;
    if (!state.chosenFireAt || at.getTime() < new Date(state.chosenFireAt).getTime()) return;

    // Claim the period BEFORE dispatching so a crash mid-dispatch never double-fires.
    const claimed = { ...state, lastFiredPeriodKey: key, lastFiredAt: at.toISOString() };
    await deps.store.setState(routine.id, claimed);
    const plan = buildDispatchPlan(routine);
    deps.logger.info("routine firing", { id: routine.id, period: key, preview: plan.preview });
    try {
      await deps.dispatcher.dispatch(plan, routine);
    } catch (err) {
      // The period stays claimed (no double-fire); surface the failure for the operator.
      deps.logger.warn("routine dispatch failed", { id: routine.id, period: key, error: String(err) });
    }
  }

  async function tick(): Promise<void> {
    let routines: Routine[];
    try {
      routines = await deps.store.list();
    } catch (err) {
      deps.logger.warn("routine tick could not read the store", { error: String(err) });
      return;
    }
    for (const routine of routines) {
      try {
        await evaluate(routine);
      } catch (err) {
        deps.logger.warn("routine evaluation failed", { id: routine.id, error: String(err) });
      }
    }
  }

  async function fireNow(id: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<RoutineDispatchPlan> {
    const routine = await deps.store.get(id);
    if (!routine) throw new Error(`no such routine: ${id}`);
    const plan = buildDispatchPlan(routine);
    if (opts.dryRun) return plan;
    if (!opts.force) {
      // Non-forced manual fire still respects per-period idempotency.
      const key = periodKey(routine.schedule.cadence, routine.schedule.window, now());
      if (routine.state.lastFiredPeriodKey === key) {
        throw new Error(`routine ${id} already fired this period (${key}); use --force to fire again`);
      }
      await deps.store.setState(id, {
        ...routine.state,
        lastFiredPeriodKey: key,
        lastFiredAt: now().toISOString(),
      });
    }
    await deps.dispatcher.dispatch(plan, routine);
    return plan;
  }

  const timer = setInterval(() => void tick().catch(() => {}), interval);
  timer.unref?.();

  return {
    tick,
    fireNow,
    stop() {
      clearInterval(timer);
    },
  };
}
