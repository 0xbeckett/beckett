#!/usr/bin/env node
// pricing-stats.mjs — derive Beckett's public pricing figures from real telemetry.
//
// Reads every real agent run this install has executed and emits a summary JSON
// that web/public/pricing.html reads. EVERY figure on the pricing page traces
// back to this file's output; nothing on the page is hand-typed.
//
// THE MODEL this file encodes:
//   You bring your own model subscription (Claude Max, or your own API keys).
//   Beckett does not resell model tokens. Instead we normalise the tokens a run
//   moved into COMPUTE HOURS, charge a flat rate for those hours, and add one
//   10% platform fee on top. Billing is prepaid: you load credits (compute
//   hours) up front, unused credits roll over for up to two years, and if
//   Beckett shuts down the remaining balance is refunded at equal value.
//
// Two kinds of numbers live here, kept deliberately separate:
//   1. MEASURED from telemetry: the tokens-per-compute-hour normalisation, run
//      counts, wall-clock, review cycles, and the per-ticket compute the page
//      shows. These are read from the log, not chosen.
//   2. POLICY we set: the flat compute-hour rate and the platform-fee %. These
//      are config constants below. Change the value, re-run, the page updates.
//
// Usage:  node web/scripts/pricing-stats.mjs
// No dependencies beyond the Node standard library.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TELEMETRY = process.env.TELEMETRY_FILE
  || resolve(process.env.HOME || "", "Projects/metrics/data/telemetry-runs.json");
const OUT = resolve(HERE, "../public/pricing-data.json");

// ---------------------------------------------------------------------------
// POLICY INPUTS — set here, not measured. Two numbers compose the price of a
// compute hour: the flat rate for the hour, and the one platform fee on top.
// ---------------------------------------------------------------------------

// 1. FLAT COMPUTE RATE — what an hour of Beckett's compute costs, before the
//    platform fee. It covers the host machine and runtime that turn your tokens
//    into shipped work; it does NOT cover the model tokens themselves, which run
//    on your own subscription. This is the single value to change if the machine
//    cost changes: edit `per_hour`, re-run, the page moves with it.
const COMPUTE_RATE = {
  per_hour: 1.5, // USD per compute hour, before the platform fee
  basis: "the host machine and runtime, amortised over the hours it runs",
};

// 2. PLATFORM FEE — the single margin line, stated on its own. It is what pays
//    for the presence and the seat: the GitHub identity, the pipeline, the
//    Discord presence, the machine kept alive between tasks.
const PLATFORM_FEE = {
  pct: 10, // percent, applied to the flat compute charge
};

// PREPAID BILLING — one credit is one compute hour, priced at the flat rate plus
// the platform fee. Credits are loaded up front and invoiced. Unused credits
// roll over on the account for up to two years. If Beckett winds down, the
// remaining balance is refunded at that same per-credit value.
const BILLING = {
  rollover_years: 2,
  wind_down_refund: true, // remaining credits refunded at equal value on shutdown
};

// ENTERPRISE — team and enterprise contracts are negotiated, not self-serve.
const ENTERPRISE = {
  contact_email: "contact@frgmt.xyz",
};

// Load amounts a reader might prepay with. Used only to answer "I load $X, how
// many compute hours is that, and what does a real ticket consume".
const LOAD_BUDGETS = [5, 20, 50]; // USD

// Price of one compute hour once the platform fee is on top. One credit buys
// exactly one compute hour, so this is also the per-credit price.
const effectivePerHour = round(
  COMPUTE_RATE.per_hour * (1 + PLATFORM_FEE.pct / 100),
  2,
);

// Compute hours are always displayed to two decimals; one credit is one such
// hour. Every money figure derives from the SAME rounded hours the page shows,
// so a reader who multiplies the displayed hours by the rate lands on the exact
// charge the page prints. `chargeForHours` therefore rounds hours first.
const displayHours = (hours) => round(hours, 2);
const chargeForHours = (hours) => round(displayHours(hours) * effectivePerHour, 2);

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  // Round half away from zero, with a tiny epsilon so a value that is exactly
  // half in decimal but a hair under in binary (e.g. 1.425) still rounds up.
  // This keeps the worked example reader-checkable: displayed hours times the
  // displayed rate lands on the displayed charge.
  return Math.round(n * f + Math.sign(n) * 1e-9) / f;
}

