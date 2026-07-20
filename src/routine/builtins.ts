/**
 * Beckett — Built-in routines (`src/routine/builtins.ts`)
 * =======================================================================================
 * Engine-seeded routines that exist on a fresh install. The store seeds these on load unless
 * the user explicitly removed them (tracked in `removedBuiltins`). The acceptance vehicle for
 * issue #62 is `daily-x-shitpost`: once a day at a random minute in 12:00–13:00 PT, post a dumb
 * in-voice shitpost to X @beckposting.
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
  ];
}

/** Ids of the built-ins (for `remove` bookkeeping and tests). */
export function builtinRoutineIds(): string[] {
  return builtinRoutineDefs().map((r) => r.id);
}
