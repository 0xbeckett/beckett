import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(seedBuiltins = true): { path: string; store: RoutineStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  return { path, store: new RoutineStore(path, { seedBuiltins }) };
}

test("seeds the built-in daily-x-shitpost on first load", async () => {
  const { store } = makeStore();
  const routines = await store.list();
  const x = routines.find((r) => r.id === "daily-x-shitpost");
  expect(x).toBeTruthy();
  expect(x!.builtin).toBe(true);
  expect(x!.action.kind).toBe("x-shitpost");
  expect(x!.schedule.window).toEqual({ start: "12:00", end: "13:00", tz: "America/Los_Angeles" });
  if (x!.action.kind === "x-shitpost") {
    expect(x!.action.account).toBe("@beckposting");
    expect(x!.action.credsEntry).toBe("x.com");
  }
});

test("definitions and chosen fire time persist and restore across a new store", async () => {
  const { path, store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:23:00.000Z",
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });

  // A fresh store (simulating a daemon restart) reads the same chosen time back.
  const restored = new RoutineStore(path, { seedBuiltins: true });
  const routine = await restored.get("daily-x-shitpost");
  expect(routine!.state.periodKey).toBe("2026-07-20");
  expect(routine!.state.chosenFireAt).toBe("2026-07-20T19:23:00.000Z");
});

test("add/inspect/remove a user routine", async () => {
  const { store } = makeStore(false);
  const added = await store.add({
    id: "hourly-check",
    name: "hourly check",
    enabled: true,
    action: { kind: "browser", task: "check the thing" },
    schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "America/New_York" } },
  });
  expect(added.builtin).toBe(false);
  expect((await store.get("hourly-check"))!.action.kind).toBe("browser");
  await expect(store.add({ ...added } as never)).rejects.toThrow(/already exists/);

  expect(await store.remove("hourly-check")).toBe(true);
  expect(await store.get("hourly-check")).toBeNull();
});

test("removing a built-in sticks across a restart (not re-seeded)", async () => {
  const { path, store } = makeStore();
  expect(await store.remove("daily-x-shitpost")).toBe(true);
  const restored = new RoutineStore(path, { seedBuiltins: true });
  expect(await restored.get("daily-x-shitpost")).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).removedBuiltins).toContain("daily-x-shitpost");
});
