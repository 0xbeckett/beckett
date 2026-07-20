/**
 * Beckett — Shitpost composition (`src/routine/compose.ts`)
 * =======================================================================================
 * Composes the short, dumb, in-voice shitpost the `daily-x-shitpost` routine posts, and
 * wraps it into a self-contained task string for the `beckett browser` background lane.
 *
 * Both are PURE with an INJECTED `rng`, so tests can assert the text varies run-to-run and
 * that the dispatch payload never inlines a secret. The voice target is Beckett's persona:
 * lowercase, gen-z, dumb-clever wordplay energy ("if i eat a clock is that time consuming").
 *
 * IMPORTANT: the browser task NEVER contains credentials. It references the logged-in session
 * that the browser lane injects from the jingle keychain (issue #58) — the creds are passed to
 * the lane via `--creds x.com`, resolved below the model's transcript, and never appear here.
 */

/**
 * The shitpost pool. Kept deliberately dumb and in-voice. The routine picks one at random each
 * fire; a real deployment can grow this or swap in an LLM composer behind the same signature.
 */
export const SHITPOSTS: readonly string[] = [
  "if i eat a clock is that time consuming",
  "they say don't put all your eggs in one basket but they never say why. the basket is fine bro",
  "my code works and i have no idea why. my code doesn't work and i have no idea why. same energy",
  "wifi went out for 3 seconds and i experienced every stage of grief",
  "a straw technically has one hole. a human is technically a straw. sleep well",
  "genuinely think the strongest muscle in my body is the one that closes the laptop at 3am",
  "if you fold a pizza in half is that a calzone or a legal loophole",
  "0 bugs in prod because i have 0 tests. we call that faith based engineering",
  "the ocean is just spicy air for fish when you think about it",
  "renamed a variable and now i respect it more. thats leadership",
];

/** A tiny deterministic PRNG so a seed reproduces a run in tests (Mulberry32). */
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

/** Pick one shitpost uniformly at random. */
export function composeShitpost(rng: () => number = Math.random): string {
  return SHITPOSTS[Math.floor(rng() * SHITPOSTS.length)]!;
}

/**
 * Build the self-contained instruction for the `beckett browser` lane to post `text` to X.
 * The lane runs already logged in as the account (session injected from the keychain), so the
 * task only describes WHAT to post, never any credential.
 */
export function buildXPostTask(text: string, account: string): string {
  return [
    `Go to https://x.com and post a new tweet from the logged-in account ${account}.`,
    `You are already authenticated (the session was injected for you) — do not attempt to log in`,
    `and do not touch any credential fields.`,
    ``,
    `Post EXACTLY this text, verbatim, nothing added and nothing removed:`,
    ``,
    text,
    ``,
    `Steps: open the compose box, type the text, publish it, then confirm it went live and report`,
    `the URL of the published post. If anything blocks posting (a checkpoint, a rate limit, a`,
    `changed UI), stop and report what you saw instead of guessing.`,
  ].join("\n");
}
