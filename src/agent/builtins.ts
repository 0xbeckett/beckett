/**
 * Beckett — Built-in agents (`src/agent/builtins.ts`)
 * =======================================================================================
 * Engine-seeded agent definitions that exist on a fresh install. The store seeds these on load
 * unless the user explicitly removed them (tracked in `removedBuiltins`), exactly like built-in
 * routines ({@link ../routine/builtins.ts}). A seeded agent is nothing but DATA — a systemPrompt
 * string plus a seat — written into `agents.json`; it is NOT a code module. Its whole behavior
 * lives in its prompt, which a human can read, edit, or replace with `beckett agent` and no redeploy.
 *
 * The `social-media` agent (issue #55/#72) is the acceptance vehicle: the daily-shitpost routine
 * invokes it through the generic invoke-lane ({@link ./invoke.ts}), it AUTHORS the post, and the
 * routine dispatcher hands the authored task to the background browser lane. The voice, the target
 * handle, and the how-to-post shape all live in `systemPrompt` below — there is no `src/social`
 * module. Growing it (replies, follows, other platforms) is a prompt/skill edit, not new code.
 */

import type { AgentDefinition } from "./types.ts";

/** Registry id of the built-in social-media agent the shitpost routine drives. */
export const SOCIAL_MEDIA_AGENT_ID = "social-media";

/** The X account the social-media agent posts as. Data, not a secret. */
export const X_SOCIAL_ACCOUNT = "@beckposting";

/**
 * The social-media agent's persona + operating instructions — ALL DATA. It composes an in-voice
 * post and then AUTHORS a self-contained instruction for the background browser lane to publish it.
 * It never handles credentials (the lane injects the logged-in session from the keychain) and never
 * calls the browser itself — its OUTPUT is the browser task, which the caller routes onward. That
 * split is what lets a headless routine post without a Discord mention token.
 */
const SOCIAL_MEDIA_SYSTEM_PROMPT = [
  "You are Beckett's social-media agent. You run X (Twitter) as @beckposting.",
  "",
  "VOICE: lowercase, gen-z, dumb-clever wordplay energy. short. no hashtags, no emoji, no",
  'engagement-bait. the target register is "if i eat a clock is that time consuming" —',
  "a shower thought that sounds profound for half a second and then falls apart. examples of the",
  "vibe (do NOT reuse these verbatim, they are calibration only):",
  "  - they say don't put all your eggs in one basket but they never say why. the basket is fine bro",
  "  - wifi went out for 3 seconds and i experienced every stage of grief",
  "  - 0 bugs in prod because i have 0 tests. we call that faith based engineering",
  "  - the ocean is just spicy air for fish when you think about it",
  "",
  "TASK: unless told otherwise, compose ONE fresh post in that voice — a single line, under 280",
  "characters, never one of the calibration lines above. Then author the instruction that publishes",
  `it to X as ${X_SOCIAL_ACCOUNT} through the background browser tool.`,
  "",
  "The browser tool runs ALREADY LOGGED IN as the account (its session is injected below the",
  "transcript from the keychain). You never see, type, or ask for any credential. Do not attempt",
  "to log in and do not touch any credential field.",
  "",
  "OUTPUT CONTRACT: respond with ONLY the browser task text — the exact self-contained instruction",
  "the browser tool should follow, and nothing else. No preamble, no commentary, no code fences, no",
  "quotes around it. The instruction MUST:",
  `  - say to go to https://x.com and post a new tweet from the logged-in account ${X_SOCIAL_ACCOUNT},`,
  "  - state that the session is already authenticated so it must NOT log in or touch credentials,",
  "  - include the EXACT post text to publish, verbatim, on its own,",
  "  - tell it to open the compose box, type that text, publish, then confirm it went live and report",
  "    the URL of the published post,",
  "  - tell it that if anything blocks posting (a checkpoint, a rate limit, a changed UI) it must stop",
  "    and report what it saw instead of guessing.",
].join("\n");

/**
 * The definitions (sans timestamps — the store stamps those on seed). Kept as a factory so the
 * seeder gets fresh objects and can't accidentally share mutable state.
 */
export function builtinAgentDefs(): Array<Omit<AgentDefinition, "createdAt" | "updatedAt">> {
  return [
    {
      id: SOCIAL_MEDIA_AGENT_ID,
      description: "Runs X (@beckposting): composes in-voice posts and drives the background browser to publish them.",
      systemPrompt: SOCIAL_MEDIA_SYSTEM_PROMPT,
      model: { harness: "claude", model: "claude-sonnet-4-5", effort: "medium" },
      // `browser` marks the seam: this agent's output feeds the background browser lane, and future
      // behaviors (replies, follows, other platforms) are prompt/skill edits, not new code.
      skills: ["browser"],
      tools: [],
      persistent: false,
      builtin: true,
    },
  ];
}

/** Ids of the built-ins (for `remove` bookkeeping and tests). */
export function builtinAgentIds(): string[] {
  return builtinAgentDefs().map((a) => a.id);
}
