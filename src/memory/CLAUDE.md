# Memory subsystem conventions (`src/memory/`)

The markdown knowledge graph at `config.memory_dir` (`~/.beckett/memory`). Read this before
changing anything here or building a feature on top of memory.

## The model in one breath

One markdown file per node; YAML frontmatter (`name`, `description`, `metadata.type`, …);
`[[wikilinks]]` are graph edges; everything else (index, backlinks, moss retrieval index,
SQLite-free) is **derived from the files**. Memories are dated observations, never eternal
claims — old ones get demoted or superseded, never judged wrong by age alone.

## Invariants — do not break these

- **Files are canonical.** Never persist graph state anywhere the markdown tree can't rebuild.
  `.moss/` is a disposable cache; deleting it must always be safe. `MEMORY.md` and every
  `## Backlinks` section are GENERATED — regenerate them, never treat them as authored input.
- **All writes go through `remember()` / `maintain()`** on a `MemoryStore`. They serialize
  behind the write mutex, write atomically (tmp + rename), regenerate derived state, and
  git-commit. Never write node files directly from feature code.
- **Visibility is enforced in code, fail-closed, only in `recallOver` / `canView`.** Moss and
  the lexical scorer rank everything, scoped nodes included — they must never become the
  access-control layer. Any new read path that surfaces node content MUST gate through
  `canView` with a real `Audience`; no audience means public-only. `MEMORY.md` lists public
  nodes only.
- **Nothing is ever deleted.** Retirement = move to `archive/` with `archived` /
  `archived_reason` stamped, or merge with full content appended under a `## Merged from`
  heading. Age alone never archives; only ttl expiry, supersede, or a ≥0.9-similarity merge do.
- **A node's `name` is its global id** — kebab-case (`/^[a-z0-9-]+$/`), unique across the whole
  tree; folders are cosmetic. A `[[link]]` to a name with no file is a valid phantom node.
- **`name`, non-empty `description`, and `metadata.type` are required** — `remember()` rejects
  a create without them (a file missing any is unparseable and would be silently skipped).
- **The frontmatter is a YAML *subset*** parsed by the in-file parser in `index.ts`: flat maps,
  one-level nesting, flow/block sequences of scalars, `>`/`|` block scalars. No anchors, no
  sequences of maps, no multi-line flow. If you add a metadata shape, confirm it round-trips
  through `parseYaml` ↔ `serializeMeta` (all-digit strings are auto-quoted so Discord
  snowflakes survive; keep it that way).
- **Pure cores stay pure.** `recallOver`, `planMaintenance`, and everything in `search.ts` /
  `freshness.ts` take a built graph and/or `now` — no filesystem, no `Date.now()` hidden deep.
  Keep new logic testable the same way.

## How to extend

| You want to… | Touch |
|---|---|
| Add a node type | `NodeType` in `src/types.ts`; `TYPE_FOLDER` + `META_ORDER` in `index.ts` (folder + stable frontmatter key order) |
| Add a structural link field (edge with weight, followed on expansion) | `STRUCTURAL_FIELDS` + `HIGH_VALUE_BACKLINK_FIELDS` in `index.ts` |
| Add a metadata field | `META_ORDER` (or `META_TAIL` for provenance-ish fields) so diffs stay one-line; it's automatically searchable via `metaText` unless excluded there |
| Change ranking | Lexical: `search.ts` (`scoreNode`, field weights). Hybrid: `moss.ts` (keyword arm decides *which* nodes match, hybrid arm decides *order*). Both paths must keep seeing the same `searchableText` |
| Change freshness/aging behavior | `freshness.ts` thresholds + `recency()` in `index.ts`; remember the doctrine: nudge ranking, never drop or delete for age |
| Add a maintenance detector | `planMaintenance` in `maintain.ts` (pure, powers `--dry-run`); execution in `MemoryStore.maintain`. Favor flagging over auto-acting; never cross a visibility boundary when merging |
| Read memory from a new surface | `recall()` / `recallAgentic()` with an explicit `Audience` (`SELF_AUDIENCE` for Beckett acting for itself — it excludes dm-scoped facts by construction) |

## Gotchas that have bitten before

- The warm daemon caches the parsed graph keyed by an mtime/size stamp taken **before** the
  build — keep it that way (a post-build stamp can cache a mid-build edit invisibly).
- TTL staleness is evaluated at **recall time** (`staleNow` in `recallOver`), not from the
  parse-time `node.stale` flag — the warm graph can outlive an expiry.
- `planMaintenance` sorts nodes by name so plans are deterministic; don't reintroduce
  readdir-order dependence in pairwise scans.
- Duplicate node names resolve newest-mtime-first with a path tiebreak — deterministic, but a
  duplicate name is still a bug to fix in the tree, not a feature.

## Testing

`bun test src/memory/` — pin behavior with the pure cores (`recallOver(query, graph)`,
`planMaintenance(graph, now)`, `scoreNode`) plus a `tempStore()` (tmpdir + `git: false`) for
write paths. Visibility changes need cases in `visibility.test.ts` proving the fail-closed
default holds.
