/**
 * Beckett — Routines (`src/routine/index.ts`)
 * =======================================================================================
 * Named, recurring scheduled tasks with HUMANIZED fire times (issue #62). Public surface for
 * the daemon (`boot()`), the CLI (`beckett routine`), and tests.
 */

export * from "./types.ts";
export * from "./schedule.ts";
export * from "./plan.ts";
export * from "./builtins.ts";
export * from "./model-news.ts";
export * from "./rate-limit.ts";
export { WatchStateStore, type WatchStateStoreOptions, type WatchRoutineState } from "./watch-store.ts";
export {
  runWatchCycle,
  previewWatchCycle,
  startWatchLoop,
  buildAgentSubject,
  WATCH_LOOP_TICK_MS,
  type WatchDeps,
  type WatchCycleResult,
  type WatchPreview,
  type WatchLoop,
  type WatchLoopDeps,
} from "./watch.ts";
export { RoutineStore, type RoutineStoreOptions } from "./store.ts";
export {
  startRoutineScheduler,
  ROUTINE_TICK_MS,
  type RoutineScheduler,
  type RoutineSchedulerDeps,
  type RoutineDispatcher,
} from "./scheduler.ts";
