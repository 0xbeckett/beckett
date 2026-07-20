import { expect, test, describe } from "bun:test";
import {
  isValidTimeZone,
  localDateKey,
  periodKey,
  rollFireTime,
  windowBounds,
  zonedWallToUtc,
} from "./schedule.ts";
import { seededRng } from "./schedule.ts";
import type { Schedule } from "./types.ts";

const PT = "America/Los_Angeles";
const schedule: Schedule = {
  cadence: { kind: "daily" },
  window: { start: "12:00", end: "13:00", tz: PT },
};

describe("timezone math", () => {
  test("isValidTimeZone accepts IANA, rejects junk", () => {
    expect(isValidTimeZone(PT)).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  test("zonedWallToUtc resolves PDT (summer, UTC-7)", () => {
    // 2026-07-20 12:00 PT is 19:00 UTC in July (daylight time).
    const inst = zonedWallToUtc(PT, 2026, 7, 20, 12, 0);
    expect(inst.toISOString()).toBe("2026-07-20T19:00:00.000Z");
  });

  test("zonedWallToUtc resolves PST (winter, UTC-8)", () => {
    // 2026-01-20 12:00 PT is 20:00 UTC in January (standard time).
    const inst = zonedWallToUtc(PT, 2026, 1, 20, 12, 0);
    expect(inst.toISOString()).toBe("2026-01-20T20:00:00.000Z");
  });

  test("localDateKey / periodKey give the tz-local date", () => {
    // 2026-07-20T06:30Z is still 2026-07-19 23:30 in PT.
    const at = new Date("2026-07-20T06:30:00.000Z");
    expect(localDateKey(PT, at)).toBe("2026-07-19");
    expect(periodKey(schedule.cadence, schedule.window, at)).toBe("2026-07-19");
  });

  test("windowBounds spans exactly the window", () => {
    const { start, end } = windowBounds(schedule.window, "2026-07-20");
    expect(start.toISOString()).toBe("2026-07-20T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T20:00:00.000Z");
  });
});

describe("humanized fuzz (rollFireTime)", () => {
  test("chosen time always lands inside the window", () => {
    for (let i = 0; i < 200; i++) {
      const rng = seededRng(i);
      const fire = rollFireTime(schedule, "2026-07-20", rng);
      expect(fire.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-07-20T19:00:00.000Z"));
      expect(fire.getTime()).toBeLessThan(Date.parse("2026-07-20T20:00:00.000Z"));
    }
  });

  test("rng endpoints map to the window edges", () => {
    const atStart = rollFireTime(schedule, "2026-07-20", () => 0);
    expect(atStart.toISOString()).toBe("2026-07-20T19:00:00.000Z");
    // Just under 1 → the last whole minute of the window (12:59 PT = 19:59Z).
    const atEnd = rollFireTime(schedule, "2026-07-20", () => 0.999999);
    expect(atEnd.toISOString()).toBe("2026-07-20T19:59:00.000Z");
  });

  test("the chosen minute VARIES run-to-run (seedable RNG)", () => {
    // The core acceptance property: different seeds produce different minutes.
    const minutes = new Set<number>();
    for (let seed = 0; seed < 30; seed++) {
      const fire = rollFireTime(schedule, "2026-07-20", seededRng(seed));
      minutes.add(fire.getUTCMinutes());
    }
    expect(minutes.size).toBeGreaterThan(5);
  });

  test("same seed reproduces the same minute (deterministic for tests)", () => {
    const a = rollFireTime(schedule, "2026-07-20", seededRng(42));
    const b = rollFireTime(schedule, "2026-07-20", seededRng(42));
    expect(a.toISOString()).toBe(b.toISOString());
  });
});
