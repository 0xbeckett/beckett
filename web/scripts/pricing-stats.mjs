#!/usr/bin/env node
// pricing-stats.mjs — derive Beckett's public pricing figures from real telemetry.
//
// Reads every real agent run this install has executed and emits a summary JSON
// that web/public/pricing.html reads. EVERY dollar figure and statistic on the
// pricing page traces back to this file's output — nothing on the page is
// hand-typed.
//
// Two kinds of numbers live here, kept deliberately separate:
//   1. STATISTICS derived from telemetry (median/p90 cost, breakdowns, wall
//      clock, review cycles, run count). These are measured, not chosen.
//   2. PRICING INPUTS we set as policy (the per-Mtok rate table, the compute
//      hourly rate, the platform-fee %, the seat price). These are config
//      constants below — change the value, re-run, and the page updates.
//
// The compute rate is a single named constant with a stated basis. Moving from
// today's amortised-subscription rate to a future VM hourly rate is a value
// change here, not a page rewrite.
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
// PRICING INPUTS — policy, not telemetry. Three of these compose a credit's real
// spend (model + compute + platform fee); the fourth, the seat, is the monthly
// plan that includes a block of those credits — it is not a line charged on top.
// ---------------------------------------------------------------------------

// 1. MODEL COST — pass-through token cost at published per-Mtok rates.
//    Cache reads bill far lower than fresh input (roughly a tenth).
const MODEL_RATES = {
  cache_read_multiplier: 0.1, // cache reads bill ~0.1x the input rate
  // display order matters; each entry is [input $/Mtok, output $/Mtok]
  tiers: [
    { key: "gpt-5.6-terra", label: "gpt-5.6-terra", input: 2.5, output: 15 },
    { key: "gpt-5.6-luna", label: "gpt-5.6-luna", input: 1, output: 6 },
    { key: "claude-opus", label: "Claude Opus", input: 5, output: 25 },
    { key: "claude-sonnet", label: "Claude Sonnet", input: 3, output: 15 },
    { key: "claude-haiku", label: "Claude Haiku", input: 1, output: 5 },
    { key: "claude-fable", label: "Claude Fable", input: 10, output: 50 },
  ],
};

// 2. COMPUTE COST — worker wall-clock and browser-session time at a stated
//    hourly rate. TODAY this is amortised from the host subscription and
//    machine. When a task moves onto a VM, swap `per_hour` for that VM's hourly
//    rate and update `basis` — nothing else changes.
const COMPUTE_RATE = {
  per_hour: 0.5, // USD per wall-clock hour — THE value to change on the VM move
  basis: "amortised subscription + host machine", // today's source of the rate
  vm_basis: "the VM's published hourly rate", // what `basis` becomes on a VM
};

// 3. PLATFORM FEE — the single margin line, stated on its own.
const PLATFORM_FEE = {
  pct: 12, // percent, applied to (model cost + compute cost)
};

// 4. HUMAN SEATS — per person, per month. A seat is NOT an additive floor that
//    buys nothing: it INCLUDES a month of credits worth exactly its price, at the
//    fixed credit rate. At $20/seat and $0.10/credit that's 200 included credits
//    ($20 of real underlying spend). A light user's work draws down that allowance
//    and never costs more than the seat; a heavy user loads more on top at the
//    same per-credit rate — no tier jump. Included credits reset each month and do
//    not roll over; separately purchased credits never expire.
const SEAT = {
  monthly_usd: 20, // per person, per month — delivered AS this much in credits
};

// CREDIT UNIT — policy, not telemetry. One credit is a FIXED dollar of
// underlying spend, identical across every model. A cheaper model doesn't make a
// credit "worth more" — it simply burns fewer credits for the same task, because
// the same real dollars bought it. Change this constant and every credit figure
// on the page rescales together.
const CREDIT = {
  usd_per_credit: 0.1, // 1 credit = $0.10 of underlying spend — the fixed unit
};

// Load amounts a reader might top up with. Used only to answer "I load $X, now
// what" — the counts they map to are derived from real task cost below.
const LOAD_BUDGETS = [5, 20, 50]; // USD

// Convert a dollar figure to credits at the fixed rate.
const toCredits = (usd, dp = 1) => round(usd / CREDIT.usd_per_credit, dp);

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

const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

