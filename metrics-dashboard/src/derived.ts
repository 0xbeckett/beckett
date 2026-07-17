import { metrics } from "./metrics";

/*
 * Marketing projections over the same generated metrics document. Pure sums/derivations —
 * no new source of truth. Telemetry (`headline`, `models`, …) and code stats (`codeStats`)
 * both come straight from the harvesters; here we only combine them into the punchy figures
 * the page leads with.
 */

const h = metrics.headline;
const cs = metrics.codeStats;

// ── Authorship, merged by display name ───────────────────────────────────────
// The harvester keys authors by name+email, so one person with several emails shows up
// as multiple rows. For the "who wrote it" story we fold those together by name.
export type Author = { name: string; commits: number; net: number; additions: number };

export const authors: Author[] = (() => {
  const map = new Map<string, Author>();
  for (const a of cs.authors) {
    const cur = map.get(a.name) ?? { name: a.name, commits: 0, net: 0, additions: 0 };
    cur.commits += a.commits;
    cur.net += a.net;
    cur.additions += a.additions;
    map.set(a.name, cur);
  }
  return [...map.values()].sort((x, y) => y.commits - x.commits);
})();

const beckett = authors.find((a) => /^beckett$/i.test(a.name.trim()));
export const beckettCommits = beckett?.commits ?? 0;
export const beckettShare = cs.headline.commits > 0 ? beckettCommits / cs.headline.commits : 0;

// ── Per-project, top N by lines written ─────────────────────────────────────
export const topProjects = [...cs.projects]
  .sort((a, b) => b.additions - a.additions)
  .slice(0, 8);

// ── Cost-per-outcome ratios (the "it's cheap" story) ────────────────────────
const firstTry = metrics.reviewCycles.find((c) => c.cycles === 0)?.count ?? 0;
export const firstTryRate = h.totalRuns > 0 ? firstTry / h.totalRuns : 0;
export const costPerCommit = cs.headline.commits > 0 ? h.totalSpend / cs.headline.commits : 0;
export const linesPerDollar = h.totalSpend > 0 ? cs.headline.additions / h.totalSpend : 0;
export const commitsPerDay = cs.velocity.length > 0 ? cs.headline.commits / cs.velocity.length : 0;

// ── Series ready for charts ─────────────────────────────────────────────────
export const velocitySeries = cs.velocity.map((v) => ({ date: v.date, value: v.commits }));
export const projectSeries = topProjects.map((p) => ({ label: p.repo, value: p.additions }));
export const authorSeries = authors.slice(0, 7).map((a) => ({ label: a.name, value: a.commits }));
export const costSeries = metrics.models.map((m) => ({ label: m.label, value: m.cost }));
export const wallSeries = metrics.models.map((m) => ({ label: m.label, value: m.wallHours }));
export const cycleSeries = metrics.reviewCycles.map((c) => ({ label: c.label, value: c.count }));
export const runsSeries = metrics.runsOverTime.map((d) => ({ date: d.date, value: d.runs }));

// ── Compact integer/currency formatting for count-up displays ───────────────
export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 199_883 → "199.9K", 1_100 → "1.1K", 42 → "42". For hero figures that must stay short. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return int(n);
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
