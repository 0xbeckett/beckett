# Memory recall benchmark

`bun run recall:bench` evaluates the production `MemoryStore.recall()` path against a versioned, human-curated set of real-memory questions. It is a retrieval regression harness, not a synthetic corpus or a second ranker.

## Corpus and data

[`scripts/bench/recall-relevance-golden.json`](../scripts/bench/recall-relevance-golden.json) is version 2 of the benchmark. It has 101 natural-language `(question, expectedNoteIds[])` pairs, balanced across:

- `feedback`
- `people-profile`
- `project-status`
- `environment-setup`
- `adversarial`

Every pair records the staged `sourceFiles` that were actually read while its labels were authored. The runner verifies each expected ID resolves to that real Markdown file after staging. It loads and parses both source `MEMORY.md` indexes as evidence too; those files are intentionally not added as duplicate graph nodes because `MemoryStore` derives the graph index from the per-fact notes.

The corpus is the configured `~/.beckett/memory` tree plus the retained Claude Code tree at `~/.claude/projects/-home-beckett-beckett/memory`. This includes current Beckett notes, their `MEMORY.md`, and historical Claude Code notes such as `zoom-can-use-fable`. The runner copies Markdown in canonical order into a temporary directory and calls `MemoryStore.buildGraph()` and `MemoryStore.recall()` — the same graph, Moss hybrid retrieval, lexical sharpener, and visibility gate used by `beckett recall`.

Adversarial cases carry `hardNegativeNoteIds`: lexically plausible notes that are wrong and must not win retrieval. The retained regression `can zoom use fable` expects `zoom-can-use-fable` and explicitly labels `website-deploy-apex-blocked` and `how-to-use-memory` as hard negatives.

## Run

```bash
bun run recall:bench
bun run recall:bench -- --json > /tmp/recall-relevance.json
```

For a restored snapshot, point both roots at that snapshot:

```bash
bun run recall:bench -- --memory-dir /path/to/.beckett/memory \
  --legacy-memory-dir /path/to/claude-project-memory
```

Both roots and both `MEMORY.md` files are required. The harness has no network calls and writes its derived Moss state only to a temporary directory. File staging and exact-score tie handling are sorted, so re-runs against an unchanged corpus are deterministic.

## Report

The report emits these metrics overall and for every category:

- **precision@1**
- **precision@5**
- **MRR**

Per-query JSON/table rows retain expected IDs, source files, top five actual results, and the rank of every hard negative. `hard-negative@1` is a diagnostic rate (lower is better), separate from the required relevance metrics.

## Adding a pair

1. Read the real note body and, where useful, its `MEMORY.md` entry first.
2. Add a stable `id`, `category`, ordinary-person `question`, `expectedNoteIds`, and exact staged `sourceFiles` (`live/...` or `legacy/...`).
3. Add `hardNegativeNoteIds` whenever lexical overlap could retrieve an incorrect note. Never label an expected note as a negative.
4. Keep the set within 80–150 pairs and keep each category between 10% and 35%; the runner validates this before calling retrieval.
5. Run the JSON command twice. Do not tune `src/memory/moss.ts` or ranking weights when only adding labels.
