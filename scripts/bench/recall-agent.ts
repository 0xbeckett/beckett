#!/usr/bin/env bun
/**
 * Memory-agent recall benchmark — luna (pi) vs haiku (claude -p) on the #34.1 golden set.
 *
 * Run: bun run recall:agent-bench                 # both seats, all pairs
 *      bun run recall:agent-bench -- --json       # machine-readable
 *      bun run recall:agent-bench -- --models luna --limit 10 --concurrency 4
 *
 * The recall path under test is the production one (issue #26): `MemoryStore.recallAgentic`
 * stages moss retrieval → the fail-closed visibility gate (in code) → a small LLM agent that
 * reads ONLY the gated candidates and returns a ranked citation or a clean PASS. The agent's
 * model is reached through `claude -p` / `pi` (NEVER the Anthropic API). We score the agent's
 * `noteIds` ranking against the golden labels (same P@1/P@5/MRR as the score-ranked bench,
 * scripts/bench/recall-relevance.ts, so the two are directly comparable) and time each turn to
 * report p50/p95 latency per model.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildPaths } from "../../src/paths.ts";
import { loadConfig } from "../../src/config.ts";
import { createMemory } from "../../src/memory/index.ts";
import { seatModel, type MemoryAgentSeat } from "../../src/memory/agent-recall.ts";
import type { Audience } from "../../src/memory/search.ts";
import type { Logger } from "../../src/types.ts";
import { mean, scoreRanking } from "./recall-relevance-lib.ts";

interface BenchmarkPair {
  id: string;
  category: string;
  question: string;
  expectedNoteIds: string[];
  sourceFiles: string[];
  hardNegativeNoteIds?: string[];
  audience?: Audience;
}
interface BenchmarkSet {
  version: number;
  defaultAudience: Audience;
  categories: string[];
  pairs: BenchmarkPair[];
}

const GOLDEN_PATH = new URL("./recall-relevance-golden.json", import.meta.url);
const DEFAULT_LEGACY_DIR = join(homedir(), ".claude", "projects", "-home-beckett-beckett", "memory");
const ALL_SEATS: MemoryAgentSeat[] = ["luna", "haiku"];

const quietLog: Logger = (() => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as unknown as Logger;
})();

function usage(): never {
  throw new Error("usage: bun run recall:agent-bench [-- --json] [--models luna,haiku] [--limit N] [--concurrency N]");
}

function parseArgs(argv: string[]) {
  let json = false;
  let models: MemoryAgentSeat[] = ALL_SEATS;
  let limit = Infinity;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--models") {
      models = String(argv[++i] ?? usage()).split(",").map((s) => s.trim()).filter(Boolean) as MemoryAgentSeat[];
      if (models.some((m) => !ALL_SEATS.includes(m))) usage();
    } else if (a === "--limit") limit = Number(argv[++i] ?? usage());
    else if (a === "--concurrency") concurrency = Math.max(1, Number(argv[++i] ?? usage()));
    else usage();
  }
  return { json, models, limit, concurrency };
}

/** Copy markdown only, excluding generated indexes, archives, git metadata, and Moss caches. */
function stageSource(label: string, dir: string, destination: string): number {
  if (!existsSync(dir)) throw new Error(`required ${label} corpus is missing: ${dir}`);
  let copied = 0;
  for (const rel of (readdirSync(dir, { recursive: true }) as string[]).sort((a, b) => a.localeCompare(b))) {
    if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
    const parts = rel.split(/[\\/]/);
    if (parts.includes(".git") || parts.includes(".moss") || parts.includes("archive")) continue;
    const target = join(destination, label, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dir, rel), target);
    copied++;
  }
  return copied;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** Run `tasks` with a bounded number in flight at once. */
async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

interface Row {
  id: string;
  category: string;
  precisionAt1: number;
  precisionAt5: number;
  reciprocalRank: number;
  firstRelevantRank: number | null;
  latencyMs: number;
  fallback: boolean;
  pass: boolean;
  noteIds: string[];
}

const args = parseArgs(process.argv.slice(2));
const golden = JSON.parse(await Bun.file(GOLDEN_PATH).text()) as BenchmarkSet;
const pairs = golden.pairs.slice(0, args.limit);

const cliMemoryDir = buildPaths(loadConfig()).memoryDir;
const legacyMemoryDir = process.env.BECKETT_RECALL_BENCH_LEGACY_MEMORY ?? DEFAULT_LEGACY_DIR;
const stagedDir = mkdtempSync(join(tmpdir(), "beckett-recall-agent-"));