// Map a raw model id to one of our displayed rate tiers (for the worked example
// / breakdown labels). Falls back to the raw id when it doesn't match a tier.
function tierFor(model) {
  if (model.startsWith("claude-opus")) return "claude-opus";
  if (model.startsWith("claude-sonnet")) return "claude-sonnet";
  if (model.startsWith("claude-haiku")) return "claude-haiku";
  if (model.startsWith("claude-fable")) return "claude-fable";
  if (model.startsWith("gpt-5.6-terra")) return "gpt-5.6-terra";
  if (model.startsWith("gpt-5.6-luna")) return "gpt-5.6-luna";
  return model;
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

// Only runs that carry a real cost figure count toward dollar statistics.
const costed = runs.filter((r) => typeof r.cost_usd === "number" && r.cost_usd >= 0);
const walled = runs.filter(
  (r) => typeof r.wall_clock_seconds === "number" && r.wall_clock_seconds >= 0,
);

// ---------------------------------------------------------------------------
// Cost per run: median + p90
// ---------------------------------------------------------------------------

const costs = costed.map((r) => r.cost_usd).sort((a, b) => a - b);
const costPerRun = {
  median: round(percentile(costs, 50), 4),
  p90: round(percentile(costs, 90), 4),
};

// ---------------------------------------------------------------------------
// Wall clock per run: median + p90
// ---------------------------------------------------------------------------

const walls = walled.map((r) => r.wall_clock_seconds).sort((a, b) => a - b);
const wallClock = {
  median_seconds: round(percentile(walls, 50), 1),
  p90_seconds: round(percentile(walls, 90), 1),
};

// ---------------------------------------------------------------------------
// Cost broken down by harness and by model
// ---------------------------------------------------------------------------

function breakdown(keyFn) {
  const groups = {};
  for (const r of costed) {
    const k = keyFn(r);
    (groups[k] ||= []).push(r.cost_usd);
  }
  return Object.entries(groups)
    .map(([key, arr]) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      return {
        key,
        runs: arr.length,
        median_cost: round(percentile(sorted, 50), 4),
        total_cost: round(arr.reduce((a, b) => a + b, 0), 2),
      };
    })
    .sort((a, b) => b.total_cost - a.total_cost);
}

const byHarness = breakdown((r) => r.harness || "unknown");
const byModel = breakdown((r) => r.model || "unknown");

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
// Worked example — a REAL ticket (task_id), its REAL total cost, itemised into
// the three cost lines. Selected deterministically: among substantial tickets (>= 3
// runs, at least one review cycle, total cost in a sane band), take the one
// whose total cost is the median. Same data in => same ticket out.
// ---------------------------------------------------------------------------

const byTask = {};
for (const r of runs) {
  if (!r.task_id) continue;
  (byTask[r.task_id] ||= []).push(r);
}

const tickets = Object.entries(byTask)
  .map(([id, rs]) => {
    const cost = rs.reduce((a, r) => a + (r.cost_usd || 0), 0);
    const wall = rs.reduce((a, r) => a + (r.wall_clock_seconds || 0), 0);
    const rc = rs.reduce((a, r) => a + (r.review_cycles || 0), 0);
    const models = {};
    for (const r of rs) {
      const t = tierFor(r.model || "unknown");
      (models[t] ||= { runs: 0, cost: 0 });
      models[t].runs += 1;
      models[t].cost += r.cost_usd || 0;
    }
    return { id, runs: rs.length, cost, wall, review_cycles: rc, models };
  })
  .filter((t) => t.runs >= 3 && t.review_cycles >= 1 && t.cost > 0.5 && t.cost < 15)
  .sort((a, b) => a.cost - b.cost);

if (tickets.length === 0) {
  console.error("FATAL: no ticket matched the worked-example criteria.");
  process.exit(1);
}

const chosen = tickets[Math.floor((tickets.length - 1) / 2)];

// Itemise the chosen ticket into the three cost lines. The model-cost line is the sum
// of the displayed per-tier costs so the itemisation adds up exactly on-page.
const exTiers = Object.entries(chosen.models)
  .map(([tier, v]) => ({ tier, runs: v.runs, cost: round(v.cost, 2) }))
  .sort((a, b) => b.cost - a.cost);
const exModel = round(exTiers.reduce((a, t) => a + t.cost, 0), 2);
const exCompute = round((chosen.wall / 3600) * COMPUTE_RATE.per_hour, 2);
const exPlatform = round(((exModel + exCompute) * PLATFORM_FEE.pct) / 100, 2);
const exTotal = round(exModel + exCompute + exPlatform, 2);

const workedExample = {
  ticket: chosen.id,
  runs: chosen.runs,
  wall_clock_seconds: round(chosen.wall, 1),
  review_cycles: chosen.review_cycles,
  models: exTiers,
  lines: {
    model_cost: exModel,
    compute_cost: exCompute,
    platform_fee: exPlatform,
    total: exTotal,
    total_credits: toCredits(exTotal),
  },
};

// ---------------------------------------------------------------------------
// Task-level cost — the number a reader actually loads against. A "task" is one
// ticket (task_id); its cost is the sum of every agent run under it. This is the
// unit that answers "I load $5, now what". Every figure below is a real task's
// real cost, expressed in dollars AND in the fixed credit unit.
// ---------------------------------------------------------------------------

