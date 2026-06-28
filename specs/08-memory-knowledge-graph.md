# Beckett — Spec 08: Memory & Knowledge Graph

> **The general-competence subsystem.** Beckett is code-primary but *general* — it can email the
> marketing team, do research, or run ops because it carries a robust, earned **knowledge graph** of
> people, projects, preferences, env facts, and a learned model of its own workers. This spec owns the
> on-disk file format, the in-memory graph model, recall (read), write/update (learn), worker-notes as
> the learned-model narrative surface, and the operational concerns (locking, versioning, privacy). If
> this spec contradicts [Spec 00](./00-overview.md), Spec 00 wins (or we fix 00 first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Research & rationale: [`../my-docs/open-questions.md`](../my-docs/open-questions.md) (esp. §G2 memory-as-knowledge-graph, §G1 learned worker model, §K task-domain, the Memory + Filesystem ledger rows in [Spec 00 §4](./00-overview.md#4-canonical-decisions-the-ledger)).

---

## 0. Scope & cross-links

This document owns: **the markdown+frontmatter+`[[wikilink]]` file format, the `MEMORY.md` index, the
in-memory knowledge-graph model and its build/index step, the `recall()` read path, the
`remember()` write/update path with dedup, worker-notes as the learned-model surface, env
self-knowledge, and concurrency/versioning/privacy of the memory dir.**

It **defers**:

| Concern | Owner |
|---|---|
| How recalled memory is *assembled into a brain prompt* (context budget, ordering, persona merge) | [Spec 06 — Brain & Models](./06-brain-models.md) |
| The SQLite mirror DDL, `outcomes` table (raw gate stats feeding worker-notes), event log | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| Outbound actions that *consume* recall (sending the email, opening the PR), handshakes | [Spec 07 — Identity & Agency](./07-identity-agency.md) |
| When in the loop a write fires (post-GATE worker-note, post-CLARIFY fact) — transition wiring | [Spec 04 — State Machine](./04-state-machine.md) |
| Raw gate-outcome logging `(harness, model, task_type) → stats` that worker-notes summarize | [Spec 09](./09-persistence-data-model.md) + [Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md) |
| `beckett memory` CLI subcommands (`ls`, `cat`, `graph`, `gc`) | [Spec 10 — CLI](./10-cli.md) |

⚠️ At time of writing, **Spec 06 and Spec 09 do not yet exist** — every reference to them is a forward
reference. The recall-context-assembly interface (§3.4) and the SQLite-mirror schema (§2.4) are the
two seams that must be reconciled when those specs land.

---

## 1. The file format

### 1.1 Where it lives

Per [Spec 00 §5](./00-overview.md#5-filesystem--host-layout-loom-desk):

```
~/.beckett/memory/
  MEMORY.md            # the index — one line per fact, always loaded (cheap)
  people/
    marketing-team.md
    jason.md
  projects/
    project-anaconda.md
  env/
    loom-desk.md
    projects-inventory.md
  prefs/
    commit-style.md
  workers/
    codex-data-layers.md   # learned-model narrative (worker-note)
```

> **Subdirectories are organizational only, not semantic.** The `metadata.type` frontmatter field is
> the source of truth for a node's type; the folder is a human convenience. A file's **node id** is its
> `name` (kebab-case), which is globally unique across the whole `memory/` tree — *not* its path. This
> keeps `[[wikilinks]]` flat and path-independent: `[[marketing-team]]` resolves regardless of which
> folder the file sits in. ⚠️ Enforced-unique `name` is a load-time invariant (§2.3); a duplicate
> `name` is a build error surfaced to the daemon log, last-writer-by-mtime wins for graph purposes.

### 1.2 Frontmatter schema (YAML)

Every memory file is a markdown file with a YAML frontmatter block, mirroring Claude Code's own
per-fact memory pattern (`name` / `description` / `metadata`) and extending `metadata` into a typed,
linkable graph node.

```yaml
---
name: marketing-team            # REQUIRED. kebab-case. globally unique. == node id == wikilink target.
description: >                  # REQUIRED. one sentence. THIS is what recall ranks against (cheap match).
  The internal marketing team (Dana, Priya, Marcus) — owns launch comms and external announcements.
metadata:
  type: person                  # REQUIRED. enum (see §1.3).
  # --- type-specific fields below (see §1.3) ---
  created: 2026-06-01T09:12:00Z # REQUIRED. ISO-8601. set on first write.
  updated: 2026-06-27T14:03:00Z # REQUIRED. ISO-8601. bumped on every edit.
  source: conversation          # REQUIRED. enum: conversation | derived | env-scan | manual | import.
  confidence: high              # OPTIONAL. high|medium|low. derived/inferred facts default medium.
  ttl: null                     # OPTIONAL. ISO-8601 expiry or null. for facts that go stale (see §1.5).
---
```

Common rules:

- **`name`** is the primary key and the wikilink target. Renaming a node is a graph migration (§4.6).
- **`description`** is load-bearing for recall: the index carries *only* `name` + `description` +
  `type`, and the first-pass relevance match (§3.2) scores the task against `description`. Write it as
  one declarative sentence a stranger could match a query against. Bad: "notes". Good: "The Q3 launch
  of the Anaconda data-pipeline rewrite; currently in code-freeze, ships July 15."
- **`metadata.type`** drives which type-specific fields are expected and how recall/agency treat the
  node (e.g. a `person` node's `emails` are what [Spec 07](./07-identity-agency.md) reads to send mail).
- **All timestamps ISO-8601 UTC.** `updated` is bumped on every body or frontmatter change.

### 1.3 `metadata.type` enum + type-specific fields

The enum is **open-ended-with-a-known-core** — Beckett may introduce a new type if a fact doesn't fit,
but the core types below have defined extra fields that recall and agency rely on:

| `type` | Meaning | Type-specific `metadata` fields |
|---|---|---|
| `person` | A human (or a group treated as a unit, e.g. a team). | `emails: []`, `role`, `aliases: []`, `members: [[wikilinks]]` (for groups), `timezone?` |
| `project` | A project/initiative (code or not). | `status` (enum: `idea\|active\|code-freeze\|shipped\|paused\|archived`), `repo?` (path under `/home/beckett/projects/` or git URL), `owners: [[wikilinks]]`, `channels: []` (Discord), `deadline?` |
| `preference` | A standing preference of Jason's / the team. | `scope` (enum: `global\|project\|domain`), `applies_to: [[wikilinks]]?` |
| `env` | A fact about Beckett's host/world (host facts, tool inventory, project inventory). | `subtype` (enum: `host\|tool\|project-inventory\|account`), `path?`, `verified` (ISO-8601 of last self-scan) |
| `worker-note` | Learned-model narrative about a harness/model on a task type (§5). | `harness` (`claude\|codex`), `model`, `task_type`, `derived_from` (SQLite query/window id), `stat_window` (e.g. `last-50-gates`), `n_samples` |
| `reference` | An external/portable knowledge chunk (API quirk, vendor contact, runbook). | `url?`, `domain?` |
| `decision` | A recorded past decision + rationale (so Beckett doesn't relitigate). | `decided` (ISO-8601), `supersedes: [[wikilink]]?` |

Unknown/new types are legal (forward-compatible): the graph still indexes the node and its links; only
type-specific behavior (e.g. "treat `emails` as send targets") is gated on a known type.

### 1.4 Body conventions + `[[wikilink]]` = graph edge

The markdown **body** is free-form prose for the brain to read, with three conventions:

1. **`[[name]]` is an edge.** Any `[[kebab-case-name]]` in the body (or in a link-typed frontmatter
   field like `members`/`owners`) is a directed edge from this node to node `name`. The graph builder
   extracts every `[[...]]` occurrence (§2.2). Wikilinks may carry an optional display alias:
   `[[project-anaconda|Anaconda]]` renders "Anaconda" but links to `project-anaconda`.
2. **A forward-ref is valid.** `[[dana]]` is a legal link even if `dana.md` does not exist yet. It
   becomes a **dangling edge** to a *phantom node* (§2.5) — Beckett can later "fill it in" by writing
   the file, and the edge resolves automatically. This is how Beckett learns incrementally without
   up-front completeness.
3. **`## Backlinks` is generated, never hand-edited.** Beckett may append a machine-maintained
   `## Backlinks` section listing inbound edges (§2.5). Everything above it is human/brain-authored.

### 1.5 Staleness & TTL

`metadata.ttl` lets a fact self-expire (e.g. "Marcus is OOO until July 1"). On graph build (§2),
nodes past their `ttl` are loaded but flagged `stale: true`; recall **deprioritizes** stale nodes and
the brain is told they're stale rather than them being silently dropped (silent loss of a fact is worse
than a flagged stale one). A background sweep (§8.4) proposes refresh/removal of long-stale nodes.

### 1.6 Example files

**`people/marketing-team.md`** (a group person node):

```markdown
---
name: marketing-team
description: >
  Internal marketing team (Dana, Priya, Marcus); owns launch comms and external announcements.
metadata:
  type: person
  emails: ["marketing@loomlabs.dev"]
  members: ["[[dana]]", "[[priya]]", "[[marcus]]"]
  aliases: ["marketing", "the marketing team", "comms"]
  created: 2026-06-01T09:12:00Z
  updated: 2026-06-20T11:00:00Z
  source: conversation
  confidence: high
---

The marketing team handles all outbound launch communication. The shared list
`marketing@loomlabs.dev` reaches all three; for anything launch-related, [[dana]] is the lead and
prefers a heads-up before the team-wide note goes out.

They are the announce-channel for [[project-anaconda]] and [[project-basilisk]].

## Backlinks
- [[project-anaconda]] (owners)
```

**`projects/project-anaconda.md`**:

```markdown
---
name: project-anaconda
description: >
  Q3 rewrite of the data-ingest pipeline to a streaming model; currently in code-freeze, ships Jul 15.
metadata:
  type: project
  status: code-freeze
  repo: /home/beckett/projects/anaconda
  owners: ["[[jason]]"]
  channels: ["#anaconda"]
  deadline: 2026-07-15
  created: 2026-05-10T16:40:00Z
  updated: 2026-06-26T08:30:00Z
  source: conversation
  confidence: high
---

Anaconda replaces the batch ETL with a streaming ingest. As of the last sync it's **code-frozen**
pending the go/no-go call — once Jason signals "go", the launch note goes to [[marketing-team]].

Announce flow when we ship: notify [[marketing-team]] (Dana first per her pref), then post in
`#anaconda`. The repo lives at `/home/beckett/projects/anaconda` (see [[loom-desk]] inventory).

## Backlinks
- [[marketing-team]] (announce-channel)
```

**`workers/codex-data-layers.md`** (a worker-note — the learned model, §5):

```markdown
---
name: codex-data-layers
description: >
  Learned: Codex over-engineers data-layer nodes (extra abstraction, speculative interfaces).
metadata:
  type: worker-note
  harness: codex
  model: gpt-5-codex
  task_type: data-layer
  derived_from: outcomes#q-codex-data-layer
  stat_window: last-40-gates
  n_samples: 40
  created: 2026-06-15T00:00:00Z
  updated: 2026-06-27T03:00:00Z
  source: derived
  confidence: medium
---

On data-layer nodes (schema, ORM, repository code), Codex passes gate but tends to **over-build**:
it introduces speculative interfaces and extra abstraction layers that REVIEW flags ~30% of the time
(12/40), driving an avg 1.4 re-dispatch cycles vs 0.6 for [[claude-on-data-layers]].

**STAFF implication:** for tightly-scoped data-layer nodes, prefer Claude, or give Codex an explicit
"no new abstractions; match existing patterns" constraint in the node brief. Codex remains strong on
[[codex-algorithmic-tasks]].

_Derived from SQLite `outcomes` (Spec 09); refreshed by Opus when the window shifts ≥10 gates._
```

**`prefs/commit-style.md`**:

```markdown
---
name: commit-style
description: Jason prefers short, lowercase, present-tense commit messages; changelog for big changes.
metadata:
  type: preference
  scope: global
  created: 2026-06-02T10:00:00Z
  updated: 2026-06-02T10:00:00Z
  source: conversation
  confidence: high
---

Commits: short, concise, lowercase, present-tense ("add x", not "Added X"). For big multi-feature
changes, a one-liner commit + detail in the changelog. Applies across all of [[jason]]'s projects.
```

### 1.7 `MEMORY.md` index format

`MEMORY.md` is the **always-loaded cheap index** — one line per fact, regenerated from frontmatter on
every write (§4.5). It is a generated artifact; never hand-edited. Format:

```markdown
# Beckett Memory Index
<!-- GENERATED. Do not edit. Regenerated on every memory write. last: 2026-06-27T14:03:00Z, 47 nodes -->

## person
- [[marketing-team]] — Internal marketing team (Dana, Priya, Marcus); owns launch comms & announcements.
- [[jason]] — Primary user; owner of loom-desk and all projects; prefers terse comms.

## project
- [[project-anaconda]] — Q3 data-ingest streaming rewrite; code-freeze, ships Jul 15.

## preference
- [[commit-style]] — Short lowercase present-tense commits; changelog for big changes.

## env
- [[loom-desk]] — The host: Ubuntu 24.04, 8c/31GB; bun/docker/git present; user `beckett`.
- [[projects-inventory]] — What lives under /home/beckett/projects (anaconda, basilisk, ...).

## worker-note
- [[codex-data-layers]] — Codex over-engineers data-layer nodes; prefer Claude or constrain.
```

Each line is `- [[name]] — description` grouped under `## <type>`. The index is the table of contents
of Beckett's mind: small enough to always inject, rich enough to decide what to fetch in full.

---

## 2. The knowledge-graph model

### 2.1 Nodes & edges

- **Node** = one memory file. Identity = `name`. Carries `type`, `description`, typed metadata, body
  text, and `stale`/`phantom` flags.
- **Edge** = one `[[name]]` occurrence (in body or a link-typed frontmatter field), directed
  `source → target`. Edges are **typed by where they came from** (frontmatter field name like `owners`,
  or `body` for prose links) so recall can weight a structural edge (`members`) above an incidental
  prose mention.

```ts
type NodeType =
  | "person" | "project" | "preference" | "env"
  | "worker-note" | "reference" | "decision" | (string & {}); // open enum

interface MemoryNode {
  name: string;                 // kebab-case, unique == node id
  type: NodeType;
  description: string;
  metadata: Record<string, unknown>; // typed per §1.3 (emails, status, harness, ...)
  body: string;                 // markdown sans frontmatter & generated Backlinks
  path: string;                 // absolute file path
  created: string; updated: string;
  source: "conversation" | "derived" | "env-scan" | "manual" | "import";
  confidence?: "high" | "medium" | "low";
  stale: boolean;               // ttl elapsed
  phantom: boolean;             // referenced but no file yet (forward-ref target)
  mtime: number;                // fs mtime, for cache invalidation
}

interface MemoryEdge {
  from: string;                 // node name
  to: string;                   // node name (may be a phantom)
  field: string;                // "body" | "members" | "owners" | "applies_to" | ...
  alias?: string;               // [[to|alias]] display text
}

interface MemoryGraph {
  nodes: Map<string, MemoryNode>;   // includes phantoms
  out: Map<string, MemoryEdge[]>;   // adjacency: from -> edges
  in: Map<string, MemoryEdge[]>;    // reverse adjacency: to -> edges (backlinks)
  index: IndexLine[];               // parsed MEMORY.md (name, type, description)
  builtAt: number;
}
```

### 2.2 Parsing a file → node + edges

```ts
const WIKILINK = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;

function parseFile(path: string, raw: string): { node: MemoryNode; edges: MemoryEdge[] } {
  const { frontmatter, body } = splitFrontmatter(raw);      // YAML + remainder
  const fm = parseYaml(frontmatter);
  assert(fm.name && fm.description && fm.metadata?.type, `malformed memory file: ${path}`);

  const cleanBody = stripGeneratedBacklinks(body);          // drop "## Backlinks" block
  const edges: MemoryEdge[] = [];

  // (a) edges from link-typed frontmatter fields (structural, higher weight)
  for (const field of ["members", "owners", "applies_to", "supersedes"]) {
    for (const v of asArray(fm.metadata[field])) {
      const m = WIKILINK.exec(v) ?? matchBareName(v);
      if (m) edges.push({ from: fm.name, to: m.name, field, alias: m.alias });
    }
  }
  // (b) edges from body prose
  for (const m of cleanBody.matchAll(WIKILINK)) {
    edges.push({ from: fm.name, to: m[1], field: "body", alias: m[2] });
  }

  const node: MemoryNode = {
    name: fm.name, type: fm.metadata.type, description: fm.description.trim(),
    metadata: fm.metadata, body: cleanBody, path,
    created: fm.metadata.created, updated: fm.metadata.updated,
    source: fm.metadata.source, confidence: fm.metadata.confidence,
    stale: isExpired(fm.metadata.ttl), phantom: false, mtime: statMtime(path),
  };
  return { node, edges };
}
```

### 2.3 Building the graph at daemon start

On daemon boot the memory dir is scanned once and held in memory; thereafter it is incrementally
patched on each write (§4) and on fs-watch events (so an out-of-band `git pull` or manual edit is
picked up):

```ts
async function buildGraph(dir = "~/.beckett/memory"): Promise<MemoryGraph> {
  const files = await glob(`${dir}/**/*.md`, { ignore: ["MEMORY.md"] });
  const nodes = new Map<string, MemoryNode>();
  const out = new Map<string, MemoryEdge[]>();
  const inE = new Map<string, MemoryEdge[]>();

  // 1. parse every file → real nodes + edges
  const parsed = await Promise.all(files.map(async f => parseFile(f, await readFile(f))));
  for (const { node } of parsed) {
    if (nodes.has(node.name)) logWarn(`duplicate name '${node.name}' (${node.path}); newer mtime wins`);
    if (!nodes.has(node.name) || node.mtime > nodes.get(node.name)!.mtime) nodes.set(node.name, node);
  }
  // 2. wire edges, creating phantom nodes for unresolved targets (forward-refs)
  for (const { edges } of parsed) for (const e of edges) {
    if (!nodes.has(e.to)) nodes.set(e.to, phantomNode(e.to)); // valid dangling edge
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inE.get(e.to)  ?? inE.set(e.to, []).get(e.to)!).push(e);
  }
  const index = parseIndex(await readFile(`${dir}/MEMORY.md`)); // cheap TOC

  const g: MemoryGraph = { nodes, out, in: inE, index, builtAt: Date.now() };
  await mirrorToSqlite(g);   // §2.4 — best-effort SQLite mirror for query (Spec 09)
  return g;
}
```

Cost is trivial (tens-to-low-hundreds of small files). The in-memory graph is the **hot path** for
recall; SQLite is a queryable mirror, not the source of truth.

### 2.4 SQLite mirror (defer DDL → Spec 09)

The on-disk markdown is **canonical**; SQLite is a derived, rebuildable index for queries the in-memory
maps don't serve cheaply (full-text search over bodies, "all nodes of type X linking to Y", worker-note
provenance joins back to `outcomes`). Mirror tables (DDL owned by [Spec 09](./09-persistence-data-model.md)):

- `memory_nodes(name PK, type, description, path, updated, stale, phantom, body)` + an FTS5 virtual
  table over `description || body` for relevance fallback.
- `memory_edges(from, to, field)`.

The mirror is rebuilt wholesale on `buildGraph` and patched per write. If the mirror and the files ever
disagree, **files win** and the mirror is rebuilt. ⚠️ Exact DDL + whether FTS5 is in v1 or deferred is
a Spec 09 decision; recall (§3) functions without FTS (falls back to in-memory description scoring).

### 2.5 Phantom nodes, dangling edges & backlinks

- A **phantom node** exists only because something links to it; it has a `name`, `phantom: true`, and
  no body. It is a first-class "I know this thing exists but haven't recorded details" marker. When
  Beckett later writes the file, `buildGraph`/the incremental patch upgrades the phantom to a real node
  and all inbound edges resolve with no rewrite of the linkers.
- **Bidirectional resolution:** edges are stored directed but the reverse adjacency (`in`) makes the
  graph effectively bidirectional for traversal. `backlinks(name)` = `g.in.get(name)`. The generated
  `## Backlinks` section in a file (§1.4) is a *materialization* of `g.in` for human/brain readability,
  refreshed on write — it is never the source of truth.
- **Phantom report:** `beckett memory gaps` (Spec 10) lists phantoms (= known-but-undocumented nodes)
  so Beckett/Jason can fill them in.

---

## 3. Recall (the read path)

> **Recall produces a relevance-ranked bundle of memory for a brain call. It does NOT build the
> prompt** — assembling that bundle into the actual brain context (token budget, ordering, dedup
> against persona) is [Spec 06](./06-brain-models.md)'s job. Recall hands Spec 06 structured nodes;
> Spec 06 decides how many fit and how they're framed.

### 3.1 Strategy (cheap-first, graph-aware)

Three tiers, cheapest first:

1. **Always inject the index.** `MEMORY.md` (one line per fact) is small and goes into *every* judgment
   call unconditionally. It gives the brain a map of everything Beckett knows and lets the brain itself
   name nodes to fetch.
2. **Relevance match → fetch full files.** Score each index line's `description` (+ `name`/`aliases`)
   against the task text; fetch the full bodies of the top-K matches. Scoring is lexical/embedding-light
   in v1 (token overlap + alias exact-match + type priors), upgradable to embeddings later.
3. **One-hop link expansion.** For each fetched node, pull its direct neighbors (out-edges, and
   high-value in-edges like `owners`) — *one hop only* — because the motivating queries ("email the
   marketing team we're a go for Project Anaconda") are exactly two-entity, one-relation lookups. Hop
   depth is a tunable (`recall.hops`, default 1); deeper risks dragging in half the graph.

Phantom and stale nodes are included but flagged so the brain knows the difference between "no info" and
"info I have".

### 3.2 The recall algorithm

```ts
interface RecallQuery {
  text: string;                 // the task / message to resolve against
  hint?: { names?: string[]; types?: NodeType[] }; // optional: brain or intake-extracted entities
  k?: number;                   // seeds before expansion (default 6)
  hops?: number;                // link expansion depth (default 1)
}

interface RecallResult {
  index: IndexLine[];           // the full cheap index (always returned)
  hits: ScoredNode[];           // seed matches, full bodies, descending relevance
  expanded: ScoredNode[];       // one-hop neighbors of hits (de-duped against hits)
  phantoms: string[];           // referenced-but-undocumented names encountered
  notes: string[];              // e.g. "marketing-team is stale (ttl 2026-06-25)"
}

interface ScoredNode { node: MemoryNode; score: number; via: "match" | "link"; reason: string; }

function recall(q: RecallQuery, g: MemoryGraph): RecallResult {
  const k = q.k ?? 6, hops = q.hops ?? 1;

  // Tier 2: score index lines against the task; honor explicit name/type hints.
  const seeds: ScoredNode[] = g.index
    .map(line => {
      const node = g.nodes.get(line.name)!;
      let s = scoreRelevance(q.text, node);          // token overlap on description+name+aliases
      if (q.hint?.names?.includes(node.name)) s += 100;
      if (q.hint?.types?.includes(node.type)) s += 5;
      if (node.stale) s *= 0.5;                       // deprioritize, don't drop
      return { node, score: s, via: "match" as const, reason: "description match" };
    })
    .filter(x => x.score > RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Tier 3: one-hop expansion along edges (BFS to `hops`).
  const seen = new Set(seeds.map(s => s.node.name));
  const expanded: ScoredNode[] = [];
  let frontier = seeds.map(s => s.node.name);
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const e of [...(g.out.get(name) ?? []), ...highValueBacklinks(g.in.get(name))]) {
        if (seen.has(e.to)) continue;
        seen.add(e.to); next.push(e.to);
        const n = g.nodes.get(e.to)!;
        expanded.push({ node: n, score: edgeWeight(e), via: "link",
                        reason: `linked from ${e.from} via ${e.field}` });
      }
    }
    frontier = next;
  }

  return {
    index: g.index,
    hits: seeds,
    expanded: expanded.sort((a, b) => b.score - a.score),
    phantoms: [...seen].filter(n => g.nodes.get(n)?.phantom),
    notes: [...seeds, ...expanded].filter(x => x.node.stale)
                                  .map(x => `${x.node.name} is stale`),
  };
}
```

`highValueBacklinks` keeps reverse edges like `owners`/`members`/`announce-channel` but drops noisy
incidental prose backlinks, so expansion pulls "who owns Anaconda" without pulling every file that ever
name-dropped it.

### 3.3 When recall runs in the loop

Recall is invoked at the **judgment** steps that benefit from world-knowledge (per [Spec 04](./04-state-machine.md)
transitions, model routing per [Spec 06](./06-brain-models.md)):

- **CLARIFY / PLAN (Opus):** resolve entities named in the request; decide if a missing fact is a real
  ambiguity (ask) or recoverable from memory (proceed).
- **STAFF (Opus):** pull relevant **worker-notes** (§5) so the static capability table is overlaid with
  learned reality ("prefer Claude for data-layer here").
- **DELIVER / agency (Spec 07):** resolve targets for an action (the `emails` on `[[marketing-team]]`).

Intake (Haiku) does *not* do full recall — it may do a cheap name-spot against the index to enrich its
ack, but full recall is an Opus-tier concern.

### 3.4 Interface seam with Spec 06 ⚠️

Spec 06 calls `recall()` and receives `RecallResult`; it owns turning that into prompt text under a
token budget (likely: full index verbatim + `hits` bodies in full + `expanded` truncated to
description+key-fields). The contract: **recall never truncates bodies** (it returns whole nodes);
budget enforcement lives in Spec 06 so memory has no opinion on model context size. This boundary must
be confirmed when Spec 06 is written.

---

## 4. Write / update (the learn path)

### 4.1 What gets written, and by whom

| Trigger | Type written | Who decides | When |
|---|---|---|---|
| A new person/team/project/preference/env fact surfaces in conversation | `person`/`project`/`preference`/`env` | **Opus** (judgment), via a structured `remember` tool-call | end of CLARIFY/PLAN or DELIVER turn |
| A worker passes/fails GATE | (raw stats → SQLite, Spec 09; **not** a markdown write per-gate) | orchestrator | every GATE |
| Worker-note refresh from accumulated stats | `worker-note` | **Opus** summarizer job (§5) | when a stat window shifts ≥ threshold |
| Env self-scan finds a new project/tool | `env` | env-scanner (§7) proposes; Opus confirms | on scan / project create |
| Jason states a decision worth not relitigating | `decision` | Opus | when recognized |

**Memory writes are an Opus-gated action, not a reflex.** The brain emits a structured `remember`
intent (below); the memory subsystem executes it (dedup + file write + index regen). This keeps a
human-legible "why did Beckett learn this" trail and prevents cheap models from polluting the graph.

```ts
interface RememberIntent {
  op: "create" | "update" | "append" | "link";
  name: string;                          // target node (kebab-case)
  type?: NodeType;                        // required for create
  description?: string;
  metadata?: Record<string, unknown>;    // typed fields to set/merge
  body?: string;                         // prose to set (create) or append (append)
  links?: { to: string; field: string }[]; // edges to add (may target phantoms)
  source: MemoryNode["source"];
  reason: string;                        // why — logged to event log (Spec 09)
}

async function remember(intent: RememberIntent, g: MemoryGraph): Promise<MemoryNode> { /* §4.3 */ }
```

### 4.2 Dedup — update vs create (the critical safeguard)

Before any `create`, the subsystem checks whether a node already covers the fact, to avoid duplicate
`marketing-team` / `the-marketing-team` / `marketing` nodes:

```ts
function findExisting(intent: RememberIntent, g: MemoryGraph): MemoryNode | null {
  // 1. exact name / alias hit
  const byName = g.nodes.get(intent.name);
  if (byName && !byName.phantom) return byName;
  for (const n of g.nodes.values())
    if (asArray(n.metadata.aliases).map(slug).includes(slug(intent.name))) return n;

  // 2. a phantom with this name → "fill it in" (upgrade, not create)
  if (byName?.phantom) return byName;

  // 3. high-similarity description/name match of the SAME type → likely the same fact
  const cand = [...g.nodes.values()]
    .filter(n => !n.phantom && n.type === (intent.type ?? n.type))
    .map(n => ({ n, sim: similarity(intent.description ?? "", n.description) + nameSim(intent.name, n.name) }))
    .sort((a, b) => b.sim - a.sim)[0];
  return cand && cand.sim > DEDUP_THRESHOLD ? cand.n : null;
}
```

- Hit → the op is coerced to `update`/`append` on the existing node (merging metadata, appending body,
  adding links), `updated` bumped.
- Filling a **phantom** → upgrade in place; all existing inbound edges instantly resolve.
- A borderline match (just below threshold) is surfaced to Opus as "is this the same as `[[x]]`?"
  rather than silently creating or merging. ⚠️ `DEDUP_THRESHOLD` needs tuning against real data; start
  conservative (favor flagging over auto-merge — a wrong merge is harder to undo than a duplicate).

### 4.3 Don't store what the repo/code already records (the anti-bloat safeguard)

Memory is for **durable, cross-task, world-level facts** — not a scratchpad and not a mirror of things
that already have a system of record:

- ❌ Don't store code facts the repo holds (function signatures, file structure) — a worker re-reads the
  code. Memory stores the *project's status and people*, not its source.
- ❌ Don't store per-task ephemera (a worker's intermediate plan) — that's the JSONL/SQLite event log
  ([Spec 09](./09-persistence-data-model.md)).
- ❌ Don't store raw gate metrics as markdown — those live in SQLite `outcomes`; only the **derived
  narrative** (worker-note, §5) is markdown.
- ✅ Do store: people + how to reach them, projects + status + owners, standing preferences, env facts,
  decisions, learned-worker narratives, durable external references.

The `remember` prompt (Spec 06) carries this rubric; the subsystem additionally rejects a `create`
whose body is mostly a code snippet or whose `source` claims `conversation` but matches a known
ephemeral pattern. ⚠️ The reject heuristics are a v1 best-effort; the primary guard is the Opus rubric.

### 4.4 The write itself

```ts
async function remember(intent: RememberIntent, g: MemoryGraph): Promise<MemoryNode> {
  const lock = await acquireMemoryLock();                 // §8.1
  try {
    const existing = findExisting(intent, g);
    const op = existing ? (intent.op === "create" ? "update" : intent.op) : "create";
    const node = op === "create" ? newNode(intent) : mergeInto(existing!, intent);

    node.metadata.updated = nowIso();
    if (op === "create") node.metadata.created = node.metadata.updated;

    const path = node.path ?? pathFor(node);               // type-folder + name.md
    await writeFileAtomic(path, render(node));             // tmp + rename (§8.1)
    patchGraph(g, node, intent.links);                     // update nodes/out/in in memory
    await regenerateBacklinks(g, affectedTargets(intent)); // §2.5
    await regenerateIndex(g);                              // §4.5 — rewrite MEMORY.md
    await mirrorPatchSqlite(g, node);                      // §2.4 (Spec 09)
    await appendEvent({ kind: "memory.write", op, name: node.name, reason: intent.reason }); // Spec 09
    await maybeCommit("memory: " + op + " " + node.name);  // §8.2 git
    return node;
  } finally { await lock.release(); }
}
```

### 4.5 Index regeneration

`MEMORY.md` is rebuilt from the in-memory graph on every write (it's tiny): group non-phantom nodes by
`type`, emit `- [[name]] — description` per line, stamp the header comment with count + timestamp.
Regeneration is deterministic (stable sort by type then name) so the git diff of a single fact change is
a single line — keeping memory history readable (§8.2).

### 4.6 Rename / merge / delete

- **Rename** (`name` change) = move the file, update every inbound edge's `[[old]]`→`[[new]]` across
  linkers, regen index + backlinks. A graph migration helper does this transactionally under the lock.
- **Merge** two real nodes = pick survivor, append the other's body, union metadata/links, rewrite the
  loser's inbound edges to the survivor, delete the loser. Used when dedup catches a late duplicate.
- **Delete** = remove file; inbound edges degrade to **phantom** edges (we don't silently rewrite other
  files' prose) and a `notes` entry warns the next recall that a linked node vanished.

---

## 5. Worker-notes — the learned-model narrative surface

Per [Spec 00 §2 pillar 2](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool)
and the **learned-model = design-for, build-later** ledger row, Beckett's "Codex over-engineers data
layers" intuition is a *two-layer* asset:

```
SQLite `outcomes` (raw, from day one)        ← Spec 09 / Spec 11 own this
  (harness, model, task_type) → {passed, retries, drift_events, turns, review_flags}
        │  Opus summarizer job (periodic / window-shift)
        ▼
worker-note markdown (narrative, derived)    ← THIS spec owns the file + refresh
  "Codex over-engineers data-layer nodes; prefer Claude or constrain."
        │  recall() at STAFF
        ▼
overlays the static capability table         ← STAFF (Spec 04/06) consumes
```

- **The raw stats are not memory** — they're SQLite rows logged at every GATE ([Spec 09](./09-persistence-data-model.md)).
  Memory holds only the **human-legible narrative** Opus distills from them. This is the only memory
  type with `source: derived`.
- **Generation/refresh:** a low-priority Opus job (cron-style, or triggered when a
  `(harness, model, task_type)` bucket's window shifts by ≥ N gates) reads the bucket's stats + the
  current worker-note (if any) and emits a `RememberIntent` (`update` the worker-note). It sets
  `derived_from`, `stat_window`, `n_samples`, `confidence` (low until enough samples), and writes prose
  that names the *implication for STAFF*, not just the numbers.
- **It links into the rest of the graph:** worker-notes `[[link]]` sibling notes
  (`[[claude-on-data-layers]]`) so STAFF recall pulls the comparison set in one hop.
- **Guardrail:** until a bucket has ≥ `MIN_SAMPLES` gates, no worker-note is written (no narrative from
  noise); the static capability table stands alone. ⚠️ `MIN_SAMPLES` and the window-shift trigger are
  tunables to pin with Spec 09/11.

---

## 6. End-to-end worked example

**Request (Discord):** `@beckett email the marketing team that we're a go for Project Anaconda`

1. **INTAKE (Haiku).** Classifies as an *agency/email* task. Cheap index spot-check matches the tokens
   "marketing team" → `[[marketing-team]]` and "Project Anaconda" → `[[project-anaconda]]` in the
   always-loaded `MEMORY.md`. Acks honestly in-channel: *"on it — drafting the go note to the marketing
   team for anaconda."* Silently tags in Opus (per [Spec 00](./00-overview.md) hybrid brain).

2. **PLAN (Opus) → recall.** `recall({ text: "email the marketing team that we're a go for Project
   Anaconda", hint: { names: ["marketing-team", "project-anaconda"] } })`:
   - **Tier 1:** full `MEMORY.md` index in context.
   - **Tier 2 (hits):** `marketing-team.md` (full) and `project-anaconda.md` (full) score top via the
     name hints.
   - **Tier 3 (one-hop expansion):**
     - from `marketing-team` → `[[dana]]`, `[[priya]]`, `[[marcus]]` (members) — Beckett learns Dana is
       lead and *prefers a heads-up first*.
     - from `project-anaconda` → `[[marketing-team]]` (already a hit), `[[jason]]` (owner), `[[loom-desk]]`.
   - **Result fields:** `marketing-team.metadata.emails = ["marketing@loomlabs.dev"]`,
     `project-anaconda.metadata.status = "code-freeze"`, deadline Jul 15, announce-flow prose.
   - The two-entity, one-relation query is fully resolved from memory — exactly the case §3.1 is built
     for. No CLARIFY needed (recipient + context both recovered; nothing irreversible is ambiguous).

3. **Draft (Opus, persona-applied).** Composes the email: recipient `marketing@loomlabs.dev`, subject
   "Anaconda: we're a go", body referencing the ship date (Jul 15) pulled from the project node. Notes
   Dana's heads-up preference as a delivery nuance.

4. **Handshake (Spec 07).** Email is an **irreversible outbound** action → never auto-sent
   ([open-questions F2](../my-docs/open-questions.md)). Beckett creates the draft via the Gmail identity
   and asks in-channel: *"drafted the go note to marketing@loomlabs.dev (cc'ing per the anaconda announce
   flow) — send as me, or you want to eyeball it first?"* Send target + content both came from memory;
   the action gate is owned by [Spec 07](./07-identity-agency.md).

5. **(Optional) learn-back.** If during this exchange Jason says "actually Dana left, route to Priya
   now," Opus emits a `RememberIntent` `update` on `marketing-team` (drop `[[dana]]` from members /
   mark phantom-departed, set Priya lead), bumping `updated` and regenerating the index — so the next
   Anaconda note is correct without re-asking.

**Memory files touched:** `marketing-team.md` (+ its members `dana`/`priya`/`marcus`),
`project-anaconda.md`, `jason.md`, `loom-desk.md` (expansion), `MEMORY.md` (index, read; rewritten only
if step 5 fires).

---

## 7. Environment self-knowledge

Beckett's "deep understanding of its own environment" ([open-questions K](../my-docs/open-questions.md))
is `type: env` memory, kept fresh by a scanner so it reflects reality rather than a stale one-time note:

- **`env/loom-desk.md`** (`subtype: host`): OS, cores/RAM, installed tools + versions (bun, docker, git,
  claude/codex CLIs), the `beckett` OS user, paths. `verified` timestamp from last scan.
- **`env/projects-inventory.md`** (`subtype: project-inventory`): what lives under
  `/home/beckett/projects/` — one `[[project-x]]` link per repo, so the inventory node *is* the hub
  edge into every project node. When Beckett creates a project ([Spec 00](./00-overview.md) "can create
  projects & register them in memory"), it writes a `project` node and adds the link here.
- **`env/<tool>.md`** (`subtype: tool`): non-obvious tool facts/quirks Beckett learned (e.g. "node v18
  here is too old; use bun").
- **`env/*.md`** (`subtype: account`): which identities exist (its GitHub handle, Gmail address) —
  pointers only; **secrets stay in `~/.beckett/.env`, never in memory** (§8.3).

**The env scanner** (a daemon-startup + periodic job, [Spec 01](./01-architecture.md) owns scheduling)
runs read-only probes (`uname`, tool `--version`, `ls /home/beckett/projects`, `git remote`), diffs
against existing `env` nodes, and emits `RememberIntent`s for drift (new project, upgraded tool). It
`update`s `verified`; material changes go through the same Opus-confirm path as any write. Env facts are
derived (`source: env-scan`) and carry a `verified` timestamp so recall can flag staleness if a scan
hasn't run recently. This is what lets a request like "what projects do I have?" or "set up a new repo
like the others" resolve from memory + a fresh scan rather than guesswork.

---

## 8. Concurrency, versioning & privacy

### 8.1 Concurrency / locking (multiple writers)

The daemon is single-process ([Spec 00](./00-overview.md)/[Spec 01](./01-architecture.md)), but multiple
**logical** writers exist (parallel Opus decisions across tasks, the worker-note job, the env scanner)
plus possible out-of-band edits (Jason, `git pull`). Strategy:

- **Single in-process async mutex** serializes all `remember()` writes (the graph + index must mutate
  atomically together). Writes are fast (small files), so a global memory lock is fine; no per-node
  locking needed in v1.
- **Atomic file writes:** write to `name.md.tmp` then `rename()` (atomic on the same fs) so a reader
  never sees a half-written file. The index is written the same way.
- **Out-of-band edits:** an `fs.watch` on `memory/` invalidates and incrementally re-parses changed
  files into the graph, so a manual edit or `git pull` is reflected without a daemon restart. A write
  that races a concurrent external edit is detected by mtime mismatch on the lock-held read → re-read →
  re-merge (last-writer-wins at file granularity, but merges are append-oriented so loss is rare). ⚠️
  True multi-*process* writers (a future second daemon / multiplayer) would need a file lock
  (`flock`/lockfile); out of scope for single-user v1 but the mutex API is the seam.

### 8.2 Versioning (git the memory dir?)

**Yes — `~/.beckett/memory/` is its own git repo.** Rationale: memory is the most precious earned asset,
edits are small and human-legible, and git gives free history/undo/blame ("when did Beckett learn
Dana left?") and a backup path (push to a private remote). Mechanics:

- `remember()` does a quiet `git add -A && git commit -m "memory: <op> <name>"` after each write
  (deterministic index regen → clean one-line diffs, §4.5). Commits are squashable later if noisy.
- Optional periodic `git push` to a private backup remote (config-gated). This *also* makes
  cross-machine memory sync ([open-questions G3](../my-docs/open-questions.md)) a future possibility,
  though cross-project learning is explicitly later-scope.
- Committing memory is separate from project repos (it's `~/.beckett/memory/`, not
  `/home/beckett/projects/*`), so it never tangles with worker worktrees. ⚠️ Aligns with the user's
  global "use git for changes" rule, scoped to the memory repo specifically.

### 8.3 Privacy

- **No secrets in memory, ever.** Credentials/tokens live only in `~/.beckett/.env`
  ([Spec 00](./00-overview.md)). `env` account nodes hold *identifiers* (handles, addresses), never
  secrets. The `remember` path rejects writes whose values match secret-shaped patterns (high-entropy
  strings, known key prefixes) as a backstop.
- **PII is intentional but contained.** Memory legitimately holds people's emails/roles — that's the
  point. It stays local to `~/.beckett/` on loom-desk (single trusted box); the git remote (if enabled)
  must be private. Multiplayer ([Spec 00](./00-overview.md) design-for-build-later) will need per-`user_id`
  visibility scoping on memory; v1 is single-tenant so all memory is Jason's. ⚠️ Memory ACLs are a
  multiplayer-era concern flagged here, not built in v1.
- **Right to forget:** `beckett memory rm <name>` (Spec 10) deletes the file + commits the removal, and
  git history can be scrubbed if a fact must be truly expunged.

### 8.4 Maintenance sweeps

A low-priority periodic job: re-verifies `env` nodes (re-scan), flags long-stale / past-TTL nodes for
refresh-or-remove, reports phantoms (undocumented known entities) and orphans (no edges in or out), and
proposes worker-note refreshes when stat windows shifted. All proposals route through Opus + the normal
`remember` path — the sweep never mutates the graph unilaterally beyond bumping `verified`/`stale` flags.

---

## 9. Open gaps ⚠️

1. **Spec 06 recall→prompt seam (§3.4):** token-budget ownership and exact framing of `hits` vs
   `expanded` must be pinned when Spec 06 is written. Contract here: recall returns whole nodes, never
   truncates.
2. **Spec 09 SQLite mirror (§2.4):** DDL for `memory_nodes`/`memory_edges`, whether FTS5 ships in v1,
   and the `outcomes`→worker-note provenance join.
3. **`DEDUP_THRESHOLD` + `MIN_SAMPLES` + worker-note window-shift trigger** (§4.2, §5) need tuning
   against real data; start conservative (flag over auto-merge; no narrative from noise).
4. **Relevance scoring** is lexical in v1 (§3.1); embedding-based recall is an upgrade — confirm whether
   v1 even needs embeddings given the small graph.
5. **Multi-process / multiplayer locking + per-user memory ACLs** (§8.1, §8.3) deferred to the
   multiplayer era; mutex API is the seam.
6. **Anti-bloat reject heuristics** (§4.3) are best-effort; the real guard is the Opus `remember` rubric
   — confirm the rubric copy with Spec 06.
7. **Env scanner scheduling** (§7) — owned by Spec 01; this spec only defines what it writes.

---

## 10. Summary

1. **Format:** per-fact markdown under `~/.beckett/memory/` with YAML frontmatter (`name` kebab-case +
   unique == node id == wikilink target; `description` = recall's match surface; `metadata.type` ∈
   {person, project, preference, env, worker-note, reference, decision, …} with type-specific fields) +
   a prose body where `[[wikilinks]]` are graph edges; a generated `MEMORY.md` index (one line per fact)
   that is always cheap-loaded.
2. **Graph:** nodes = files, edges = wikilinks (directed, typed by source field; reverse adjacency makes
   traversal bidirectional). Built once at daemon start (parse frontmatter + links → in-memory maps +
   best-effort SQLite mirror), incrementally patched per write and via `fs.watch`. **Forward-refs are
   first-class:** a `[[name]]` with no file yet is a valid dangling edge to a phantom node that upgrades
   in place when filled.
3. **Recall** (`recall(query, graph) → RecallResult`): always inject the index, score `description`
   against the task for top-K full-file fetches, then expand **one hop** along edges — exactly the
   two-entity/one-relation shape of the motivating queries. Recall returns whole nodes; prompt assembly
   + budget is Spec 06's.
4. **Write/update** is an **Opus-gated `RememberIntent`**, not a reflex: dedup (name/alias/phantom/
   similarity) coerces create→update to avoid duplicate nodes; anti-bloat rules forbid storing what the
   repo/event-log already records; every write regenerates the index + backlinks, mirrors to SQLite,
   logs an event, and git-commits the memory repo.
5. **Worker-notes** are the learned-model narrative surface: raw `(harness, model, task_type)` gate
   stats live in SQLite (Spec 09, from day one); Opus distills them into `source: derived` `worker-note`
   markdown ("Codex over-engineers data layers") that recall overlays onto the static capability table
   at STAFF — no narrative until a bucket has enough samples.
6. **Env self-knowledge** (`type: env`, kept fresh by a read-only scanner), the worked Anaconda email
   trace (recall resolves `[[marketing-team]]` emails + `[[project-anaconda]]` status → draft →
   Spec 07 handshake), and ops (in-process mutex + atomic writes, the memory dir as its own git repo for
   history/backup, secrets-never-in-memory privacy) round out the subsystem.

**Flagged inconsistencies / forks:** none contradict the [Spec 00 ledger](./00-overview.md#4-canonical-decisions-the-ledger).
Open items (§9) are deeper-than-canon seams left for siblings: the Spec 06 recall→prompt budget
contract, the Spec 09 SQLite-mirror DDL + worker-note provenance, and several tunables
(`DEDUP_THRESHOLD`, `MIN_SAMPLES`, hop depth, embeddings-or-not) to calibrate on real data.
```
