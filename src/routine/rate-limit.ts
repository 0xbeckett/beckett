/**
 * Beckett — event-post rate limiter (`src/routine/rate-limit.ts`)
 * =======================================================================================
 * The hard, non-negotiable safety rail for the `watch` routine action (issue #1): an event post
 * is an interruption on top of ~9 scheduled posts a day, so it is capped independently of
 * anything configurable on the routine itself — no field on the action can loosen this.
 */

/** Never more than one event post per rolling hour, and never more than three per rolling 24h. */
export const WATCH_RATE_LIMIT = { maxPerHour: 1, maxPer24h: 3 } as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** True if one more post right now would stay within both the hourly and 24h caps. */
export function withinRateLimit(posts: ReadonlyArray<{ postedAt: string }>, now: Date): boolean {
  const nowMs = now.getTime();
  let inLastHour = 0;
  let inLast24h = 0;
  for (const post of posts) {
    const age = nowMs - Date.parse(post.postedAt);
    if (!Number.isFinite(age) || age < 0) continue;
    if (age < HOUR_MS) inLastHour++;
    if (age < DAY_MS) inLast24h++;
  }
  return inLastHour < WATCH_RATE_LIMIT.maxPerHour && inLast24h < WATCH_RATE_LIMIT.maxPer24h;
}
