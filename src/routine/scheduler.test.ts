import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.ts";
import { startRoutineScheduler, type RoutineDispatcher } from "./scheduler.ts";
import type { RoutineDispatchPlan } from "./plan.ts";
import { quietLogger } from "../cli/io.ts";

const dirs: string[] = [];
const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { path: string; store: RoutineStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routine-sched-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  return { path, store: new RoutineStore(path) };
}

function recorder(): { dispatcher: RoutineDispatcher; calls: RoutineDispatchPlan[] } {
  const calls: RoutineDispatchPlan[] = [];
  return { calls, dispatcher: { async dispatch(plan) { calls.push(plan); } } };
}

// 2026-07-20 12:30 PT (inside the 12:00–13:00 window) = 19:30Z.
const INSIDE = new Date("2026-07-20T19:30:00.000Z");

test("fires exactly once per period (idempotent) and delegates dispatch off-process", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => INSIDE,
    rng: () => 0, // rolls the window start (19:00Z), which is < now → due
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();

  // One dispatch total across three ticks — idempotent per period.
  expect(calls.length).toBe(1);
  expect(calls[0]!.routineId).toBe("daily-x-shitpost");
  expect(calls[0]!.credsEntry).toBe("x.com");
  // The period is claimed on disk.
  const state = (await store.get("daily-x-shitpost"))!.state;
  expect(state.lastFiredPeriodKey).toBe("2026-07-20");
});

test("a restart inside the window neither re-rolls the chosen time nor double-fires", async () => {
  const { path, store } = makeStore();
  // Pre-roll a concrete time for today, unfired — as if a prior daemon rolled it before crashing.
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:20:00.000Z",
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });

  // New scheduler (the restart). A different RNG that WOULD roll a later minute if it re-rolled.
  const restarted = new RoutineStore(path);
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store: restarted,
    dispatcher,
    logger: quietLogger,
    now: () => INSIDE,
    rng: () => 0.95,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();

  const state = (await restarted.get("daily-x-shitpost"))!.state;
  expect(state.chosenFireAt).toBe("2026-07-20T19:20:00.000Z"); // NOT re-rolled
  expect(calls.length).toBe(1); // caught up and fired once

  // A second restart after firing must not double-fire.
  const second = new RoutineStore(path);
  const rec2 = recorder();
  const sched2 = startRoutineScheduler({
    store: second, dispatcher: rec2.dispatcher, logger: quietLogger,
    now: () => INSIDE, rng: () => 0.95, intervalMs: 10_000_000,
  });
  stoppers.push(sched2.stop);
  await sched2.tick();
  expect(rec2.calls.length).toBe(0);
});

test("does not fire before the chosen time", async () => {
  const { store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:45:00.000Z", // 12:45 PT, after our 12:30 now
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await scheduler.tick();
  expect(calls.length).toBe(0);
});

test("fireNow dry-run returns the plan WITHOUT dispatching (no live post)", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  const plan = await scheduler.fireNow("daily-x-shitpost", { dryRun: true });
  // The built-in routine now drives the social-media agent (one path): the plan carries the
  // invocation, not a composed post — the agent AUTHORS the browser task live at fire time.
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe("social-media");
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBe("x.com");
  expect(calls.length).toBe(0); // dry-run never dispatches
});

test("fireNow --force dispatches even when already fired this period", async () => {
  const { store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:00:00.000Z",
    lastFiredPeriodKey: "2026-07-20", // already fired today
    lastFiredAt: INSIDE.toISOString(),
  });
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await expect(scheduler.fireNow("daily-x-shitpost", {})).rejects.toThrow(/already fired/);
  await scheduler.fireNow("daily-x-shitpost", { force: true });
  expect(calls.length).toBe(1);
});