// Total tokens a run moved: fresh input + output + cache traffic. This is the
// raw quantity we normalise into compute hours.
function tokensOf(r) {
  const t = r.tokens || {};
  return (t.input || 0) + (t.output || 0) + (t.cache_read || 0) + (t.cache_write || 0);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

let raw;
try {
  raw = readFileSync(TELEMETRY, "utf8");
} catch (err) {
  console.error(`FATAL: cannot read telemetry file at ${TELEMETRY}`);
  console.error(err.message);
  console.error("Refusing to emit invented numbers. Fix the path and re-run.");
  process.exit(1);
}

const data = JSON.parse(raw);
const runs = Array.isArray(data.runs) ? data.runs : [];
if (runs.length === 0) {
  console.error("FATAL: telemetry file has no runs. Refusing to invent numbers.");
  process.exit(1);
}

const costed = runs.filter((r) => typeof r.cost_usd === "number" && r.cost_usd >= 0);
const walled = runs.filter(
  (r) => typeof r.wall_clock_seconds === "number" && r.wall_clock_seconds >= 0,
);

// ---------------------------------------------------------------------------
// THE NORMALISATION — tokens per compute hour, measured from the log.
//
// One compute hour is defined as the token throughput this install actually
// sustains in one hour of wall-clock work: total tokens moved, divided by total
// wall-clock hours. It is not a chosen constant; it falls straight out of the
// telemetry, and it re-derives every time this script runs.
// ---------------------------------------------------------------------------

const normRuns = runs.filter(
  (r) => typeof r.wall_clock_seconds === "number" && r.wall_clock_seconds > 0 && r.tokens,
);
const totalTokens = normRuns.reduce((a, r) => a + tokensOf(r), 0);
const totalComputeHours = normRuns.reduce((a, r) => a + r.wall_clock_seconds / 3600, 0);
const tokensPerComputeHour = Math.round(totalTokens / totalComputeHours);

const normalisation = {
  runs_measured: normRuns.length,
  total_tokens: totalTokens,
  total_compute_hours: round(totalComputeHours, 1),
  tokens_per_compute_hour: tokensPerComputeHour,
};

// ---------------------------------------------------------------------------
// Wall clock per run: median + p90 (kept for the provenance section)
// ---------------------------------------------------------------------------

const walls = walled.map((r) => r.wall_clock_seconds).sort((a, b) => a - b);
const wallClock = {
  median_seconds: round(percentile(walls, 50), 1),
  p90_seconds: round(percentile(walls, 90), 1),
};

// ---------------------------------------------------------------------------
// Review-cycle distribution
// ---------------------------------------------------------------------------

const rcDist = {};
for (const r of runs) {
  const rc = typeof r.review_cycles === "number" ? r.review_cycles : 0;
  const bucket = rc >= 3 ? "3+" : String(rc);
  rcDist[bucket] = (rcDist[bucket] || 0) + 1;
}
const reviewCycles = ["0", "1", "2", "3+"].map((bucket) => ({
  cycles: bucket,
  runs: rcDist[bucket] || 0,
  pct: round(((rcDist[bucket] || 0) / runs.length) * 100, 1),
}));

// ---------------------------------------------------------------------------
// Per-ticket rollup. A "ticket" is one task_id; its compute is the sum of every
// agent run's wall-clock under it, converted to compute hours, then to the
// dollars and credits Beckett bills (flat rate + platform fee). The model
// tokens are billed to your own subscription, so they are shown as a quantity,
// not a charge.
// ---------------------------------------------------------------------------

const byTask = {};
for (const r of runs) {
  if (!r.task_id) continue;
  (byTask[r.task_id] ||= []).push(r);
}

const allTasks = Object.entries(byTask)
  .map(([id, rs]) => {
    const wall = rs.reduce((a, r) => a + (r.wall_clock_seconds || 0), 0);
    const tokens = rs.reduce((a, r) => a + tokensOf(r), 0);
    const rc = rs.reduce((a, r) => a + (r.review_cycles || 0), 0);
    const ts = rs.map((r) => r.timestamp).filter(Boolean).sort().slice(-1)[0] || null;
    const hours = wall / 3600;
    return {
      id,
      runs: rs.length,
      wall,
      hours,
      tokens,
      review_cycles: rc,
      last_ts: ts,
      charge: chargeForHours(hours),
      credits: displayHours(hours), // 1 credit = 1 compute hour
    };
  })
  .filter((t) => t.hours > 0);

// ---------------------------------------------------------------------------
// Worked example — a REAL ticket, its REAL compute, itemised into the two
// billed lines (flat compute + platform fee) with the model tokens shown as the
// quantity that ran on your own subscription. Selected deterministically: among
// substantial tickets (>= 3 runs, at least one review cycle, compute in a sane
// band), take the one whose compute hours is the median. Same data => same
// ticket out.
// ---------------------------------------------------------------------------

const exCandidates = allTasks
  .filter((t) => t.runs >= 3 && t.review_cycles >= 1 && t.hours > 0.15 && t.hours < 3)
  .sort((a, b) => a.hours - b.hours);

if (exCandidates.length === 0) {
  console.error("FATAL: no ticket matched the worked-example criteria.");
  process.exit(1);
}

const chosen = exCandidates[Math.floor((exCandidates.length - 1) / 2)];
// Itemise from the DISPLAYED hours so the two lines add to the total on-page.
const exHours = displayHours(chosen.hours);
const exCompute = round(exHours * COMPUTE_RATE.per_hour, 2);
const exFee = round((exCompute * PLATFORM_FEE.pct) / 100, 2);
const exTotal = round(exCompute + exFee, 2);

const workedExample = {
  ticket: chosen.id,
  runs: chosen.runs,
  wall_clock_seconds: round(chosen.wall, 1),
  compute_hours: exHours,
  tokens: chosen.tokens,
  review_cycles: chosen.review_cycles,
  lines: {
    compute_cost: exCompute,
    platform_fee: exFee,
    total: exTotal,
    total_credits: exHours,
  },
};

// ---------------------------------------------------------------------------
// "What a load buys" — three concrete size bands drawn from the compute-hour
// distribution. Each band is anchored to a percentile, then resolved to the
// REAL ticket nearest that percentile so the example is an actual ticket. The
// counts are just budget ÷ that ticket's real charge.
// ---------------------------------------------------------------------------

const hoursAsc = allTasks.map((t) => t.hours).sort((a, b) => a - b);

const EXAMPLE_BANDS = [
  { key: "quick", label: "a quick fix", pct: 10 },
  { key: "small", label: "a small feature", pct: 25 },
  { key: "typical", label: "a typical task", pct: 50 },
];

const loadExamples = EXAMPLE_BANDS.map((band) => {
  const target = percentile(hoursAsc, band.pct);
  const rep = allTasks
    .slice()
    .sort((a, b) => Math.abs(a.hours - target) - Math.abs(b.hours - target))[0];
  return {
    key: band.key,
    label: band.label,
    percentile: band.pct,
    example_ticket: rep.id,
    runs: rep.runs,
    compute_hours: displayHours(rep.hours),
    charge_usd: rep.charge,
    credits: displayHours(rep.hours),
    covers: LOAD_BUDGETS.map((b) => ({
      budget_usd: b,
      count: rep.charge > 0 ? Math.floor(b / rep.charge) : 0,
    })),
  };
});

// Recent real tickets, newest first, each in compute hours and the charge they
// drew from a prepaid balance.
const recentTasks = allTasks
  .filter((t) => t.last_ts)
  .sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1))
  .slice(0, 8)
  .map((t) => ({
    id: t.id,
    runs: t.runs,
    review_cycles: t.review_cycles,
    last_ts: t.last_ts,
    compute_hours: displayHours(t.hours),
    charge_usd: t.charge,
    credits: displayHours(t.hours),
  }));

