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
 * Weekday names in ISO-8601 week order (Monday first, Sunday last). The order IS load-bearing:
 * {@link ./schedule.ts} indexes into it to place a `weekly` routine's fire day inside its ISO
 * week, so Sunday is day 7 of the week it fires in, not day 1 of the next one.
 */
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

/**
 * The base cadence — the seam this discriminated union was built for (issue #85 took it):
 *
 *   - `daily`  — one period per tz-local calendar date; the period key is that date.
 *   - `weekly` — one period per ISO week, firing on `weekday`; the period key is the ISO week
 *     ("2026-W30"), so the once-per-period idempotency guard in {@link ./scheduler.ts} works
 *     EXACTLY as daily's does: a restart mid-week neither double-fires nor re-rolls the time
 *     already chosen inside that week's window.
 *
 * `interval` can still slot in the same way — a key derivation + an advance step, nothing else.
 */
export const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekly"), weekday: WeekdaySchema }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** A base cadence + the fuzz window applied to each of its periods. */
export const ScheduleSchema = z.object({
  cadence: CadenceSchema,
  window: FuzzWindowSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * What a routine DOES when it fires. Every action runs OFF the intake/scheduler process — never
 * inline: the daemon hands the plan to a dispatch executor ({@link ../shell/main.ts}) that runs it.
 *
 * - `agent`: invoke a registered agent ({@link ../agent/registry.ts}) with `input`; the agent
 *   AUTHORS the work (its taste lives in its prompt — all data, no code here) and the dispatcher
 *   hands what it authored to the privileged background browser lane. This is how the daily shitpost
 *   is driven THROUGH the `social-media` agent (issue #55/#72). Pointing a routine at a different
 *   agent (or editing the agent's prompt) needs no code change and no redeploy.
 * - `browser`: run an arbitrary, STATIC self-contained browser task each period (issue #62).
 * - `deps-update`: the LOCAL maintenance lane (issue #85). The only action that does NOT touch the
 *   browser: it clones the source repo, applies in-range dependency updates, runs typecheck + the
 *   test suite, and opens a PR a human merges. Nothing about it wants a browser, credentials, or a
 *   privileged web session, so it must never be routed through that lane.
 * - `x-shitpost` (LEGACY): the pre-#72 shape. Still parsed so a routines.json seeded by an older
 *   build keeps loading; {@link ./plan.ts} transparently routes it through the `social-media` agent,
 *   so there is exactly ONE runtime path. New routines should use `agent`.
 */
export const RoutineActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    /** Registry id of the agent to invoke (e.g. "social-media"). Resolved LIVE at fire time. */
    agentId: z.string().min(1),
    /** The instruction handed to the agent describing what to do (e.g. "compose today's shitpost"). */
    input: z.string().min(1),
    /** jingle keychain entry the browser lane injects creds from, for the agent-authored task. */
    credsEntry: z.string().optional(),
    /** Discord channel the browser lane reports its outcome/questions to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the run is attributed to (optional; owner env fallback). */
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
  z.object({
    kind: z.literal("deps-update"),
    /**
     * `owner/name` the PR is opened on. Omitted → resolved at fire time from the GitHub identity
     * (`<owner>/beckett`), so no account id is baked into a routine definition.
     */
    repo: z.string().min(1).optional(),
    /** Branch the PR TARGETS. It is never pushed to, never merged into — a human does that. */
    base: z.string().min(1).default("main"),
    /**
     * Absolute path of the checkout the update is cloned FROM, read-only. Omitted → the daemon's
     * own source root. The clone is what gets mutated; the live tree never is.
     */
    sourceRepo: z.string().min(1).optional(),
    /** Discord channel the one-line summary is posted to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
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
]);
export type RoutineAction = z.infer<typeof RoutineActionSchema>;

/**
 * Per-period runtime state — the part that must survive a restart. `periodKey` is the key of
 * the period `chosenFireAt` was rolled for; `lastFiredPeriodKey` is the key we already fired
 * for (idempotency). A restart re-reads this and does NOT re-roll while `periodKey` still
 * matches the current period.
 */
export const RoutineStateSchema = z.object({
  /** Period key the current `chosenFireAt` belongs to ("2026-07-20" daily, "2026-W30" weekly). */
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
