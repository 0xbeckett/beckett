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

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildPaths } from "../../src/paths.ts";
import { loadConfig } from "../../src/config.ts";
import { createMemory } from "../../src/memory/index.ts";
import type { Audience } from "../../src/memory/search.ts";
import type { Logger } from "../../src/types.ts";
import { mean, scoreRanking } from "./recall-relevance-lib.ts";

type BenchmarkCategory = "feedback" | "people-profile" | "project-status" | "environment-setup" | "adversarial";

/** A versioned, human-authored question grounded in one or more canonical note files. */
interface BenchmarkPair {
  id: string;
  category: BenchmarkCategory;
  question: string;
  expectedNoteIds: string[];
  /** Staged paths proving which real note(s) were read to author the labels. */
  sourceFiles: string[];
  /** Lexically tempting notes that are explicitly wrong for this question. */
  hardNegativeNoteIds?: string[];
  audience?: Audience;
}

interface BenchmarkSet {
  version: number;
  description: string;
  defaultAudience: Audience;
  categories: BenchmarkCategory[];
  pairs: BenchmarkPair[];
}

interface BenchmarkRow {
  id: string;
  category: BenchmarkCategory;
  question: string;
  expectedNoteIds: string[];
  hardNegativeNoteIds: string[];
  sourceFiles: string[];
  topResults: string[];
  precisionAt1: number;
  precisionAt5: number;
  reciprocalRank: number;
  ndcgAt10: number;
  firstRelevantRank: number | null;
  hardNegativeRanks: { noteId: string; rank: number | null }[];
}

interface Summary {
  queries: number;
  precisionAt1: number;
  precisionAt5: number;
  mrr: number;
  hardNegativeAt1: number;
}

interface Source {
  label: string;
  dir: string;
}

