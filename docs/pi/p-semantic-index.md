# `p-semantic-index` — retrieval instead of grep

**Priority 6.** The largest token-and-latency win available, and the one with a real prerequisite.

## Problem

A pi worker orients itself by grepping. On a 67k-LOC source tree with a heavy header-comment
convention, that means reading a lot of prose to find a little code, and paying for all of it —
twice, because context is re-sent every turn until compaction. Prompt tokens *are* task latency
and task cost here, so orientation is one of the largest line items in a ticket's bill and one of
the largest chunks of its wall clock.

Beckett already owns a hybrid retrieval engine: `src/moss-local` (keyword + dense semantic, with a
tunable `semanticWeight`), used by `src/memory/moss.ts` for memory recall and benchmarked in
`docs/recall-moss-benchmark.md`.

**The honest prerequisite:** moss-local currently indexes *memory*, not *code*. There is no code
corpus. So this is two pieces of work, and the spec should not pretend it is one:

- **(a) A code corpus** — index the repo (and the ticket's project repo) into moss-local:
  chunking that respects declaration boundaries, incremental reindex on change, and a decision
  about whether the heavy file headers are signal (they describe intent, which is what you want to
  search) or noise (they bloat every chunk). Test files are a separate corpus — a worker looking
  for behaviour wants them, a worker looking for an implementation does not.
- **(b) The pi tool** that queries it.

(b) without (a) is a tool with nothing to search. Do (a) first, benchmark it against grep on real
questions, and only build (b) if it wins.

## Mechanism

Once a corpus exists: `pi.registerTool()` exposing it, backed by `pi.exec` against a `beckett`
CLI verb (add one, e.g. `beckett index query`) so the index lives in one process and the
extension stays stateless.

```
code_search(query: string, scope?: "source" | "tests" | "both", topK?: number)
  → ranked chunks with path:line anchors and enough surrounding context to be useful alone
```

Design points that decide whether this actually helps:

1. **Return anchors, not just text.** A result the model must then `read` to use has saved
   nothing. Return `path:line` plus the chunk, so the common case is one tool call, not two.
2. **Rank on intent, not tokens.** The reason to use moss-local rather than grep is that "where do
   we decide which harness a ticket runs on" should find `Dispatcher.castFor` without containing
   the word `cast`. Benchmark exactly that class of query — `docs/recall-relevance-benchmark.md`
   is the existing pattern for scoring relevance honestly.
3. **Say when it doesn't know.** An index that returns three mediocre chunks for an unindexed
   question sends the worker down a wrong path with false confidence. Return an explicit
   low-confidence signal and let the model fall back to grep.
4. **Do not remove grep.** This is an addition. A worker that can only retrieve is worse than one
   that can also scan.

## Prove the win before building the tool

Before any extension code exists, run the comparison, because the whole justification is
quantitative:

- a fixture set of ~20 real orientation questions drawn from actual ticket briefs;
- for each: tokens consumed and wall-clock to reach the correct file, grep-only vs index-first;
- report both, plus the cases where the index was *worse*.

If it doesn't win by a wide margin on tokens, don't ship it — and the benchmark is a useful
artifact either way. The existing `bench/` and `scripts/bench/` layout is where it goes
(`recall:bench`, `recall:agent-bench` are the templates).

## Beckett-side changes this enables

- Worker orientation cost drops on every ticket, which compounds across the fleet.
- Cheap large-context models become much more usable: a 1M-context model with good retrieval
  beats an expensive model doing blind grep, and that is precisely the frontier the seat router
  (`../pi-harness-review.md` §4) is trying to exploit.
- The concierge could use the same index for cast-writing, so briefs name the right files.

## Verification

1. The benchmark above, published, including losses.
2. A worker on a real ticket reaches the right file in fewer tool calls than the grep baseline —
   measured on a replayed ticket, not asserted.
3. Index staleness is detectable: a fixture that edits a file and asserts the next query reflects
   it (or explicitly reports staleness).

## Failure modes

- **Stale index** presents deleted code as current. Incremental reindex on change, and a staleness
  timestamp on every result.
- **Chunking that splits a declaration** returns half a function and reads as a broken codebase.
- **The corpus becomes another thing to keep alive.** If it needs a system unit, it needs the
  `HOME`/`User=` care that the metrics units needed, or it will publish an empty index and nobody
  will notice.

## Size

**M** for the tool, **M–L** for the corpus, and the corpus is genuinely optional until the
benchmark says otherwise. Sequence it after 1–5; it is the highest-value item that is not
blocking anything.
