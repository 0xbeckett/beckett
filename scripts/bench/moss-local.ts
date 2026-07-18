/** Run with: bun run moss:bench. Builds/reuses a 3,000 document local Moss index. */
import { join } from "node:path";
import { resolveBeckettDir } from "../../src/paths.ts";
import { openLocalMoss, type MossDocument } from "../../src/moss-local/index.ts";

const DOCUMENT_COUNT = 3_000;
const ITERATIONS = 600;
const topics = [
  ["refund", "Refunds are processed in three to five business days by the billing team."],
  ["password", "Reset a forgotten password through secure account settings."],
  ["deploy", "Deploy the worker after the TypeScript test suite succeeds."],
  ["latency", "Search latency stays low by keeping the semantic index in process."],
  ["storage", "Persistent local storage reloads the index after a process restart."],
] as const;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

const dataDir = join(resolveBeckettDir(), "moss", "bench");
const moss = await openLocalMoss({ dataDir, indexName: "three-thousand" });
const docs: MossDocument[] = Array.from({ length: DOCUMENT_COUNT }, (_, number) => {
  const [topic, text] = topics[number % topics.length]!;
  return { id: `bench-${number}`, text: `${text} Benchmark document ${number}.`, metadata: { topic, shard: number % 10 } };
});
await moss.upsert(docs);

const queries = ["when will my reimbursement arrive", "forgotten credentials", "quick semantic retrieval", "restart persistent index", "ship the worker"];
for (let i = 0; i < 40; i++) moss.query(queries[i % queries.length]!); // JIT/native warm-up, excluded from report.

const samples: number[] = [];
for (let i = 0; i < ITERATIONS; i++) {
  const started = performance.now();
  moss.query(queries[i % queries.length]!);
  samples.push(performance.now() - started);
}

console.log(JSON.stringify({
  runtime: "Moss core Index + beckett-local-hash-v1 embedding (fully local)",
  documents: moss.docCount,
  iterations: ITERATIONS,
  p50Ms: Number(percentile(samples, 0.50).toFixed(3)),
  p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
  maxMs: Number(Math.max(...samples).toFixed(3)),
  indexPath: moss.indexPath,
}, null, 2));
