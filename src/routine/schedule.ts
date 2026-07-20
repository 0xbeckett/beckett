/**
 * Beckett — Routine schedule math (`src/routine/schedule.ts`)
 * =======================================================================================
 * The humanized-timing core (issue #62): given a routine's cadence + fuzz window in a named
 * timezone, compute
 *
 *   - the **period key** for an instant (the unit a routine fires at most once per — the
 *     tz-local calendar date for `daily`), and
 *   - a **concrete fire time** chosen uniformly at random inside the window for that period.
 *
 * Everything here is PURE and the randomness is INJECTED (`rng: () => number` in [0,1)), so
 * "the chosen minute varies run-to-run" is verified deterministically in tests by feeding a
 * seeded RNG. No external date library — timezone↔UTC conversion is done with the built-in
 * `Intl.DateTimeFormat`, which every supported runtime ships with the IANA tz database.
 */

import type { Cadence, FuzzWindow, Schedule } from "./types.ts";
import { toMinutes } from "./types.ts";

/**
 * A tiny deterministic PRNG (Mulberry32) so a seed reproduces a run in tests. Lives here beside
 * the schedule math it feeds (`rollFireTime`) — the only injection point for randomness now that
 * composition is the agent's job, not the routine's.
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validate an IANA timezone id up front so a typo fails at add-time, not at fire-time. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock the named zone shows at instant `at`, as calendar fields (h23). */
function zonedFields(
  tz: string,
  at: Date,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Offset (localWall − UTC) in ms the zone is at instant `at`. Positive east of UTC. */
function tzOffsetMs(tz: string, at: Date): number {
  const f = zonedFields(tz, at);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - at.getTime();
}

/**
 * Convert a wall-clock (y-mo-d h:mi in `tz`) to the UTC instant it names. Two-pass so a time
 * near a DST transition resolves against the offset actually in effect at the result instant,
 * not the offset at the naive guess.
 */
export function zonedWallToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let inst = naive - tzOffsetMs(tz, new Date(naive));
  inst = naive - tzOffsetMs(tz, new Date(inst));
  return new Date(inst);
}

/** The tz-local calendar date of `at` as "YYYY-MM-DD". */
export function localDateKey(tz: string, at: Date): string {
  const f = zonedFields(tz, at);
  const mm = String(f.month).padStart(2, "0");
  const dd = String(f.day).padStart(2, "0");
  return `${f.year}-${mm}-${dd}`;
}

/**
 * The key of the period `at` falls in. A routine fires at most once per period key. For
 * `daily` that's the tz-local date; weekly/interval would derive their own key here.
 */
export function periodKey(cadence: Cadence, window: FuzzWindow, at: Date): string {
  switch (cadence.kind) {
    case "daily":
      return localDateKey(window.tz, at);
  }
}

/** The [start, end) UTC instants of the window for the period keyed by `key` ("YYYY-MM-DD"). */
export function windowBounds(window: FuzzWindow, key: string): { start: Date; end: Date } {
  const [year, month, day] = key.split("-").map(Number);
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  return {
    start: zonedWallToUtc(window.tz, year!, month!, day!, sh!, sm!),
    end: zonedWallToUtc(window.tz, year!, month!, day!, eh!, em!),
  };
}

/**
 * Roll a concrete fire instant uniformly at random inside the window for period `key`. Chosen
 * to whole-minute granularity so the humanized time reads naturally (12:07, 12:41, …) and so
 * "the chosen minute varies run-to-run" is the observable, testable property. `rng` returns a
 * float in [0,1); inject a seeded one in tests.
 */
export function rollFireTime(schedule: Schedule, key: string, rng: () => number): Date {
  const { start } = windowBounds(schedule.window, key);
  const spanMinutes = toMinutes(schedule.window.end) - toMinutes(schedule.window.start);
  const minute = Math.min(spanMinutes - 1, Math.floor(rng() * spanMinutes));
  return new Date(start.getTime() + minute * 60_000);
}

/**
 * The next concrete fire time for display: the persisted `chosenFireAt` if it belongs to the
 * current-or-later period, else the roll for the current period (for a routine the daemon
 * hasn't ticked yet). `rng` is only consulted for the un-rolled case.
 */
export function nextFireAt(
  schedule: Schedule,
  state: { periodKey: string | null; chosenFireAt: string | null; lastFiredPeriodKey: string | null },
  now: Date,
  rng: () => number,
): Date {
  const key = periodKey(schedule.cadence, schedule.window, now);
  if (state.periodKey === key && state.chosenFireAt) {
    return new Date(state.chosenFireAt);
  }
  const rolled = rollFireTime(schedule, key, rng);
  if (rolled.getTime() >= now.getTime()) return rolled;
  // Today's window already fully elapsed and unfired — the next fire is tomorrow's window.
  return rollFireTime(schedule, localDateKey(schedule.window.tz, new Date(now.getTime() + 24 * 3_600_000)), rng);
}