try {
  stageSource("live", cliMemoryDir, stagedDir);
  stageSource("legacy", legacyMemoryDir, stagedDir);
  const memory = createMemory({ memoryDir: stagedDir, logger: quietLog, git: false });
  const graph = memory.buildGraph();
  const missing = [...new Set(golden.pairs.flatMap((p) => p.expectedNoteIds))].filter((n) => !graph.nodes.has(n));
  if (missing.length) throw new Error(`expected note(s) missing after staging: ${missing.join(", ")}`);

  const perModel: Record<string, { rows: Row[]; model: string }> = {};

  for (const seat of args.models) {
    const rows: Row[] = new Array(pairs.length);
    if (!args.json) process.stderr.write(`\n▶ running seat ${seat} (${seatModel(seat)}) over ${pairs.length} queries…\n`);
    await pool(pairs, args.concurrency, async (pair, index) => {
      const started = Date.now();
      const { agent } = await memory.recallAgentic(
        { text: pair.question, audience: pair.audience ?? golden.defaultAudience },
        { seat },
      );
      const wall = Date.now() - started;
      const ranked = agent.answer.noteIds;
      const at1 = scoreRanking(ranked, pair.expectedNoteIds, 1);
      const at5 = scoreRanking(ranked, pair.expectedNoteIds, 5);
      rows[index] = {
        id: pair.id,
        category: pair.category,
        precisionAt1: at1.precisionAtK,
        precisionAt5: at5.precisionAtK,
        reciprocalRank: at1.reciprocalRank,
        firstRelevantRank: at1.firstRelevantRank,
        // Prefer the model's own turn latency; fall back to wall-clock if a fallback skipped the call.
        latencyMs: agent.answer.latencyMs || wall,
        fallback: agent.answer.fallback,
        pass: !agent.answer.relevant,
        noteIds: ranked.slice(0, 5),
      };
      if (!args.json) process.stderr.write(".");
    });
    if (!args.json) process.stderr.write("\n");
    perModel[seat] = { rows, model: seatModel(seat) };
  }

  const summarize = (rows: Row[]) => {
    const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    return {
      queries: rows.length,
      precisionAt1: mean(rows.map((r) => r.precisionAt1)),
      precisionAt5: mean(rows.map((r) => r.precisionAt5)),
      mrr: mean(rows.map((r) => r.reciprocalRank)),
      passRate: mean(rows.map((r) => (r.pass ? 1 : 0))),
      fallbackRate: mean(rows.map((r) => (r.fallback ? 1 : 0))),
      p50LatencyMs: Math.round(percentile(lat, 50)),
      p95LatencyMs: Math.round(percentile(lat, 95)),
    };
  };

  const report = {
    corpus: { cliMemoryDir, legacyMemoryDir, parsedNodes: [...graph.nodes.values()].filter((n) => !n.phantom).length },
    queries: pairs.length,
    models: Object.fromEntries(
      Object.entries(perModel).map(([seat, { rows, model }]) => [seat, { model, ...summarize(rows) }]),
    ),
  };

  if (args.json) {
    console.log(JSON.stringify({ ...report, perQuery: perModel }, null, 2));
  } else {
    const fmt = (v: number) => v.toFixed(3);
    console.log("# Memory-agent recall benchmark — luna (pi) vs haiku (claude -p)");
    console.log(`Corpus: ${report.corpus.parsedNodes} graph nodes; ${pairs.length} golden queries (#34.1).`);
    console.log("Retrieval: MemoryStore.recallAgentic (moss top-15 → in-code visibility gate → LLM agent). Model via CLI only.");
    console.log("");
    console.log("| model | seat | queries | P@1 | P@5 | MRR | PASS rate | fallback | p50 ms | p95 ms |");
    console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [seat, { model }] of Object.entries(perModel)) {
      const s = summarize(perModel[seat]!.rows);
      console.log(
        `| ${model} | ${seat} | ${s.queries} | ${fmt(s.precisionAt1)} | ${fmt(s.precisionAt5)} | ${fmt(s.mrr)} | ${fmt(s.passRate)} | ${fmt(s.fallbackRate)} | ${s.p50LatencyMs} | ${s.p95LatencyMs} |`,
      );
    }
  }
} finally {
  rmSync(stagedDir, { recursive: true, force: true });
}
