#!/usr/bin/env node
/*
 * Build-time aggregator.
 *
 * Reads the harvester's single normalized dataset (ticket #8 — data/telemetry-runs.json,
 * one row per run) and rolls it up into the small shapes the dashboard charts consume.
 * The harvester is the source of truth: we do NOT recompute cost or cycle counts here,
 * we only SUM and COUNT the fields it already emitted. Missing fields degrade to skips,
 * never a crash — matching the harvester's own fail-soft contract.
 *
 * Output: src/generated/metrics.json  (tiny, committed alongside the build so the
 * static site never ships the ~800KB raw dataset to the browser).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SRC = process.env.TELEMETRY_DATASET
  ? resolve(process.env.TELEMETRY_DATASET)
  : resolve(REPO_ROOT, "data", "telemetry-runs.json");
const CODE_STATS_SRC = process.env.CODE_STATS_DATASET
  ? resolve(process.env.CODE_STATS_DATASET)
  : resolve(REPO_ROOT, "data", "code-stats.json");
const OUT = resolve(__dirname, "..", "src", "generated", "metrics.json");

// Display label + dither-kit palette colour per model. Any model the harvester
// emits that we don't recognise still renders — it falls through to "grey".
const MODEL_META = {
  "claude-opus-4-8": { label: "opus-4.8", color: "red" },
  "claude-sonnet-5": { label: "sonnet-5", color: "blue" },
  "claude-haiku-4-5-20251001": { label: "haiku-4.5", color: "green" },
  "claude-fable-5": { label: "fable-5", color: "purple" },
  "gpt-5.6-terra": { label: "terra", color: "orange" },
  "gpt-5.6-luna": { label: "luna", color: "pink" },
};
const FALLBACK_COLORS = ["blue", "green", "purple", "orange", "pink", "red"];

function metaFor(model, idx) {
  if (MODEL_META[model]) return MODEL_META[model];
  // Unknown model: keep it legible, give it a stable colour off the ramp.
  const short = model.replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
  return { label: short, color: FALLBACK_COLORS[idx % FALLBACK_COLORS.length] };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === "string" ? v : null);
const nonNegative = (v) => Math.max(0, num(v) ?? 0);

// The code-stats harvester owns these aggregates. This projection only removes local paths
// before publishing the same static JSON document the dashboard already imports.
function codeStatsForDashboard(raw) {
  const empty = {
    source_generated_at: null,
    headline: { commits: 0, files: 0, projects: 0, additions: 0, deletions: 0, net: 0 },
    projects: [], authors: [], velocity: [],
  };
  if (!raw || typeof raw !== "object") return empty;
  const headline = raw.headline && typeof raw.headline === "object" ? raw.headline : {};
  return {
    source_generated_at: text(raw.generated_at),
    headline: {
      commits: nonNegative(headline.commits), files: nonNegative(headline.files), projects: nonNegative(headline.projects),
      additions: nonNegative(headline.additions), deletions: nonNegative(headline.deletions), net: num(headline.net) ?? 0,
    },
    projects: Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p === "object").map((p) => ({
      repo: text(p.repo) ?? "unknown", commits: nonNegative(p.commits), files: nonNegative(p.files),
      additions: nonNegative(p.additions), deletions: nonNegative(p.deletions), net: num(p.net) ?? 0,
      first_commit: text(p.first_commit), last_commit: text(p.last_commit),
    })) : [],
    authors: Array.isArray(raw.authors) ? raw.authors.filter((a) => a && typeof a === "object").map((a) => ({
      author: text(a.author) ?? "unknown", name: text(a.name) ?? "unknown",
      commits: nonNegative(a.commits), additions: nonNegative(a.additions), deletions: nonNegative(a.deletions), net: num(a.net) ?? 0,
    })) : [],
    velocity: Array.isArray(raw.velocity) ? raw.velocity.filter((v) => v && typeof v === "object" && text(v.date)).map((v) => ({
      date: v.date, commits: nonNegative(v.commits),
    })) : [],
  };
}

function main() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(SRC, "utf8"));
  } catch (err) {
    console.error(`[prepare-data] cannot read dataset at ${SRC}: ${err.message}`);
    process.exit(1);
  }

  let rawCodeStats = null;
  try { rawCodeStats = JSON.parse(readFileSync(CODE_STATS_SRC, "utf8")); }
  catch (err) { console.error(`[prepare-data] code-stats dataset unavailable at ${CODE_STATS_SRC}: ${err.message}; emitting empty code stats`); }

  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  if (runs.length === 0) {
    console.error("[prepare-data] dataset has no runs — emitting empty aggregates");
  }

  const perModel = new Map(); // model -> {runs, cost, wallSeconds}
  const perDay = new Map(); // yyyy-mm-dd -> {runs, cost}
  const cyclesHist = new Map(); // cycles -> count
  const harnesses = new Map(); // harness -> count
  let totalCost = 0;
  let totalWall = 0;
  let skippedRows = 0;

  for (const r of runs) {
    if (!r || typeof r !== "object") {
      skippedRows++;
      continue;
    }
    const model = typeof r.model === "string" && r.model ? r.model : null;
    if (!model) {
      skippedRows++;
      continue;
    }
    const cost = num(r.cost_usd) ?? 0;
    const wall = num(r.wall_clock_seconds) ?? 0;

    const pm = perModel.get(model) ?? {
      runs: 0,
      cost: 0,
      wallSeconds: 0,
      estimate: false,
    };
    pm.runs += 1;
    pm.cost += cost;
    pm.wallSeconds += wall;
    if (r.rate_estimate === true) pm.estimate = true;
    perModel.set(model, pm);

    totalCost += cost;
    totalWall += wall;

    // Review-cycle histogram (integer bounces). Non-numeric → skip that axis only.
    const cyc = num(r.review_cycles);
    if (cyc !== null) {
      const key = Math.max(0, Math.round(cyc));
      cyclesHist.set(key, (cyclesHist.get(key) ?? 0) + 1);
    }

    // Runs over time, bucketed by UTC calendar day of the run's start timestamp.
    if (typeof r.timestamp === "string" && r.timestamp.length >= 10) {
      const day = r.timestamp.slice(0, 10);
      const pd = perDay.get(day) ?? { runs: 0, cost: 0 };
      pd.runs += 1;
      pd.cost += cost;
      perDay.set(day, pd);
    }

    if (typeof r.harness === "string" && r.harness) {
      harnesses.set(r.harness, (harnesses.get(r.harness) ?? 0) + 1);
    }
  }

  // Models sorted by spend (most expensive first) — the story leads with cost.
  const modelsByCost = [...perModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const models = modelsByCost.map(([model, agg], idx) => {
    const meta = metaFor(model, idx);
    return {
      model,
      label: meta.label,
      color: meta.color,
      runs: agg.runs,
      cost: round(agg.cost, 2),
      wallHours: round(agg.wallSeconds / 3600, 2),
      estimate: agg.estimate,
    };
  });

  // Fill any gap days between first and last run so the timeline reads honestly.
  const days = [...perDay.keys()].sort();
  let runsOverTime = [];
  if (days.length > 0) {
    const start = new Date(`${days[0]}T00:00:00Z`);
    const end = new Date(`${days[days.length - 1]}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const pd = perDay.get(key) ?? { runs: 0, cost: 0 };
      runsOverTime.push({ date: key, runs: pd.runs, cost: round(pd.cost, 2) });
    }
  }

  const maxCycle = cyclesHist.size ? Math.max(...cyclesHist.keys()) : 0;
  const reviewCycles = [];
  for (let c = 0; c <= maxCycle; c++) {
    reviewCycles.push({ cycles: c, label: String(c), count: cyclesHist.get(c) ?? 0 });
  }

  const harnessList = [...harnesses.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([harness, count]) => ({ harness, count }));

  const out = {
    schema_version: 1,
    source_generated_at: raw.generated_at ?? null,
    rate_table_effective_date: raw.rate_table_effective_date ?? null,
    headline: {
      totalRuns: runs.length - skippedRows,
      totalSpend: round(totalCost, 2),
      totalWallHours: round(totalWall / 3600, 1),
      modelsUsed: perModel.size,
      firstRun: days[0] ?? null,
      lastRun: days[days.length - 1] ?? null,
      tasksTracked: null, // populated below
    },
    models,
    reviewCycles,
    runsOverTime,
    harnesses: harnessList,
    // Same generated metrics.json API as telemetry; populated from data/code-stats.json.
    codeStats: codeStatsForDashboard(rawCodeStats),
    notes: {
      skippedRows,
      anyEstimated: models.some((m) => m.estimate),
    },
  };

  // Distinct task ids the harvester attributed to runs (for the headline strip).
  const taskIds = new Set();
  for (const r of runs) if (r && r.task_id) taskIds.add(r.task_id);
  out.headline.tasksTracked = taskIds.size;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.error(
    `[prepare-data] ${out.headline.totalRuns} runs · $${out.headline.totalSpend} · ` +
      `${models.length} models · ${runsOverTime.length} days · ${skippedRows} skipped → ${OUT}`
  );
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

main();
