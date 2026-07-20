/**
 * Beckett — Built-in routines (`src/routine/builtins.ts`)
 * =======================================================================================
 * Engine-seeded routines that exist on a fresh install. The store seeds these on load unless
 * the user explicitly removed them (tracked in `removedBuiltins`). The acceptance vehicle for
 * issue #62 is `daily-x-shitpost`: once a day at a random minute in 12:00–13:00 PT, compose a
 * dumb in-voice shitpost and post it to X @beckposting through the `beckett browser` lane.
 *
 * The X credentials live in the jingle keychain under `x.com`; only the entry NAME is stored
 * here — the value is resolved by the browser lane, below the transcript. No secret is
 * hardcoded. `channelId` / `requesterId` are intentionally left to env at fire time
 * (`BECKETT_ROUTINE_CHANNEL_ID` / `DISCORD_OWNER_ID`) so no id is baked into source.
 */

import type { Routine } from "./types.ts";

/** The X account the shitpost routine posts as. */
export const X_SHITPOST_ACCOUNT = "@beckposting";
/** jingle keychain entry that holds the X login (username/password/TOTP). */
export const X_CREDS_ENTRY = "x.com";

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
        kind: "x-shitpost",
        account: X_SHITPOST_ACCOUNT,
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
