# Recall relevance benchmark

`bun run recall:bench` is the regression harness for Moss-backed `beckett recall` ranking. It is deliberately separate from [`recall-moss-benchmark.md`](./recall-moss-benchmark.md), which measures the Moss transplant's latency and overlap with the retired lexical ranker.

## Run it

```bash
bun run recall:bench
bun run recall:bench -- --json > /tmp/recall-relevance.json
```

The runner resolves the **same configured root as `beckett recall`** with `loadConfig()` + `buildPaths()`: normally `~/.beckett/memory` (or `$BECKETT_DIR/memory` when `BECKETT_DIR` is set). It copies that read-only corpus into a temporary directory, then calls `MemoryStore.recall()` for every case. Therefore every query follows the production graph build, Moss index sync, hybrid Moss ranking, and in-code visibility gate; it does not duplicate ranking logic. The temporary copy prevents the derived `.moss/` cache from changing canonical memory.

The reported Zoom/Fable regression is retained in the historical Claude Code memory corpus at `~/.claude/projects/-home-beckett-beckett/memory/zoom-can-use-fable.md`, not in the current CLI root. The harness stages that retained corpus alongside the CLI root so `can zoom use fable` remains an executable regression case. Override either source when restoring or evaluating a snapshot:

```bash
bun run recall:bench -- --memory-dir /path/to/.beckett/memory \
  --legacy-memory-dir /path/to/retained/memory
# Equivalent environment override for the retained source:
BECKETT_RECALL_BENCH_LEGACY_MEMORY=/path/to/retained/memory bun run recall:bench
```

Both source directories are required: silently dropping the legacy source would make the Zoom labels meaningless. The runner checks every labeled node exists after staging before it scores anything.

## What it reports

The golden set in [`scripts/bench/recall-relevance-golden.json`](../scripts/bench/recall-relevance-golden.json) has 31 person/project/fact questions, including direct, reworded, and ambiguous multi-answer questions. Labels name both the memory node and its source-relative Markdown file. The runner fetches ten real hits per query and emits:

- **precision@1** — whether the first result is a labeled fact;
- **MRR** — reciprocal rank of the first labeled fact;
- **nDCG@10** — discounted gain across all labels (so multi-answer cases matter);
- a per-query table with rank, all metrics, expected files, and the first five returned nodes;
- **overall relevance score** — the unweighted mean of aggregate precision@1, MRR, and nDCG@10. It is a readable headline, not a replacement for the three standard metrics.

Moss's native index can enumerate equal-score tail documents in a different order. The runner only sorts *exact-score ties* by node name after `MemoryStore.recall()` returns, making report JSON and metrics repeatable without changing the production ranker.

## Baseline — 2026-07-18

Against the checked host corpus (15 files from `~/.beckett/memory`, 27 retained Zoom-era files, 41 parsed nodes), this branch measured:

| overall relevance score | precision@1 | MRR | nDCG@10 | queries |
|---:|---:|---:|---:|---:|
| 0.920 | 0.871 | 0.935 | 0.952 | 31 |

The non-top-one cases were `available-tools`, `reversible-work`, `beckett-identity`, and `discord-timeout-no-retry` (all rank 2). This is the baseline for #33.2; re-run the command after a ranking-only change and compare the aggregate **and** the per-query rows before claiming an improvement.

## Add a case

1. Read the actual Markdown fact first; do not label from a filename alone.
2. Add an object to `cases` in `scripts/bench/recall-relevance-golden.json` with a stable `id`, natural-language `query`, and one or more `{ "name", "file" }` targets. Use multiple targets only when each is genuinely a correct answer.
3. Keep the owner/guild audience unless the case requires an explicit `audience` override. This matches the normal owner invocation of `beckett recall --viewer 1151230208783945818 --viewer-role owner --context guild`.
4. Run `bun run recall:bench` twice (or compare `--json` output) and record an intentional baseline change in this document.

Do not tune `src/memory/moss.ts` or any recall weighting as part of adding labels. This branch is only the measuring stick.
