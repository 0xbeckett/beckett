/**
 * Memory freshness helpers (`src/memory/freshness.ts`) — memories are dated OBSERVATIONS.
 * =======================================================================================
 * Every node in the graph is an observation made at a point in time: true as of when it was
 * written, never an eternal claim. Old observations are NOT deleted and NOT treated as
 * probably-wrong — the world just moves, and a newer observation of the same thing is the
 * current truth while the older one remains the honest record of how things used to be (and
 * often still are). These helpers are the shared spine of that model (alita-inspired
 * "current vs history", adapted to this store):
 *
 *   - Every render path (recall CLI text + JSON, the agent-recall candidate list, the always-
 *     loaded MEMORY.md index) carries each observation's date and age, so the reader — model
 *     or human — anchors it to its time ("as of March…") instead of mistaking it for now.
 *   - Scoring gently prefers the NEWER observation on ties (see `recency()` in index.ts) — a
 *     nudge, never a drop; an old observation that still matches still surfaces.
 *   - maintain.ts lists long-untouched nodes as AGED OBSERVATIONS — a re-observation queue:
 *     verify against the world and `remember` the result (a fresh observation that refreshes
 *     the date), never an archive-by-age list. Nothing is archived for age alone; the only
 *     archive paths are the explicit lifecycles a fact opted into (ttl) or a deliberate
 *     supersede/merge.
 *   - `remember` updates refresh `updated` — re-observing something is how the graph's
 *     "current truth" advances, with the history intact underneath.
 *
 * Thresholds: 90d flags a line in the always-loaded index; 180d marks an observation aged
 * enough that re-observing is usually worthwhile.
 */

/** Index lines older than this carry an explicit `· upd YYYY-MM-DD` flag in MEMORY.md. */
export const INDEX_AGE_FLAG_DAYS = 90;
/** Past this, an observation is aged: recall says so and maintain queues it for re-observation. */
export const AGED_OBSERVATION_DAYS = 180;

/** Days since an ISO timestamp, or null when it's missing/unparseable. Never negative. */
export function ageDays(updated: string | undefined, now: number): number | null {
  const t = Date.parse(updated ?? "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/** Compact age label: "today", "3d ago", "7mo ago", "2y ago". */
export function freshnessAge(days: number): string {
  if (days < 1) return "today";
  if (days < 60) return `${Math.round(days)}d ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** The recall-facing label: "3d ago", or "7mo ago — an observation from then" once aged. */
export function freshnessLabel(updated: string | undefined, now: number): string {
  const days = ageDays(updated, now);
  if (days === null) return "no date on file";
  const age = freshnessAge(days);
  return days >= AGED_OBSERVATION_DAYS ? `${age} — an observation from then` : age;
}

/** The MEMORY.md index flag: ` · upd YYYY-MM-DD` for 90d+ lines, else "". */
export function indexAgeFlag(updated: string | undefined, now: number): string {
  if (!updated) return "";
  const days = ageDays(updated, now);
  if (days === null || days < INDEX_AGE_FLAG_DAYS) return "";
  return ` · upd ${updated.slice(0, 10)}`;
}
