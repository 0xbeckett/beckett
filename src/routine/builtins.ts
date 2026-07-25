/**
 * Beckett — Built-in routines (`src/routine/builtins.ts`)
 * =======================================================================================
 * Engine-seeded routines that exist on a fresh install. The store seeds these on load unless
 * the user explicitly removed them (tracked in `removedBuiltins`). Two live here:
 *
 *   - `daily-x-shitpost` (issue #62) — once a day at a random minute in 12:00–13:00 PT, post a
 *     dumb in-voice shitpost to X @beckposting. The acceptance vehicle for humanized timing.
 *   - `weekly-deps-update` (issue #85) — Sunday mornings PT, update in-range dependencies in an
 *     isolated clone and open a PR. The acceptance vehicle for the `weekly` cadence, and the one
 *     built-in that never touches the browser.
 *
 * As of issue #55/#72 this routine drives that post THROUGH the `social-media` agent rather than
 * an ad-hoc composer: its action invokes the agent (which WRITES the post — taste lives in the
 * agent's prompt, all data) and the dispatcher hands the agent-authored task to the background
 * browser lane. One path, not two. The account/voice/how-to-post all live in the agent definition
 * ({@link ../agent/builtins.ts}); this routine only says WHEN, WHICH agent, and WHICH creds entry.
 *
 * The X credentials live in the jingle keychain under `x.com`; only the entry NAME is stored here —
 * the value is resolved by the browser lane, below the transcript. No secret is hardcoded.
 * `channelId` / `requesterId` are intentionally left to env at fire time
 * (`BECKETT_ROUTINE_CHANNEL_ID` / `DISCORD_OWNER_ID`) so no id is baked into source.
 */

import type { Routine } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";

/** jingle keychain entry that holds the X login (username/password/TOTP). A NAME, never a secret. */
export const X_CREDS_ENTRY = "x.com";

/**
 * The instruction handed to the social-media agent each fire. Deliberately terse — the agent's
 * prompt owns the voice and the browser-task shape; this only names the job.
 */
export const DAILY_SHITPOST_INPUT =
  "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.";

/**
 * The weekly dependency-update routine (issue #85). ro's ask: stop hand-bumping deps forever.
 * Sunday mornings PT, because that is when a PR can sit unmerged without blocking anyone and the
 * week's own work isn't competing for the test suite.
 *
 * `repo` / `sourceRepo` are deliberately ABSENT: the executor resolves them at fire time from the
 * GitHub identity and the daemon's own source root, so no account name or filesystem path is baked
 * into source. `base` is `main` and stays a TARGET — the job opens a PR and stops.
 */
export const WEEKLY_DEPS_UPDATE_ID = "weekly-deps-update";

/**
 * The definitions (sans timestamps/state — the store stamps those on seed). Kept as a factory
 * so the seeder gets fresh objects and can't accidentally share mutable state.
 */
export function builtinRoutineDefs(): Array<Omit<Routine, "createdAt" | "updatedAt" | "state">> {
  return [
    {
      id: "daily-x-shitpost",
      name: "daily X shitpost",
      builtin: true,
      enabled: true,
      action: {
        kind: "agent",
        agentId: SOCIAL_MEDIA_AGENT_ID,
        input: DAILY_SHITPOST_INPUT,
        credsEntry: X_CREDS_ENTRY,
      },
      schedule: {
        cadence: { kind: "daily" },
        window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" },
      },
    },
    {
      id: WEEKLY_DEPS_UPDATE_ID,
      name: "weekly dependency update",
      builtin: true,
      enabled: true,
      action: { kind: "deps-update", base: "main" },
      schedule: {
        cadence: { kind: "weekly", weekday: "sunday" },
        window: { start: "08:00", end: "10:00", tz: "America/Los_Angeles" },
      },
    },
  ];
}

/** Ids of the built-ins (for `remove` bookkeeping and tests). */
export function builtinRoutineIds(): string[] {
  return builtinRoutineDefs().map((r) => r.id);
}
