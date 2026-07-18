/**
 * Recall benchmark: moss-served retrieval (issue #20) vs the pre-moss lexical baseline.
 * Run with: bun run memory:bench [-- --out docs/recall-moss-benchmark.md]
 *
 * Per zoom's steer, quality is measured over the ENTIRE existing knowledge-graph corpus —
 * every memory file in the Claude Code memory dir (~/.claude/projects/-home-beckett-beckett/
 * memory) plus the live graph (~/.beckett/memory) — staged read-only into a temp store, with
 * three synthetic scoped nodes added so scope filtering is exercised even if the real corpus
 * is all-public. For a set of representative recall queries it compares, per query:
 *
 *   - the pre-moss baseline: `buildGraph()` + `recallOver(q, g)` with the lexical scorer —
 *     byte-for-byte the retrieval path recall used before the transplant;
 *   - the moss path: `store.recall(q)` — graph build + index diff-sync + moss keyword-arm
 *     match + hybrid-arm ranking, with the same in-code visibility gate;
 *
 * reporting the expected node's rank under each, top-5 overlap, baseline hits absent from
 * moss (dropped facts), scope leaks (must be zero), and cold/warm latency percentiles.
 * A --scale section indexes a synthetic 500-node store for latency headroom numbers.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMemory, recallOver, type MemoryStore } from "../../src/memory/index.ts";
import { provenanceOf, SELF_AUDIENCE, type Audience } from "../../src/memory/search.ts";
import type { Logger, RecallResult } from "../../src/types.ts";

const WARM_ROUNDS = 50;
const PARTNER = "881122334455667788";

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

// ── the corpus: every existing memory file, from both real stores ────────────────────────

const SOURCES = [
  { label: "claude-code graph", dir: join(homedir(), ".claude", "projects", "-home-beckett-beckett", "memory") },
  { label: "live graph", dir: join(homedir(), ".beckett", "memory") },
];

/** Representative recall queries with a hand-labeled expected node (spread across both stores). */
const QUERIES: { q: string; expect: string }[] = [
  // live graph (~/.beckett/memory)
  { q: "who is the primary user and owner", expect: "jason" },
  { q: "what host and OS do I run on", expect: "loom-desk" },
  { q: "why can't I deploy to the website apex", expect: "website-deploy-apex-blocked" },
  { q: "what design style does jason want, no ai slop", expect: "jason-design-taste" },
  { q: "should commits carry a claude co-author trailer", expect: "commits-no-claude-trailer" },
  { q: "how does the invite-only beta access gate work", expect: "beta-access-gate" },
  { q: "what github account do I push and PR from", expect: "github-identity" },
  { q: "how should I use my memory and write durable facts", expect: "how-to-use-memory" },
  // claude-code graph (~/.claude/projects/-home-beckett-beckett/memory)
  { q: "is zoom cleared to request fable", expect: "zoom-can-use-fable" },
  { q: "how do I attach a file in discord", expect: "discord-file-attach" },
  { q: "workers dying at a wall clock timeout and wedging tickets", expect: "worker-timeout-silent-wedge" },
  { q: "discord reply timed out, should I retry the post", expect: "discord-reply-timeout-no-retry" },
  { q: "how long should video renders be", expect: "video-pipeline-shorts" },
  { q: "plane rate limit when filing big plans", expect: "plan-filing-rate-limit" },
  { q: "how to cast claude models per stage sonnet opus", expect: "claude-model-casting" },
  { q: "is restarting the daemon the same as deploying", expect: "restart-is-not-deploy" },
];