const allTasks = Object.entries(byTask)
  .map(([id, rs]) => {
    const cost = rs.reduce((a, r) => a + (r.cost_usd || 0), 0);
    const wall = rs.reduce((a, r) => a + (r.wall_clock_seconds || 0), 0);
    const rc = rs.reduce((a, r) => a + (r.review_cycles || 0), 0);
    const ts = rs
      .map((r) => r.timestamp)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || null;
    return { id, runs: rs.length, cost, wall, review_cycles: rc, last_ts: ts };
  })
  .filter((t) => t.cost > 0);

const taskCostsAsc = allTasks.map((t) => t.cost).sort((a, b) => a - b);

// "What $5 buys" — three concrete size bands drawn straight from the task-cost
// distribution. Each band is anchored to a percentile, then resolved to the REAL
// task nearest that percentile so the example is an actual ticket, not an
// interpolated ghost. The counts are just budget ÷ that task's real cost.
const EXAMPLE_BANDS = [
  { key: "quick", label: "a quick fix", pct: 10 },
  { key: "small", label: "a small feature", pct: 25 },
  { key: "typical", label: "a typical task", pct: 50 },
];

const loadExamples = EXAMPLE_BANDS.map((band) => {
  const target = percentile(taskCostsAsc, band.pct);
  // nearest real task to the percentile value
  const rep = allTasks
    .slice()
    .sort((a, b) => Math.abs(a.cost - target) - Math.abs(b.cost - target))[0];
  const cost = round(rep.cost, 2);
  return {
    key: band.key,
    label: band.label,
    percentile: band.pct,
    example_ticket: rep.id,
    runs: rep.runs,
    cost_usd: cost,
    credits: toCredits(cost),
    // how many of THIS task each load amount covers
    covers: LOAD_BUDGETS.map((b) => ({ budget_usd: b, count: Math.floor(b / cost) })),
  };
});

// Recent real tasks -> credits spent. The most recent finished tickets, newest
// first, each shown in both dollars and the fixed credit unit.
const recentTasks = allTasks
  .filter((t) => t.last_ts)
  .sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1))
  .slice(0, 8)
  .map((t) => ({
    id: t.id,
    runs: t.runs,
    review_cycles: t.review_cycles,
    last_ts: t.last_ts,
    cost_usd: round(t.cost, 2),
    credits: toCredits(round(t.cost, 2)),
  }));

// The seat, expressed as the plan it is: a monthly price that arrives AS credits.
// $20 at $0.10/credit = 200 included credits ($20 of real spend). Included credits
// reset monthly (no roll-over); separately purchased credits never expire.
const seat = {
  monthly_usd: SEAT.monthly_usd,
  included_usd: SEAT.monthly_usd, // the seat price is delivered as credits
  included_credits: toCredits(SEAT.monthly_usd, 0), // 200 at $0.10
  included_reset: "monthly", // included credits reset each month; no roll-over
  included_rolls_over: false,
  purchased_expires: false, // separately purchased credits never expire
};

const loadValue = {
  budgets_usd: LOAD_BUDGETS,
  task_count: allTasks.length,
  task_cost: {
    median_usd: round(percentile(taskCostsAsc, 50), 2),
    median_credits: toCredits(round(percentile(taskCostsAsc, 50), 2)),
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
  rate_table_effective_date: data.rate_table_effective_date || null,

  // headline counts
  total_runs: runs.length,
  costed_runs: costed.length,
  unrated_model_sessions: data.unrated_model_sessions?.count ?? 0,

  // statistics (measured)
  cost_per_run: costPerRun,
  wall_clock: wallClock,
  cost_by_harness: byHarness,
  cost_by_model: byModel,
  review_cycle_distribution: reviewCycles,

  // pricing inputs (policy)
  model_rates: MODEL_RATES,
  compute_rate: COMPUTE_RATE,
  platform_fee: PLATFORM_FEE,
  seat,
  credit: CREDIT,

  // "I load $5, now what" — load-value examples + recent tasks in credits
  load_value: loadValue,

  // the worked example
  worked_example: workedExample,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

console.log(`Wrote ${OUT}`);
console.log(`  runs: ${out.total_runs} (costed: ${out.costed_runs})`);
console.log(`  median cost/run: $${out.cost_per_run.median}  p90: $${out.cost_per_run.p90}`);
console.log(`  median wall: ${out.wall_clock.median_seconds}s  p90: ${out.wall_clock.p90_seconds}s`);
console.log(`  worked example: ${chosen.id} -> $${exTotal} total`);
console.log(`  credit unit: 1 credit = $${CREDIT.usd_per_credit} · median task ${loadValue.task_cost.median_credits} credits ($${loadValue.task_cost.median_usd})`);
console.log(`  load examples: ${loadExamples.map((e) => `${e.label} $${e.cost_usd}`).join(", ")}`);
