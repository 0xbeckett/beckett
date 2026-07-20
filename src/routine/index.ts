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
export { RoutineStore, type RoutineStoreOptions } from "./store.ts";
export {
  startRoutineScheduler,
  ROUTINE_TICK_MS,
  type RoutineScheduler,
  type RoutineSchedulerDeps,
  type RoutineDispatcher,
} from "./scheduler.ts";
