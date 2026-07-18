#!/usr/bin/env bun
/**
 * Golden relevance benchmark for the production MemoryStore recall path.
 *
 * Run: bun run recall:bench
 *      bun run recall:bench -- --json
 *
 * The runner stages the read-only source corpora into a temporary memory directory, then calls
 * `MemoryStore.recall()` once per case. That is the same graph build → Moss sync → hybrid
 * score → in-code visibility gate used by `beckett recall`; staging only keeps `.moss/` out of
 * the canonical memory directories.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildPaths } from "../../src/paths.ts";
import { loadConfig } from "../../src/config.ts";
import { createMemory } from "../../src/memory/index.ts";
import type { Audience } from "../../src/memory/search.ts";
import type { Logger } from "../../src/types.ts";
import { mean, scoreRanking } from "./recall-relevance-lib.ts";

interface GoldenTarget {
  name: string;
  file: string;
}

interface GoldenCase {
  id: string;
  query: string;
  targets: GoldenTarget[];
  audience?: Audience;
}

interface GoldenSet {
  version: number;
  description: string;
  defaultAudience: Audience;
  cases: GoldenCase[];
}

interface Source {
  label: string;
  dir: string;
}

const GOLDEN_PATH = new URL("./recall-relevance-golden.json", import.meta.url);
const DEFAULT_LEGACY_DIR = join(homedir(), ".claude", "projects", "-home-beckett-beckett", "memory");
const PRECISION_K = 1;
const RETRIEVAL_K = 10;

const quietLog: Logger = (() => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  return logger as unknown as Logger;
})();

function usage(): never {
  throw new Error(
    "usage: bun run recall:bench [-- --json] [--memory-dir <dir>] [--legacy-memory-dir <dir>]",
  );
}

function parseArgs(argv: string[]): { json: boolean; memoryDir?: string; legacyMemoryDir?: string } {
  let json = false;
  let memoryDir: string | undefined;
  let legacyMemoryDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--memory-dir") memoryDir = argv[++i] ?? usage();
    else if (arg === "--legacy-memory-dir") legacyMemoryDir = argv[++i] ?? usage();
    else usage();
  }
  return { json, memoryDir, legacyMemoryDir };
}

/** Copy markdown only, excluding generated indexes, archives, git metadata, and Moss caches. */
function stageSource(source: Source, destination: string): number {
  if (!existsSync(source.dir)) {
    throw new Error(`required ${source.label} corpus is missing: ${source.dir}`);
  }
  let copied = 0;
  for (const rel of readdirSync(source.dir, { recursive: true }) as string[]) {
    if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
    const parts = rel.split(/[\\/]/);
    if (parts.includes(".git") || parts.includes(".moss") || parts.includes("archive")) continue;
    const target = join(destination, source.label, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source.dir, rel), target);
    copied++;
  }
  return copied;
}

function format(value: number): string {
  return value.toFixed(3);
}

const args = parseArgs(process.argv.slice(2));
const golden = JSON.parse(await Bun.file(GOLDEN_PATH).text()) as GoldenSet;
if (golden.version !== 1 || golden.cases.length < 20) {
  throw new Error("golden set must be version 1 and contain at least 20 cases");
}

// This resolves exactly as the CLI does: config [paths] first, with BECKETT_DIR overrides.
const cliMemoryDir = args.memoryDir ?? buildPaths(loadConfig()).memoryDir;
const legacyMemoryDir = args.legacyMemoryDir ?? process.env.BECKETT_RECALL_BENCH_LEGACY_MEMORY ?? DEFAULT_LEGACY_DIR;
const sources: Source[] = [
  { label: "live", dir: cliMemoryDir },
  { label: "legacy", dir: legacyMemoryDir },
];
const stagedDir = mkdtempSync(join(tmpdir(), "beckett-recall-relevance-"));

try {
  const copied = Object.fromEntries(sources.map((source) => [source.label, stageSource(source, stagedDir)]));
  const memory = createMemory({ memoryDir: stagedDir, logger: quietLog, git: false });
  const graph = memory.buildGraph();
  const targetNames = new Set(golden.cases.flatMap((test) => test.targets.map((target) => target.name)));
  const missing = [...targetNames].filter((name) => !graph.nodes.has(name));
  if (missing.length > 0) {
    throw new Error(`golden target(s) missing after staging: ${missing.join(", ")}`);
  }

  const rows = [];
  for (const test of golden.cases) {
    const result = await memory.recall({
      text: test.query,
      k: RETRIEVAL_K,
      audience: test.audience ?? golden.defaultAudience,
    });
    // Moss can emit equal-score tail hits in native-index order. Canonicalize only exact ties
    // for a stable report; all scores and candidates still came from MemoryStore.recall.
    const returned = [...result.hits]
      .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
      .map((hit) => hit.node.name);
    const metrics = scoreRanking(returned, test.targets.map((target) => target.name), PRECISION_K);
    rows.push({
      id: test.id,
      query: test.query,
      targets: test.targets,
      returned,
      ...metrics,
    });
  }

  const aggregate = {
    queries: rows.length,
    precisionAt1: mean(rows.map((row) => row.precisionAtK)),
    mrr: mean(rows.map((row) => row.reciprocalRank)),
    ndcgAt10: mean(rows.map((row) => row.ndcgAt10)),
  };
  // A compact headline only; retain all three standard metrics below for tuning decisions.
  const overallRelevanceScore = mean([aggregate.precisionAt1, aggregate.mrr, aggregate.ndcgAt10]);
  const report = {
    corpus: {
      cliMemoryDir,
      legacyMemoryDir,
      copied,
      parsedNodes: [...graph.nodes.values()].filter((node) => !node.phantom).length,
    },
    retrieval: { k: RETRIEVAL_K, precisionAtK: PRECISION_K },
    aggregate: { ...aggregate, overallRelevanceScore },
    queries: rows,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("# Recall relevance benchmark");
    console.log(`Corpus: CLI root ${cliMemoryDir} (${copied.live} files) + retained legacy root ${legacyMemoryDir} (${copied.legacy} files); ${report.corpus.parsedNodes} parsed nodes.`);
    console.log(`Retrieval: real MemoryStore.recall, k=${RETRIEVAL_K}; exact-score ties sort by node name; metrics: precision@${PRECISION_K}, MRR, nDCG@10.`);
    console.log("");
    console.log("## Aggregate");
    console.log(`overall relevance score: ${format(overallRelevanceScore)}`);
    console.log(`precision@${PRECISION_K}: ${format(aggregate.precisionAt1)}  MRR: ${format(aggregate.mrr)}  nDCG@10: ${format(aggregate.ndcgAt10)}`);
    console.log("");
    console.log("## Per query");
    console.log("| case | first relevant rank | P@1 | MRR | nDCG@10 | expected file(s) | top results |");
    console.log("|---|---:|---:|---:|---:|---|---|");
    for (const row of rows) {
      console.log(
        `| ${row.id} | ${row.firstRelevantRank ?? "—"} | ${format(row.precisionAtK)} | ${format(row.reciprocalRank)} | ${format(row.ndcgAt10)} | ${row.targets.map((target) => target.file).join(", ")} | ${row.returned.slice(0, 5).join(", ") || "—"} |`,
      );
    }
  }
} finally {
  rmSync(stagedDir, { recursive: true, force: true });
}