function stageCorpus(): { dir: string; copied: number; perSource: Record<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-recall-bench-"));
  let copied = 0;
  const perSource: Record<string, number> = {};
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    let n = 0;
    const dest = join(dir, source.label.replace(/[^a-z0-9]+/g, "-"));
    for (const rel of readdirSync(source.dir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
      const segments = rel.split(/[\\/]/);
      if (segments.includes(".git") || segments.includes("archive") || segments.includes(".moss")) continue;
      const target = join(dest, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      cpSync(join(source.dir, rel), target);
      copied++;
      n++;
    }
    perSource[source.label] = n;
  }
  return { dir, copied, perSource };
}

/** Scoped probes: prove owner/dm facts stay out of a member's results on this real corpus. */
async function addScopedProbes(store: MemoryStore): Promise<void> {
  await store.remember({
    op: "create", name: "bench-probe-public", type: "reference",
    description: "public probe fact about the cloudflare tunnel deploy",
    source: "manual", reason: "bench",
  });
  await store.remember({
    op: "create", name: "bench-probe-owner", type: "reference",
    description: "owner-only probe secret about the cloudflare tunnel deploy",
    metadata: { visibility: "owner" }, source: "manual", reason: "bench",
  });
  await store.remember({
    op: "create", name: "bench-probe-dm", type: "reference",
    description: "dm-scoped probe note about the cloudflare tunnel deploy",
    metadata: { visibility: "dm", dm_with: PARTNER }, source: "manual", reason: "bench",
  });
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function rankOf(r: RecallResult, name: string): number | null {
  const i = r.hits.findIndex((h) => h.node.name === name);
  return i === -1 ? null : i + 1;
}

const names = (r: RecallResult, k = 5) => r.hits.slice(0, k).map((h) => h.node.name);

// ── stage + build ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;

const { dir, copied, perSource } = stageCorpus();
const store = createMemory({ memoryDir: dir, logger: quietLog, git: false });
await addScopedProbes(store);
const graph = store.buildGraph();
const realNodes = [...graph.nodes.values()].filter((n) => !n.phantom);
const scopedCount = realNodes.filter((n) => provenanceOf(n).visibility !== "public").length;

// Cold: a FRESH store's first recall pays index open + full diff-sync (a no-op resync here
// since addScopedProbes already migrated; measure a truly cold store by wiping .moss).
rmSync(join(dir, ".moss"), { recursive: true, force: true });
const coldStore = createMemory({ memoryDir: dir, logger: quietLog, git: false });
const coldStart = performance.now();
await coldStore.recall({ text: QUERIES[0]!.q, audience: SELF_AUDIENCE });
const coldMs = performance.now() - coldStart;

// ── quality: same queries through both paths ─────────────────────────────────────────────

interface Row {
  q: string;
  expect: string;
  baseRank: number | null;
  mossRank: number | null;
  baseTop3: string[];
  mossTop3: string[];
  overlap5: number;
  dropped: string[];
}

const rows: Row[] = [];
for (const { q, expect } of QUERIES) {
  const g = store.buildGraph();
  const base = recallOver({ text: q, audience: SELF_AUDIENCE }, g); // pre-moss lexical path
  const moss = await store.recall({ text: q, audience: SELF_AUDIENCE }); // transplanted path
  const baseTop5 = names(base);
  const mossTop5 = names(moss);
  // "Dropped" means gone from moss retrieval entirely (not merely ranked out of the top-k):
  // check the baseline's top hits against a depth-100 moss recall.
  const deep = await store.recall({ text: q, k: 100, audience: SELF_AUDIENCE });
  const mossAll = new Set(deep.hits.map((h) => h.node.name));
  rows.push({
    q,
    expect,
    baseRank: rankOf(base, expect),
    mossRank: rankOf(moss, expect),
    baseTop3: names(base, 3),
    mossTop3: names(moss, 3),
    overlap5: baseTop5.filter((n) => mossTop5.includes(n)).length,
    dropped: baseTop5.filter((n) => !mossAll.has(n)),
  });
}

// ── scope: the member/no-viewer matrix over the real corpus, both paths ──────────────────

const member: Audience = { viewerId: "112233445566778899", viewerRole: "member", context: "guild" };
const scopeLeaks: string[] = [];
for (const audience of [member, undefined]) {
  for (const q of ["cloudflare tunnel deploy probe", "owner secret", "dm note"]) {
    const g = store.buildGraph();
    for (const [path, r] of [
      ["baseline", recallOver({ text: q, audience }, g)],
      ["moss", await store.recall({ text: q, audience })],
    ] as const) {
      for (const x of [...r.hits, ...r.expanded]) {
        if (provenanceOf(x.node).visibility !== "public") {
          scopeLeaks.push(`${path}: '${q}' → ${x.node.name} (${audience ? "member" : "no viewer"})`);
        }
      }
    }
  }
}

// ── latency: warm rounds over the query set, both paths ──────────────────────────────────

for (let i = 0; i < 10; i++) await store.recall({ text: QUERIES[i % QUERIES.length]!.q, audience: SELF_AUDIENCE }); // warm-up

const baseSamples: number[] = [];
const mossSamples: number[] = [];
for (let i = 0; i < WARM_ROUNDS; i++) {
  const { q } = QUERIES[i % QUERIES.length]!;
  let t = performance.now();
  recallOver({ text: q, audience: SELF_AUDIENCE }, store.buildGraph()); // graph build included: that IS the old recall
  baseSamples.push(performance.now() - t);
  t = performance.now();
  await store.recall({ text: q, audience: SELF_AUDIENCE });
  mossSamples.push(performance.now() - t);
}

// ── scale: synthetic 500-node store for latency headroom ─────────────────────────────────

const scaleDir = mkdtempSync(join(tmpdir(), "beckett-recall-scale-"));
const scaleStore = createMemory({ memoryDir: scaleDir, logger: quietLog, git: false });
const topics = ["deploy pipeline", "discord channel etiquette", "worker dispatch retries", "cloudflare tunnel dns", "credential vault rotation"];
for (let i = 0; i < 500; i++) {
  await scaleStore.remember({
    op: "create", name: `synth-${i}`, type: "reference",
    description: `${topics[i % topics.length]} note number ${i}`,
    body: `Synthetic detail ${i}: ${topics[(i + 1) % topics.length]} interacts with ${topics[(i + 2) % topics.length]}.`,
    source: "manual", reason: "bench",
  });
}
const scaleBase: number[] = [];
const scaleMoss: number[] = [];
for (let i = 0; i < 30; i++) {
  const q = topics[i % topics.length]!;
  let t = performance.now();
  recallOver({ text: q, audience: SELF_AUDIENCE }, scaleStore.buildGraph());
  scaleBase.push(performance.now() - t);
  t = performance.now();
  await scaleStore.recall({ text: q, audience: SELF_AUDIENCE });
  scaleMoss.push(performance.now() - t);
}

// ── report ───────────────────────────────────────────────────────────────────────────────

const inTop = (rank: number | null, k: number) => rank !== null && rank <= k;
const top1 = { base: rows.filter((r) => inTop(r.baseRank, 1)).length, moss: rows.filter((r) => inTop(r.mossRank, 1)).length };
const top3 = { base: rows.filter((r) => inTop(r.baseRank, 3)).length, moss: rows.filter((r) => inTop(r.mossRank, 3)).length };
const found = { base: rows.filter((r) => r.baseRank !== null).length, moss: rows.filter((r) => r.mossRank !== null).length };
const droppedTotal = rows.reduce((n, r) => n + r.dropped.length, 0);
const meanOverlap = rows.reduce((n, r) => n + r.overlap5, 0) / rows.length;

const lines: string[] = [];
lines.push("# Recall benchmark — local moss transplant (issue #20) vs the pre-moss baseline");
lines.push("");
lines.push(`Generated by \`bun run memory:bench\` on ${new Date().toISOString().slice(0, 10)}.`);
lines.push("");
lines.push("## Corpus");
lines.push("");
lines.push(`Every existing memory file from both real knowledge graphs, staged read-only:`);
for (const [label, n] of Object.entries(perSource)) lines.push(`- ${label}: ${n} files`);
lines.push(`- staged files: ${copied}; parsed graph nodes: ${realNodes.length} (malformed files are skipped by the parser, same as production); scoped (owner/dm) nodes incl. synthetic probes: ${scopedCount}`);
lines.push("");
lines.push("## Retrieval quality (same queries, both paths, SELF audience)");
lines.push("");
lines.push("Baseline = pre-moss lexical `recallOver`; moss = the transplanted `store.recall`.");
lines.push("");
lines.push("| query | expected node | baseline rank | moss rank | top-5 overlap | baseline hits moss dropped |");
lines.push("|---|---|---|---|---|---|");
for (const r of rows) {
  lines.push(`| ${r.q} | ${r.expect} | ${r.baseRank ?? "—"} | ${r.mossRank ?? "—"} | ${r.overlap5}/5 | ${r.dropped.join(", ") || "none"} |`);
}
lines.push("");
lines.push("(top-5 overlap below 5/5 is rank shuffling between two different rankers; a fact only");
lines.push("counts as dropped if a depth-100 moss recall does not return it at all.)");
lines.push("");
lines.push(`- expected node found: baseline ${found.base}/${rows.length}, moss ${found.moss}/${rows.length}`);
lines.push(`- expected in top-1: baseline ${top1.base}/${rows.length}, moss ${top1.moss}/${rows.length}`);
lines.push(`- expected in top-3: baseline ${top3.base}/${rows.length}, moss ${top3.moss}/${rows.length}`);
lines.push(`- mean top-5 overlap: ${meanOverlap.toFixed(1)}/5; baseline top-5 facts dropped by moss: ${droppedTotal}`);
lines.push("");
lines.push("## Scope filtering (must be zero leaks)");
lines.push("");
lines.push(
  scopeLeaks.length === 0
    ? "No owner/dm fact reached a member viewer or a viewerless recall through either path (hits + expansions checked)."
    : `LEAKS FOUND:\n${scopeLeaks.map((l) => `- ${l}`).join("\n")}`,
);
lines.push("");
lines.push("## Latency (full recall calls, graph build included)");
lines.push("");
lines.push(`Real corpus (${realNodes.length} nodes, ${WARM_ROUNDS} warm rounds over the query set):`);
lines.push("");
lines.push("| path | p50 | p95 | max |");
lines.push("|---|---|---|---|");
lines.push(`| pre-moss baseline | ${fmt(percentile(baseSamples, 0.5))} | ${fmt(percentile(baseSamples, 0.95))} | ${fmt(Math.max(...baseSamples))} |`);
lines.push(`| moss-served | ${fmt(percentile(mossSamples, 0.5))} | ${fmt(percentile(mossSamples, 0.95))} | ${fmt(Math.max(...mossSamples))} |`);
lines.push("");
lines.push(`Cold first recall on a fresh store (opens the index + migrates/embeds all ${realNodes.length} nodes): ${fmt(coldMs)}.`);
lines.push("");
lines.push(`Synthetic 500-node store (30 rounds):`);
lines.push("");
lines.push("| path | p50 | p95 | max |");
lines.push("|---|---|---|---|");
lines.push(`| pre-moss baseline | ${fmt(percentile(scaleBase, 0.5))} | ${fmt(percentile(scaleBase, 0.95))} | ${fmt(Math.max(...scaleBase))} |`);
lines.push(`| moss-served | ${fmt(percentile(scaleMoss, 0.5))} | ${fmt(percentile(scaleMoss, 0.95))} | ${fmt(Math.max(...scaleMoss))} |`);
lines.push("");

const report = lines.join("\n");
console.log(report);
if (outPath) {
  writeFileSync(outPath, report + "\n");
  console.error(`\nwritten to ${outPath}`);
}

rmSync(dir, { recursive: true, force: true });
rmSync(scaleDir, { recursive: true, force: true });
