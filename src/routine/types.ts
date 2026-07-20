/**
 * Beckett — Routines model (`src/routine/types.ts`)
 * =======================================================================================
 * A **routine** is a named, recurring scheduled task whose fire time is HUMANIZED, not a
 * clockwork cron tick. Instead of firing at exactly 12:00 every day, a routine fires at a
 * random time inside a WINDOW (e.g. somewhere in 12:00–13:00 America/Los_Angeles), so one
 * day it's 12:07 and the next it's 12:41 — human-irregular by design (issue #62).
 *
 * The definitions and the current period's already-chosen fire time both persist to disk
 * ({@link ./store.ts}) so a daemon restart mid-window neither double-fires nor re-rolls the
 * day's time. Firing is idempotent per period via `lastFiredPeriodKey`.
 *
 * These are the Zod-validated shapes the store reads/writes. The schedule math lives in
 * {@link ./schedule.ts}, dispatch-plan building in {@link ./plan.ts}, and the daemon tick in
 * {@link ./scheduler.ts}.
 */

import { z } from "zod";

/** "HH:MM" 24-hour wall-clock, e.g. "12:00" or "13:40". */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h)");

/**
 * A fuzz window: pick a concrete fire time uniformly at random between `start` and `end`
 * wall-clock in the named IANA `tz` each period. `end` must be strictly after `start`.
 */
export const FuzzWindowSchema = z
  .object({
    start: HHMM,
    end: HHMM,
    tz: z.string().min(1),
  })
  .refine((w) => toMinutes(w.end) > toMinutes(w.start), {
    message: "window end must be after start",
  });
export type FuzzWindow = z.infer<typeof FuzzWindowSchema>;

/**
 * The base cadence. Only `daily` is implemented today; the discriminated union is the seam
 * for `weekly` / `interval` to slot in without touching the rest of the engine.
 */
export const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** A base cadence + the fuzz window applied to each of its periods. */
export const ScheduleSchema = z.object({
  cadence: CadenceSchema,
  window: FuzzWindowSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * What a routine DOES when it fires. Every action runs OFF the intake/scheduler process by
 * dispatching through the `beckett browser` background lane (issue #50/#58) — never inline.
 *
 * - `x-shitpost`: compose a short in-voice shitpost and post it to X via the browser lane.
 * - `browser`: run an arbitrary self-contained browser task each period.
 */
export const RoutineActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("x-shitpost"),
    /** Handle posted as, for the browser task narrative (e.g. "@beckposting"). */
    account: z.string().min(1),
    /** jingle keychain entry holding the X creds, passed to the browser lane via --creds. */
    credsEntry: z.string().min(1),
    /** Discord channel the browser lane reports its outcome/questions to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the browser run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("browser"),
    /** The self-contained task string handed to `beckett browser`. */
    task: z.string().min(1),
    credsEntry: z.string().optional(),
    channelId: z.string().optional(),
    requesterId: z.string().optional(),
  }),
]);
export type RoutineAction = z.infer<typeof RoutineActionSchema>;

/**
 * Per-period runtime state — the part that must survive a restart. `periodKey` is the key of
 * the period `chosenFireAt` was rolled for; `lastFiredPeriodKey` is the key we already fired
 * for (idempotency). A restart re-reads this and does NOT re-roll while `periodKey` still
 * matches the current period.
 */
export const RoutineStateSchema = z.object({
  /** Period key the current `chosenFireAt` belongs to (e.g. "2026-07-20" for daily). */
  periodKey: z.string().nullable().default(null),
  /** The concrete fire instant chosen for `periodKey`, ISO-8601 UTC. */
  chosenFireAt: z.string().nullable().default(null),
  /** The period key we have already fired for — blocks a second fire in the same period. */
  lastFiredPeriodKey: z.string().nullable().default(null),
  /** ISO time of the last successful dispatch (for `inspect`). */
  lastFiredAt: z.string().nullable().default(null),
});
export type RoutineState = z.infer<typeof RoutineStateSchema>;

export const RoutineSchema = z.object({
  /** Stable id/name, kebab-case (e.g. "daily-x-shitpost"). */
  id: z.string().min(1),
  /** Human label. */
  name: z.string().min(1),
  /** True for engine-seeded routines that re-appear on boot unless explicitly removed. */
  builtin: z.boolean().default(false),
  /** Paused routines persist and inspect but never fire. */
  enabled: z.boolean().default(true),
  action: RoutineActionSchema,
  schedule: ScheduleSchema,
  state: RoutineStateSchema.default({
    periodKey: null,
    chosenFireAt: null,
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const RoutineRegistrySchema = z.object({
  version: z.literal(1),
  routines: z.array(RoutineSchema).default([]),
  /** Built-in ids the user explicitly removed, so seeding doesn't resurrect them. */
  removedBuiltins: z.array(z.string()).default([]),
});
export type RoutineRegistry = z.infer<typeof RoutineRegistrySchema>;

/** "12:34" → 754 (minutes since midnight). Used by the window validator and schedule math. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