const GOLDEN_PATH = new URL("./recall-relevance-golden.json", import.meta.url);
const DEFAULT_LEGACY_DIR = join(homedir(), ".claude", "projects", "-home-beckett-beckett", "memory");
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
  // Directory enumeration order is not a portability guarantee. A canonical insertion order
  // makes a freshly staged Moss index reproducible across runs and filesystems.
  for (const rel of (readdirSync(source.dir, { recursive: true }) as string[]).sort((a, b) => a.localeCompare(b))) {
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

/** Parse the derived MEMORY.md indexes too, without treating them as duplicate graph nodes. */
function indexedNoteIds(source: Source): string[] {
  const indexPath = join(source.dir, "MEMORY.md");
  if (!existsSync(indexPath)) throw new Error(`required ${source.label} MEMORY.md is missing: ${indexPath}`);
  const text = readFileSync(indexPath, "utf8");
  const ids = [
    ...text.matchAll(/\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g),
    ...text.matchAll(/\]\(([a-z0-9-]+)\.md\)/g),
  ].map((match) => match[1]!);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function validateSet(set: BenchmarkSet): void {
  const requiredCategories: BenchmarkCategory[] = ["feedback", "people-profile", "project-status", "environment-setup", "adversarial"];
  if (set.version !== 2 || set.pairs.length < 80 || set.pairs.length > 150) {
    throw new Error("benchmark set must be version 2 and contain 80–150 pairs");
  }
  if (new Set(set.categories).size !== requiredCategories.length || !requiredCategories.every((category) => set.categories.includes(category))) {
    throw new Error(`benchmark set categories must be exactly: ${requiredCategories.join(", ")}`);
  }
  const ids = new Set<string>();
  const categoryCounts = new Map<BenchmarkCategory, number>();
  for (const pair of set.pairs) {
    if (ids.has(pair.id)) throw new Error(`duplicate benchmark pair id: ${pair.id}`);
    ids.add(pair.id);
    if (!requiredCategories.includes(pair.category)) throw new Error(`invalid category on ${pair.id}`);
    if (!pair.question.trim() || pair.expectedNoteIds.length === 0 || pair.sourceFiles.length === 0) {
      throw new Error(`pair ${pair.id} needs a question, expected note id(s), and source file(s)`);
    }
    if (pair.hardNegativeNoteIds?.some((id) => pair.expectedNoteIds.includes(id))) {
      throw new Error(`pair ${pair.id} labels a note both expected and hard-negative`);
    }
    categoryCounts.set(pair.category, (categoryCounts.get(pair.category) ?? 0) + 1);
  }
  // A stratified corpus should not quietly regress into one dominant category.
  for (const category of requiredCategories) {
    const count = categoryCounts.get(category) ?? 0;
    if (count < 10 || count > Math.ceil(set.pairs.length * 0.35)) {
      throw new Error(`category ${category} must have 10–35% of pairs; found ${count}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const golden = JSON.parse(await Bun.file(GOLDEN_PATH).text()) as BenchmarkSet;
validateSet(golden);

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
  // MEMORY.md is a derived index, not a graph node. Parse it as corpus evidence while the
  // production graph below independently parses the real per-fact Markdown files.
  const indexNoteIds: Record<string, string[]> = Object.fromEntries(
    sources.map((source) => [source.label, indexedNoteIds(source)]),
  );
  const memory = createMemory({ memoryDir: stagedDir, logger: quietLog, git: false });
  const graph = memory.buildGraph();
  const expectedNames = new Set(golden.pairs.flatMap((pair) => pair.expectedNoteIds));
  const missing = [...expectedNames].filter((name) => !graph.nodes.has(name));
  if (missing.length > 0) throw new Error(`expected note(s) missing after staging: ${missing.join(", ")}`);
  for (const pair of golden.pairs) {
    for (const noteId of pair.expectedNoteIds) {
      const node = graph.nodes.get(noteId)!;
      const stagedPath = node.path.slice(stagedDir.length + 1).replaceAll("\\", "/");
      if (!pair.sourceFiles.includes(stagedPath)) {
        throw new Error(`pair ${pair.id} does not cite ${noteId}'s real source file (${stagedPath})`);
      }
    }
    for (const sourceFile of pair.sourceFiles) {
      if (!existsSync(join(stagedDir, sourceFile))) throw new Error(`pair ${pair.id} cites missing source file: ${sourceFile}`);
    }
  }

  const rows: BenchmarkRow[] = [];
  for (const pair of golden.pairs) {
    const result = await memory.recall({
      text: pair.question,
      k: RETRIEVAL_K,
      audience: pair.audience ?? golden.defaultAudience,
    });
    // Moss can emit equal-score tail hits in native-index order. Canonicalize only exact ties
    // for a stable report; all scores and candidates still came from MemoryStore.recall.
    const returned = [...result.hits]
      .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
      .map((hit) => hit.node.name);
    const at1 = scoreRanking(returned, pair.expectedNoteIds, 1);
    const at5 = scoreRanking(returned, pair.expectedNoteIds, 5);
    const hardNegativeRanks = (pair.hardNegativeNoteIds ?? []).map((noteId) => ({
      noteId,
      rank: returned.indexOf(noteId) === -1 ? null : returned.indexOf(noteId) + 1,
    }));
    rows.push({
      id: pair.id,
      category: pair.category,
      question: pair.question,
      expectedNoteIds: pair.expectedNoteIds,
      hardNegativeNoteIds: pair.hardNegativeNoteIds ?? [],
      sourceFiles: pair.sourceFiles,
      // Keep the diagnostic concise. nDCG still scores all ten real hits above; the
      // presentation intentionally avoids Moss's nondeterministic equal-relevance tail.
      topResults: returned.slice(0, 5),
      precisionAt1: at1.precisionAtK,
      precisionAt5: at5.precisionAtK,
      reciprocalRank: at1.reciprocalRank,
      ndcgAt10: at1.ndcgAt10,
      firstRelevantRank: at1.firstRelevantRank,
      hardNegativeRanks,
    });
  }

  const summarize = (selected: readonly BenchmarkRow[]): Summary => ({
    queries: selected.length,
    precisionAt1: mean(selected.map((row) => row.precisionAt1)),
    precisionAt5: mean(selected.map((row) => row.precisionAt5)),
    mrr: mean(selected.map((row) => row.reciprocalRank)),
    hardNegativeAt1: mean(selected.map((row) => row.hardNegativeRanks.some((negative) => negative.rank === 1) ? 1 : 0)),
  });
  const aggregate = summarize(rows);
  const perCategory = Object.fromEntries(golden.categories.map((category) => [
    category,
    summarize(rows.filter((row) => row.category === category)),
  ])) as Record<BenchmarkCategory, Summary>;
  const report = {
    corpus: {
      cliMemoryDir,
      legacyMemoryDir,
      copied,
      indexNoteIds,
      parsedNodes: [...graph.nodes.values()].filter((node) => !node.phantom).length,
    },
    retrieval: { k: RETRIEVAL_K, metrics: ["precision@1", "precision@5", "MRR"] },
    aggregate,
    perCategory,
    queries: rows,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("# Recall relevance benchmark");
    console.log(`Corpus: CLI root ${cliMemoryDir} (${copied.live} fact files) + retained Claude Code root ${legacyMemoryDir} (${copied.legacy} fact files); ${report.corpus.parsedNodes} graph nodes.`);
    console.log(`MEMORY.md indexes parsed: live ${indexNoteIds.live.length} references, legacy ${indexNoteIds.legacy.length} references.`);
    console.log(`Retrieval: real MemoryStore.recall, k=${RETRIEVAL_K}; exact-score ties sort by node name.`);
    console.log("");
    console.log("## Overall");
    console.log(`queries: ${aggregate.queries}  precision@1: ${format(aggregate.precisionAt1)}  precision@5: ${format(aggregate.precisionAt5)}  MRR: ${format(aggregate.mrr)}  hard-negative@1: ${format(aggregate.hardNegativeAt1)}`);
    console.log("");
    console.log("## Per category");
    console.log("| category | queries | P@1 | P@5 | MRR | hard-negative@1 |");
    console.log("|---|---:|---:|---:|---:|---:|");
    for (const category of golden.categories) {
      const summary = perCategory[category]!;
      console.log(`| ${category} | ${summary.queries} | ${format(summary.precisionAt1)} | ${format(summary.precisionAt5)} | ${format(summary.mrr)} | ${format(summary.hardNegativeAt1)} |`);
    }
    console.log("");
    console.log("## Per query");
    console.log("| case | category | first relevant rank | P@1 | P@5 | MRR | expected notes | hard-negative ranks | top results |");
    console.log("|---|---|---:|---:|---:|---:|---|---|---|");
    for (const row of rows) {
      const hardNegatives = row.hardNegativeRanks.map((negative) => `${negative.noteId}:${negative.rank ?? "—"}`).join(", ") || "—";
      console.log(`| ${row.id} | ${row.category} | ${row.firstRelevantRank ?? "—"} | ${format(row.precisionAt1)} | ${format(row.precisionAt5)} | ${format(row.reciprocalRank)} | ${row.expectedNoteIds.join(", ")} | ${hardNegatives} | ${row.topResults.join(", ") || "—"} |`);
    }
  }
} finally {
  rmSync(stagedDir, { recursive: true, force: true });
}