const medianHours = percentile(hoursAsc, 50);
const loadValue = {
  budgets_usd: LOAD_BUDGETS,
  task_count: allTasks.length,
  task_charge: {
    median_hours: displayHours(medianHours),
    median_usd: chargeForHours(medianHours),
    median_credits: displayHours(medianHours),
  },
  examples: loadExamples,
  recent_tasks: recentTasks,
};

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const out = {
  // provenance
  generated_at: new Date().toISOString(),
  source_file: TELEMETRY.replace(process.env.HOME || "", "~"),
  telemetry_generated_at: data.generated_at || null,

  // headline counts
  total_runs: runs.length,
  costed_runs: costed.length,
  unrated_model_sessions: data.unrated_model_sessions?.count ?? 0,

  // measured
  normalisation,
  wall_clock: wallClock,
  review_cycle_distribution: reviewCycles,

  // policy
  compute_rate: {
    per_hour: COMPUTE_RATE.per_hour,
    basis: COMPUTE_RATE.basis,
    effective_per_hour: effectivePerHour,
  },
  platform_fee: PLATFORM_FEE,
  credit: {
    usd_per_credit: effectivePerHour, // one credit = one compute hour, priced flat + fee
    hours_per_credit: 1,
    rollover_years: BILLING.rollover_years,
    wind_down_refund: BILLING.wind_down_refund,
  },
  billing: BILLING,
  enterprise: ENTERPRISE,

  // "I load $X, now what" + recent tickets
  load_value: loadValue,

  // the worked example
  worked_example: workedExample,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

console.log(`Wrote ${OUT}`);
console.log(`  runs: ${out.total_runs} (costed: ${out.costed_runs})`);
console.log(
  `  normalisation: ${tokensPerComputeHour.toLocaleString()} tokens / compute hour`
  + ` (from ${normalisation.total_compute_hours}h of work)`,
);
console.log(
  `  compute rate: $${COMPUTE_RATE.per_hour}/hr + ${PLATFORM_FEE.pct}% fee`
  + ` = $${effectivePerHour}/hr effective (1 credit)`,
);
console.log(`  worked example: ${chosen.id} -> ${workedExample.compute_hours}h -> $${exTotal}`);
console.log(
  `  load examples: ${loadExamples.map((e) => `${e.label} $${e.charge_usd}`).join(", ")}`,
);
