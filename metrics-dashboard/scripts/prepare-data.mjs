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
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
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
const RECALL_SRC = process.env.RECALL_EVAL_DATASET
  ? resolve(process.env.RECALL_EVAL_DATASET)
  : resolve(REPO_ROOT, "data", "recall-eval.json");
const RECALL_OUT = resolve(__dirname, "..", "src", "generated", "recall.json");

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

// The code-stats harvester owns these aggregates. This projection validates and publishes them
// in the same static JSON document the dashboard already imports.
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

// ── Recall eval (#34.2) ────────────────────────────────────────────────────
// The recall-agent benchmark (scripts/bench/recall-agent.ts) emits a single JSON
// document: aggregate scores per model seat plus a `perQuery` block of per-row
// scores tagged with their golden category. We roll that into the small shapes
// the recall charts consume — per-category P@1/P@5/MRR per seat, the aggregate
// head-to-head, and the latency comparison — the same fail-soft way as above.

// Fixed seat presentation. luna (pi) vs haiku (claude -p); colours match the
// telemetry model palette so a reader who sees both pages keeps one mental map.
const SEAT_META = {
  luna: { label: "luna", color: "pink" },
  haiku: { label: "haiku", color: "green" },
};
// Golden categories → short, glanceable axis labels.
const CATEGORY_LABEL = {
  feedback: "Feedback",
  "people-profile": "People",
  "project-status": "Project",
  "environment-setup": "Environment",
  adversarial: "Adversarial",
};
function categoryLabel(cat) {
  if (CATEGORY_LABEL[cat]) return CATEGORY_LABEL[cat];
  return String(cat)
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function recallForDashboard(raw, generatedAt) {
  const empty = {
    schema_version: 1,
    generated_at: generatedAt,
    available: false,
    corpus: { parsedNodes: 0, cliMemoryDir: null, legacyMemoryDir: null },
    queries: 0,
    models: [],
    categories: [],
    aggregate: [],
    perCategory: { precisionAt1: [], precisionAt5: [], mrr: [] },
    latency: [],
  };
  if (!raw || typeof raw !== "object" || !raw.models || !raw.perQuery) return empty;

  // Seats present in the run, in a stable presentation order (luna then haiku).
  const seats = Object.keys(SEAT_META).filter((s) => raw.models[s] && raw.perQuery[s]);
  if (seats.length === 0) return empty;

  const models = seats.map((seat) => {
    const m = raw.models[seat] ?? {};
    const meta = SEAT_META[seat];
    return {
      seat,
      model: text(m.model) ?? seat,
      label: meta.label,
      color: meta.color,
      queries: nonNegative(m.queries),
      precisionAt1: round(num(m.precisionAt1) ?? 0, 3),
      precisionAt5: round(num(m.precisionAt5) ?? 0, 3),
      mrr: round(num(m.mrr) ?? 0, 3),
      passRate: round(num(m.passRate) ?? 0, 3),
      fallbackRate: round(num(m.fallbackRate) ?? 0, 3),
      p50LatencyMs: nonNegative(m.p50LatencyMs),
      p95LatencyMs: nonNegative(m.p95LatencyMs),
    };
  });

  // Per-category means, computed from the per-query rows (the aggregate block is
  // corpus-wide only). Row scores are already 0..1 per the golden labels.
  const catOrder = [];
  const catRows = new Map(); // category -> { seat -> {p1:[], p5:[], mrr:[]} }
  for (const seat of seats) {
    const rows = Array.isArray(raw.perQuery[seat]?.rows) ? raw.perQuery[seat].rows : [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const cat = text(r.category);
      if (!cat) continue;
      if (!catRows.has(cat)) {
        catRows.set(cat, {});
        catOrder.push(cat);
      }
      const bySeat = catRows.get(cat);
      const acc = bySeat[seat] ?? { p1: [], p5: [], mrr: [] };
      acc.p1.push(num(r.precisionAt1) ?? 0);
      acc.p5.push(num(r.precisionAt5) ?? 0);
      acc.mrr.push(num(r.reciprocalRank) ?? 0);
      bySeat[seat] = acc;
    }
  }

  const categories = catOrder.map((cat) => {
    const bySeat = catRows.get(cat);
    const perSeat = {};
    let n = 0;
    for (const seat of seats) {
      const acc = bySeat[seat] ?? { p1: [], p5: [], mrr: [] };
      n = Math.max(n, acc.p1.length);
      perSeat[seat] = {
        precisionAt1: round(mean(acc.p1), 3),
        precisionAt5: round(mean(acc.p5), 3),
        mrr: round(mean(acc.mrr), 3),
        queries: acc.p1.length,
      };
    }
    return { category: cat, label: categoryLabel(cat), queries: n, byModel: perSeat };
  });

  // Grouped-bar rows: one entry per category, a value column per seat.
  const perCatFor = (metric) =>
    categories.map((c) => {
      const row = { label: c.label, category: c.category };
      for (const seat of seats) row[seat] = c.byModel[seat][metric];
      return row;
    });

  // Aggregate head-to-head: the three headline scores side by side per seat.
  const aggMetric = (key, label) => {
    const row = { label };
    for (const m of models) row[m.seat] = m[key];
    return row;
  };

  const latMetric = (key, label) => {
    const row = { label };
    for (const m of models) row[m.seat] = m[key];
    return row;
  };

  const corpus = raw.corpus && typeof raw.corpus === "object" ? raw.corpus : {};
  return {
    schema_version: 1,
    generated_at: generatedAt,
    available: true,
    corpus: {
      parsedNodes: nonNegative(corpus.parsedNodes),
      cliMemoryDir: text(corpus.cliMemoryDir),
      legacyMemoryDir: text(corpus.legacyMemoryDir),
    },
    queries: nonNegative(raw.queries),
    models,
    categories,
    aggregate: [
      aggMetric("precisionAt1", "P@1"),
      aggMetric("precisionAt5", "P@5"),
      aggMetric("mrr", "MRR"),
    ],
    perCategory: {
      precisionAt1: perCatFor("precisionAt1"),
      precisionAt5: perCatFor("precisionAt5"),
      mrr: perCatFor("mrr"),
    },
    latency: [latMetric("p50LatencyMs", "p50"), latMetric("p95LatencyMs", "p95")],
  };
}

function writeRecall() {
  let rawRecall = null;
  try {
    rawRecall = JSON.parse(readFileSync(RECALL_SRC, "utf8"));
  } catch (err) {
    console.error(
      `[prepare-data] recall eval dataset unavailable at ${RECALL_SRC}: ${err.message}; emitting empty recall`
    );
  }
  // Stamp with the dataset file's mtime so the page can show when the eval ran,
  // without the benchmark itself having to emit a timestamp.
  let generatedAt = null;
  try {
    generatedAt = statSync(RECALL_SRC).mtime.toISOString();
  } catch {
    /* no dataset — leave null */
  }
  const recall = recallForDashboard(rawRecall, generatedAt);
  mkdirSync(dirname(RECALL_OUT), { recursive: true });
  writeFileSync(RECALL_OUT, `${JSON.stringify(recall, null, 2)}\n`);
  console.error(
    `[prepare-data] recall: ${recall.available ? "ok" : "EMPTY"} · ${recall.queries} queries · ` +
      `${recall.models.length} seats · ${recall.categories.length} categories → ${RECALL_OUT}`
  );
}

main();
writeRecall();
