/**
 * Beckett — Memory & Knowledge Graph (`src/memory/index.ts`)
 * =======================================================================================
 * The markdown knowledge-graph memory at `config.memory_dir` (~/.beckett/memory). Implements
 * the {@link Memory} contract from `../types.ts`:
 *
 *   - `recall(query)`  → a relevance-ranked bundle of memory snippets to inject into a brain
 *                        call (Spec 08 §3): always the cheap index, then description-scored
 *                        full-file hits, then one-hop link expansion. Recall NEVER truncates a
 *                        body — prompt budgeting is Spec 06's job (Spec 08 §3.4).
 *   - `remember(intent)` → create/update/append/link a memory file with dedup (Spec 08 §4),
 *                        regenerate `## Backlinks`, rewrite the always-loaded `MEMORY.md`
 *                        index, mirror to SQLite, log an event, and git-commit the memory repo.
 *   - `reindex()`      → rebuild the SQLite mirror from the markdown tree (Spec 09 §2.12).
 *   - `maintain(opts)` → the OPS-121 self-healing pass: archive expired/superseded nodes,
 *                        merge near-duplicates, flag borderline pairs. Planning is pure in
 *                        `./maintain.ts`; execution (file moves, link rewrites) lives here.
 *                        Nothing is ever deleted — archived files move to `archive/`
 *                        (excluded from the graph) and the dir is git-versioned.
 *
 * Retrieval scoring lives in `./search.ts` (OPS-121): stemmed, IDF-weighted, full-node
 * (body + metadata) keyword relevance — deliberately lexical and deterministic, not
 * embeddings. Recall rebuilds the graph from disk on every call, so facts written by any
 * session (or an out-of-band `git pull`) are always visible to the next query.
 *
 * Design choices honoring Spec 08:
 *   - **Files are canonical** (Spec 08 §2.4). The in-memory graph is rebuilt from disk on every
 *     read/write, so an out-of-band `git pull` or manual edit is always reflected without a
 *     daemon restart (this stands in for the §2.3 `fs.watch` without extra machinery — the tree
 *     is tens-to-low-hundreds of small files, so the cost is trivial).
 *   - **A node's id is its `name`** (kebab-case), globally unique across the tree; `[[wikilinks]]`
 *     resolve by name regardless of folder (Spec 08 §1.1).
 *   - **Forward-refs are first-class**: `[[name]]` with no file yet is a valid dangling edge to a
 *     phantom node that upgrades in place when filled (Spec 08 §2.5).
 *   - **The index is derived from the parsed nodes**, and `MEMORY.md` is its on-disk
 *     materialization — so the index recall returns is always in sync with the files even if
 *     `MEMORY.md` is stale or hand-deleted.
 *
 * Dependency-free: the simple YAML frontmatter is parsed by a small in-file parser (no yaml lib),
 * per the module brief.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type {
  IndexLine,
  Logger,
  Memory,
  MemoryEdge,
  MemoryGraph,
  MemoryNode,
  NodeType,
  RecallQuery,
  RecallResult,
  RememberIntent,
  ScoredNode,
} from "../types.ts";
import { log as rootLog } from "../log.ts";
import { corpusStats, DEDUP_THRESHOLD, nodeSimilarity, scoreNode } from "./search.ts";
import { planMaintenance, type MaintainReport } from "./maintain.ts";

// =======================================================================================
// Tunables (Spec 08 §3, §4.2 — start conservative; favor flagging over auto-merge)
// =======================================================================================

/** Seeds fetched before link expansion when the query doesn't specify `k` (Spec 08 §3.2). */
const DEFAULT_K = 6;
/** Link-expansion hop depth when the query doesn't specify `hops` (Spec 08 §3.1). */
const DEFAULT_HOPS = 1;
/** A seed must beat this lexical score to qualify (Spec 08 §3.2 `RELEVANCE_FLOOR`). */
const RELEVANCE_FLOOR = 0;
/** Nodes updated within this window get a mild recall boost (fresh facts first on a tie). */
const RECENT_DAYS = 30;
/** Frontmatter fields whose `[[wikilinks]]` are structural edges (higher weight than prose). */
const STRUCTURAL_FIELDS = new Set(["members", "owners", "applies_to", "supersedes"]);
/** Reverse edges worth following on expansion; incidental prose backlinks are dropped (§3.2). */
const HIGH_VALUE_BACKLINK_FIELDS = new Set(["members", "owners", "applies_to", "supersedes"]);

/** `[[kebab-name]]` or `[[kebab-name|alias]]` — a directed graph edge (Spec 08 §2.2). */
const WIKILINK = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;

/** Subdirectory (top-level) that holds archived nodes — on disk, out of the graph. */
const ARCHIVE_DIR = "archive";

/** Maps a node `type` to its conventional subdirectory (Spec 08 §1.1 — folders are cosmetic). */
const TYPE_FOLDER: Record<string, string> = {
  person: "people",
  project: "projects",
  preference: "prefs",
  env: "env",
  "worker-note": "workers",
  reference: "references",
  decision: "decisions",
};

/** Deterministic metadata key order for clean one-line git diffs (Spec 08 §4.5). */
const META_ORDER = [
  "type",
  // person
  "emails", "role", "aliases", "members", "timezone",
  // project
  "status", "repo", "owners", "channels", "deadline",
  // preference
  "scope", "applies_to",
  // env
  "subtype", "path", "verified",
  // worker-note
  "harness", "model", "task_type", "derived_from", "stat_window", "n_samples",
  // reference
  "url", "domain",
  // decision
  "decided", "supersedes",
];
/** Provenance fields rendered last (Spec 08 §1.2). */
const META_TAIL = ["created", "updated", "source", "confidence", "ttl", "archived", "archived_reason"];

// =======================================================================================
// Construction
// =======================================================================================

/** Dependencies for the memory subsystem (the daemon wires these). */
export interface MemoryDeps {
  /** Absolute path to the memory dir (Paths.memoryDir, e.g. ~/.beckett/memory). */
  memoryDir: string;
  /** Logger; defaults to the root logger's `memory` child. */
  logger?: Logger;
  /** Git-version the memory dir on every write (Spec 08 §8.2). Default true; best-effort. */
  git?: boolean;
}

/** Build the {@link Memory} implementation. */
export function createMemory(deps: MemoryDeps): MemoryStore {
  return new MemoryStore(deps);
}

// =======================================================================================
// The implementation
// =======================================================================================

export class MemoryStore implements Memory {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly git: boolean;
  /** Single in-process async mutex serializing writes (Spec 08 §8.1). */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Raw file contents captured during the last build (for content-hash + surgical edits). */
  private rawCache = new Map<string, string>();

  constructor(deps: MemoryDeps) {
    this.dir = deps.memoryDir;
    this.logger = deps.logger ?? rootLog.child("memory");
    this.git = deps.git ?? true;
  }

  // ── recall (Spec 08 §3) ────────────────────────────────────────────────────────────

  async recall(q: RecallQuery): Promise<RecallResult> {
    const g = this.buildGraph();
    return recallOver(q, g);
  }

  // ── remember (Spec 08 §4) ──────────────────────────────────────────────────────────

  async remember(intent: RememberIntent): Promise<MemoryNode> {
    return this.withLock(() => this.rememberLocked(intent));
  }

  private rememberLocked(intent: RememberIntent): MemoryNode {
    if (!intent.name || !/^[a-z0-9-]+$/.test(intent.name)) {
      throw new Error(`memory.remember: invalid node name '${intent.name}' (must be kebab-case)`);
    }
    this.ensureDir();
    let g = this.buildGraph();

    // 1. Dedup: does a node already cover this fact? (Spec 08 §4.2)
    const existing = findExisting(intent, g);
    const upgradingPhantom = Boolean(existing?.phantom);
    const usePrev = existing != null && !existing.phantom;
    const op: RememberIntent["op"] = usePrev
      ? intent.op === "create"
        ? "update"
        : intent.op
      : "create";

    // 2. Compose the node content (Spec 08 §4.4).
    const built = usePrev
      ? mergeInto(existing!, intent)
      : buildNewContent(intent);
    applyLinks(built, intent.links);

    const name = usePrev ? existing!.name : intent.name;
    const type = String(built.metadata.type ?? intent.type ?? existing?.type ?? "");
    if (!type) {
      throw new Error(`memory.remember: 'type' is required to create node '${name}'`);
    }
    const path =
      usePrev && existing!.path
        ? existing!.path
        : upgradingPhantom
          ? this.pathFor(name, type)
          : this.pathFor(name, type);

    // 3. Atomic write of the primary file (Spec 08 §8.1). Its own ## Backlinks reflect the
    //    inbound edges already present in the graph (e.g. phantom links being filled in).
    const primary: MemoryNode = {
      name,
      type,
      description: built.description,
      metadata: built.metadata,
      body: built.body,
      path,
      created: String(built.metadata.created ?? ""),
      updated: String(built.metadata.updated ?? ""),
      source: (built.metadata.source as MemoryNode["source"]) ?? intent.source,
      confidence: built.metadata.confidence as MemoryNode["confidence"],
      stale: isExpired(built.metadata.ttl),
      phantom: false,
      mtime: Date.now(),
    };
    this.atomicWrite(path, renderNode(primary, g));

    // 4. Rebuild the graph from disk (now includes the new node + its out-edges), then
    //    refresh the ## Backlinks of every real out-target (Spec 08 §2.5, §4.4).
    g = this.buildGraph();
    for (const e of g.out.get(name) ?? []) {
      const target = g.nodes.get(e.to);
      if (target && !target.phantom && target.name !== name) {
        this.refreshBacklinksOnDisk(target, g);
      }
    }

    // 5. Regenerate the always-loaded index (Spec 08 §4.5) + mirror + event + commit.
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    this.commit(`memory: ${op} ${name}`);

    const result = g.nodes.get(name);
    if (!result) throw new Error(`memory.remember: node '${name}' missing after write`);
    return result;
  }

  // ── maintain (OPS-121 — routine staleness pruning + dedup) ───────────────────────────

  /**
   * One self-healing pass: archive expired/superseded nodes, merge near-duplicates,
   * report borderline pairs and phantoms. `dryRun` plans without touching disk.
   * Serialized behind the same write lock as remember.
   */
  async maintain(opts: { dryRun?: boolean } = {}): Promise<MaintainReport> {
    return this.withLock(() => this.maintainLocked(opts));
  }

  private maintainLocked(opts: { dryRun?: boolean }): MaintainReport {
    this.ensureDir();
    let g = this.buildGraph();
    const scanned = [...g.nodes.values()].filter((n) => !n.phantom).length;
    const plan = planMaintenance(g, Date.now());
    const report: MaintainReport = { scanned, ...plan, dryRun: Boolean(opts.dryRun) };
    if (report.dryRun || (plan.archives.length === 0 && plan.merges.length === 0)) return report;

    // Merges first: they rewrite inbound links, which archiving must not race.
    for (const m of plan.merges) {
      const canonical = g.nodes.get(m.canonical);
      const dup = g.nodes.get(m.duplicate);
      if (!canonical || !dup || canonical.phantom || dup.phantom) continue;
      this.mergeNodes(canonical, dup, g);
      g = this.buildGraph(); // later actions must see the rewritten tree
    }
    for (const a of plan.archives) {
      const node = g.nodes.get(a.name);
      if (!node || node.phantom || !node.path) continue;
      this.archiveFile(node, a.reason + (a.by ? ` by ${a.by}` : ""), g);
    }

    // Everything moved/rewritten — settle derived state: backlinks, index, git.
    g = this.buildGraph();
    for (const n of g.nodes.values()) {
      if (!n.phantom && n.path) this.refreshBacklinksOnDisk(n, g);
    }
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    this.commit(
      `memory: maintenance (${plan.archives.length} archived, ${plan.merges.length} merged)`,
    );
    this.logger.info("memory: maintenance executed", {
      archived: plan.archives.map((a) => a.name).join(",") || "-",
      merged: plan.merges.map((m) => `${m.duplicate}→${m.canonical}`).join(",") || "-",
      flagged: plan.flagged.length,
    });
    return report;
  }

  /**
   * Fold `dup` into `canonical`: rewrite inbound `[[dup]]` wikilinks to the canonical name,
   * append the duplicate's full description+body under a dated "Merged from" heading (no
   * content is lost), union the aliases (including the duplicate's name, so future
   * remember/recall by the old name resolves here), then archive the duplicate's file.
   * Note: bare (non-wikilink) structural-field references to the old name are NOT rewritten —
   * they degrade to a phantom, which the maintenance report surfaces.
   */
  private mergeNodes(canonical: MemoryNode, dup: MemoryNode, g: MemoryGraph): void {
    const now = nowIso();
    for (const e of g.in.get(dup.name) ?? []) {
      const from = g.nodes.get(e.from);
      if (!from || from.phantom || !from.path || from.name === dup.name) continue;
      this.rewriteWikilinks(from.path, dup.name, canonical.name);
    }

    const metadata: Record<string, unknown> = { ...dup.metadata, ...canonical.metadata };
    const aliases = new Set<string>([
      ...asStringArray(canonical.metadata.aliases),
      ...asStringArray(dup.metadata.aliases),
      dup.name,
    ]);
    aliases.delete(canonical.name);
    metadata.aliases = [...aliases];
    metadata.updated = now;

    const dupPart = [dup.description, dup.body].filter(Boolean).join("\n\n");
    const body = `${canonical.body.trim()}\n\n## Merged from ${dup.name} (${now.slice(0, 10)})\n\n${dupPart}`
      .replaceAll(`[[${dup.name}]]`, `[[${canonical.name}]]`)
      .replaceAll(`[[${dup.name}|`, `[[${canonical.name}|`)
      .trim();

    this.atomicWrite(
      canonical.path,
      renderNode({ ...canonical, metadata, body, updated: now, mtime: Date.now() }, g),
    );
    this.archiveFile(dup, `merged into ${canonical.name}`, g);
  }

  /** Move a node's file into `archive/` with `archived`/`archived_reason` stamped — never a
   *  delete. Archived files are invisible to the graph (listMarkdownFiles skips the folder). */
  private archiveFile(node: MemoryNode, reason: string, g: MemoryGraph): void {
    const metadata = { ...node.metadata, archived: nowIso(), archived_reason: reason };
    let dest = join(this.dir, ARCHIVE_DIR, basename(node.path));
    for (let i = 2; existsSync(dest); i++) {
      dest = join(this.dir, ARCHIVE_DIR, basename(node.path).replace(/\.md$/, `-${i}.md`));
    }
    this.atomicWrite(dest, renderNode({ ...node, metadata }, g));
    try {
      unlinkSync(node.path);
    } catch (err) {
      this.logger.warn("memory: could not remove archived original", {
        path: node.path,
        err: String(err),
      });
    }
  }

  /** Retarget `[[from]]` / `[[from|alias]]` wikilinks in one file (body AND frontmatter). */
  private rewriteWikilinks(path: string, from: string, to: string): void {
    let raw: string;
    try {
      raw = this.rawCache.get(path) ?? readFileSync(path, "utf8");
    } catch {
      return;
    }
    const next = raw.replaceAll(`[[${from}]]`, `[[${to}]]`).replaceAll(`[[${from}|`, `[[${to}|`);
    if (next !== raw) {
      this.atomicWrite(path, next);
      this.rawCache.set(path, next);
    }
  }

  // ── reindex ──────────────────────────────────────────────────────────────────────────

  /** Rebuild + validate the in-memory graph from the markdown tree (the files ARE the store —
   *  the v2 SQLite mirror was deleted with the rest of the retired stack, issue #28). */
  async reindex(): Promise<void> {
    this.buildGraph();
  }

  // ── graph build (Spec 08 §2.3) ──────────────────────────────────────────────────────

  /** Parse the whole memory tree into the in-memory knowledge graph. */
  buildGraph(): MemoryGraph {
    this.rawCache.clear();
    const nodes = new Map<string, MemoryNode>();
    const out = new Map<string, MemoryEdge[]>();
    const inE = new Map<string, MemoryEdge[]>();

    const files = this.listMarkdownFiles();
    const parsed: { node: MemoryNode; edges: MemoryEdge[] }[] = [];
    for (const path of files) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        this.logger.warn("memory: unreadable file skipped", { path, err: String(err) });
        continue;
      }
      try {
        const pe = parseMemoryFile(path, raw, mtimeOf(path));
        this.rawCache.set(path, raw);
        parsed.push(pe);
      } catch (err) {
        // A malformed file is a build error surfaced to the log, never a throw (Spec 08 §1.1).
        this.logger.warn("memory: malformed file skipped", { path, err: String(err) });
      }
    }

    // 1. Real nodes — last-writer-by-mtime wins on a duplicate name (Spec 08 §1.1, §2.3).
    for (const { node } of parsed) {
      const prev = nodes.get(node.name);
      if (prev) {
        this.logger.warn("memory: duplicate node name; newer mtime wins", {
          name: node.name,
          kept: node.mtime >= prev.mtime ? node.path : prev.path,
        });
        if (node.mtime < prev.mtime) continue;
      }
      nodes.set(node.name, node);
    }

    // 2. Wire edges, minting phantom nodes for unresolved forward-refs (Spec 08 §2.5).
    for (const { node, edges } of parsed) {
      // Only the surviving (kept) node's edges count, to avoid double-wiring a duplicate.
      if (nodes.get(node.name)?.path !== node.path) continue;
      for (const e of edges) {
        if (!nodes.has(e.to)) nodes.set(e.to, phantomNode(e.to));
        pushEdge(out, e.from, e);
        pushEdge(inE, e.to, e);
      }
    }

    const index = buildIndex(nodes);
    return { nodes, out, in: inE, index, builtAt: Date.now() };
  }

  // ── filesystem helpers (Spec 08 §8.1) ───────────────────────────────────────────────

  private listMarkdownFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    let rels: string[];
    try {
      rels = readdirSync(this.dir, { recursive: true }) as string[];
    } catch {
      return [];
    }
    return rels
      .filter((r) => {
        if (!r.endsWith(".md") || r === "MEMORY.md") return false;
        const segments = r.split(/[\\/]/);
        // Archived nodes stay on disk but out of the graph (OPS-121 maintenance).
        return !segments.includes(".git") && segments[0] !== ARCHIVE_DIR;
      })
      .map((r) => join(this.dir, r));
  }

  private pathFor(name: string, type: string): string {
    const folder = TYPE_FOLDER[type] ?? slug(type) ?? "misc";
    return join(this.dir, folder, `${name}.md`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
    if (this.git && !existsSync(join(this.dir, ".git"))) {
      this.runGit(["init", "-q"]);
    }
  }

  /** Write to `<path>.tmp` then rename — atomic on the same fs (Spec 08 §8.1). */
  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }

  /**
   * Surgically replace a file's `## Backlinks` block without re-rendering human-authored
   * prose above it (Spec 08 §1.4 — the section is generated, everything above is authored).
   */
  private refreshBacklinksOnDisk(node: MemoryNode, g: MemoryGraph): void {
    let raw: string;
    try {
      raw = this.rawCache.get(node.path) ?? readFileSync(node.path, "utf8");
    } catch {
      return;
    }
    const head = frontmatterHead(raw);
    const body = stripGeneratedBacklinks(splitFrontmatter(raw).body).trim();
    const next = head + "\n" + composeBody(body, backlinkLines(g, node.name));
    if (next !== raw) {
      this.atomicWrite(node.path, next);
      this.rawCache.set(node.path, next);
    }
  }

  // ── git versioning (Spec 08 §8.2) ───────────────────────────────────────────────────

  private commit(message: string): void {
    if (!this.git) return;
    if (!existsSync(join(this.dir, ".git"))) return;
    this.runGit(["add", "-A"]);
    // -c flags avoid a dependency on a global git identity for the memory repo.
    this.runGit([
      "-c",
      "user.email=beckett@localhost",
      "-c",
      "user.name=beckett",
      "commit",
      "-q",
      "-m",
      message,
      "--allow-empty",
    ]);
  }

  private runGit(args: string[]): void {
    try {
      execFileSync("git", ["-C", this.dir, ...args], { stdio: "ignore" });
    } catch (err) {
      // Versioning is best-effort; a missing git binary never breaks memory (Spec 08 §8.2).
      this.logger.debug("memory: git command failed", { args: args.join(" "), err: String(err) });
    }
  }

  // ── write serialization (Spec 08 §8.1) ──────────────────────────────────────────────

  private withLock<T>(fn: () => T): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    // Keep the chain alive regardless of this op's outcome.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// =======================================================================================
// Recall (pure over the graph — Spec 08 §3.2)
// =======================================================================================

/** Score + expand a query against a built graph. Exported for testing/Spec 06 reuse. */
export function recallOver(q: RecallQuery, g: MemoryGraph): RecallResult {
  const k = q.k ?? DEFAULT_K;
  const hops = q.hops ?? DEFAULT_HOPS;
  const now = Date.now();

  // Targeted retrieval (OPS-121): --type / --name narrow the candidate set BEFORE scoring,
  // so `beckett recall --type person` is a precise fetch, not a fuzzy ranking.
  const typeFilter = q.filter?.types?.length ? new Set(q.filter.types) : null;
  const nameFilter = q.filter?.names?.length ? new Set(q.filter.names) : null;
  const candidates = g.index.filter(
    (line) =>
      (!typeFilter || typeFilter.has(line.type)) && (!nameFilter || nameFilter.has(line.name)),
  );

  // Tier 2 — score every candidate against the task; honor explicit hints. The scorer
  // (search.ts) stems and IDF-weights over name/aliases/description/metadata/BODY, so a fact
  // buried mid-note or worded differently ("deploying" vs "deploy") still surfaces. With no
  // query text but a filter, the filter IS the query: return the filtered set, freshest first.
  const stats = corpusStats(g.nodes.values());
  const hasText = q.text.trim() !== "";
  const seeds: ScoredNode[] = candidates
    .map((line): ScoredNode | null => {
      const node = g.nodes.get(line.name);
      if (!node) return null;
      if (!hasText) {
        if (!typeFilter && !nameFilter) return null;
        return { node, score: recency(node, now), via: "match", reason: "filter match" };
      }
      let s = scoreNode(q.text, node, stats);
      if (q.hint?.names?.includes(node.name)) s += 100;
      if (q.hint?.types?.includes(node.type)) s += 5;
      if (nameFilter?.has(node.name)) s += 100; // an explicitly named node is never ranked out
      if (s <= RELEVANCE_FLOOR) return null;
      s *= recency(node, now);
      if (node.stale) s *= 0.5; // deprioritize, don't drop (Spec 08 §1.5)
      return { node, score: s, via: "match", reason: "relevance match" };
    })
    .filter((x): x is ScoredNode => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Tier 3 — one-hop (configurable) link expansion (Spec 08 §3.2).
  const seen = new Set(seeds.map((s) => s.node.name));
  const expanded: ScoredNode[] = [];
  const phantomsSeen = new Set<string>();
  let frontier = seeds.map((s) => s.node.name);
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const name of frontier) {
      const outE = g.out.get(name) ?? [];
      const backE = (g.in.get(name) ?? []).filter((e) =>
        HIGH_VALUE_BACKLINK_FIELDS.has(e.field),
      );
      for (const e of [...outE, ...backE]) {
        // For an out-edge we hop to `to`; for a high-value backlink we hop to the linker `from`.
        const target = outE.includes(e) ? e.to : e.from;
        if (seen.has(target)) continue;
        seen.add(target);
        next.push(target);
        const node = g.nodes.get(target);
        if (!node) continue;
        if (node.phantom) phantomsSeen.add(node.name);
        expanded.push({
          node,
          score: edgeWeight(e),
          via: "link",
          reason: `linked ${outE.includes(e) ? "to" : "from"} ${name} via ${e.field}`,
        });
      }
    }
    frontier = next;
  }

  const notes: string[] = [];
  for (const x of [...seeds, ...expanded]) {
    if (x.node.stale) notes.push(`${x.node.name} is stale (ttl ${String(x.node.metadata.ttl)})`);
  }

  return {
    index: g.index,
    hits: seeds,
    expanded: expanded.sort((a, b) => b.score - a.score),
    phantoms: [...phantomsSeen],
    notes,
  };
}

/** Mild freshness multiplier: recently touched facts win ties, old ones aren't dropped. */
function recency(node: MemoryNode, now: number): number {
  const t = Date.parse(node.updated || node.created);
  if (!Number.isFinite(t)) return 1;
  const days = (now - t) / 86_400_000;
  return days <= RECENT_DAYS ? 1.15 : days <= 180 ? 1.05 : 1;
}

function edgeWeight(e: MemoryEdge): number {
  return e.field === "body" ? 2 : 5; // structural edges outrank incidental prose mentions
}

// =======================================================================================
// Dedup + content composition (Spec 08 §4.2 / §4.4)
// =======================================================================================

interface NodeContent {
  metadata: Record<string, unknown>;
  description: string;
  body: string;
}

/** Find a node that already covers this fact, to coerce create→update (Spec 08 §4.2). */
function findExisting(intent: RememberIntent, g: MemoryGraph): MemoryNode | null {
  // 1. Exact (non-phantom) name hit.
  const byName = g.nodes.get(intent.name);
  if (byName && !byName.phantom) return byName;

  // 2. Alias hit (slug-compared).
  const target = slug(intent.name);
  for (const n of g.nodes.values()) {
    if (n.phantom) continue;
    if (asStringArray(n.metadata.aliases).map(slug).includes(target)) return n;
  }

  // 3. A phantom with this name → fill it in (upgrade, not create).
  if (byName?.phantom) return byName;

  // 4. High-similarity description/name match of the SAME type → likely the same fact.
  //    Stemmed similarity (search.ts), so "deploying the docs" collides with "deploy docs".
  if (!intent.description) return null;
  let best: { node: MemoryNode; sim: number } | null = null;
  for (const n of g.nodes.values()) {
    if (n.phantom) continue;
    if (intent.type && n.type !== intent.type) continue;
    const sim = nodeSimilarity({ name: intent.name, description: intent.description }, n);
    if (!best || sim > best.sim) best = { node: n, sim };
  }
  return best && best.sim >= DEDUP_THRESHOLD ? best.node : null;
}

function buildNewContent(intent: RememberIntent): NodeContent {
  const now = nowIso();
  const metadata: Record<string, unknown> = { type: intent.type, ...(intent.metadata ?? {}) };
  metadata.created = metadata.created ?? now;
  metadata.updated = now;
  metadata.source = intent.source;
  return {
    metadata,
    description: (intent.description ?? "").trim(),
    body: (intent.body ?? "").trim(),
  };
}

function mergeInto(existing: MemoryNode, intent: RememberIntent): NodeContent {
  const now = nowIso();
  const metadata: Record<string, unknown> = { ...existing.metadata, ...(intent.metadata ?? {}) };
  metadata.type = intent.type ?? existing.metadata.type ?? existing.type;
  metadata.created = existing.metadata.created ?? now;
  metadata.updated = now;
  if (intent.source) metadata.source = intent.source;

  let body = existing.body.trim();
  if (intent.body != null) {
    body = intent.op === "append" ? `${body}\n\n${intent.body.trim()}`.trim() : intent.body.trim();
  }

  return {
    metadata,
    description: intent.description?.trim() ?? existing.description,
    body,
  };
}

/** Materialize `links` into the content so the next graph build re-extracts them (Spec 08 §2.2). */
function applyLinks(content: NodeContent, links?: RememberIntent["links"]): void {
  if (!links) return;
  for (const { to, field } of links) {
    if (!/^[a-z0-9-]+$/.test(to)) continue;
    const wl = `[[${to}]]`;
    if (STRUCTURAL_FIELDS.has(field)) {
      const arr = asStringArray(content.metadata[field]);
      if (!arr.some((x) => extractName(x) === to)) arr.push(wl);
      content.metadata[field] = arr;
    } else if (!content.body.includes(wl)) {
      content.body = `${content.body.trim()}\n\n${wl}`.trim();
    }
  }
}

// =======================================================================================
// Parse: file → node + edges (Spec 08 §2.2)
// =======================================================================================

/** Parse one memory markdown file into a node and its outgoing edges. */
export function parseMemoryFile(
  path: string,
  raw: string,
  mtime: number,
): { node: MemoryNode; edges: MemoryEdge[] } {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseYaml(frontmatter) as Record<string, unknown>;
  const meta = (fm.metadata ?? {}) as Record<string, unknown>;
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  const type = typeof meta.type === "string" ? meta.type : "";
  if (!name || !description || !type) {
    throw new Error(`missing required frontmatter (name/description/metadata.type) in ${path}`);
  }

  const cleanBody = stripGeneratedBacklinks(body).trim();
  const edges: MemoryEdge[] = [];
  const seen = new Set<string>();
  const add = (to: string, field: string, alias?: string) => {
    const key = `${field} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: name, to, field, alias });
  };

  // (a) structural edges from link-typed frontmatter fields (higher weight).
  for (const field of STRUCTURAL_FIELDS) {
    for (const v of asStringArray(meta[field])) {
      const m = matchWikilink(v);
      if (m) add(m.name, field, m.alias);
    }
  }
  // (b) prose edges from the body.
  for (const m of cleanBody.matchAll(WIKILINK)) {
    add(m[1]!, "body", m[2]);
  }

  const node: MemoryNode = {
    name,
    type,
    description,
    metadata: meta,
    body: cleanBody,
    path,
    created: String(meta.created ?? ""),
    updated: String(meta.updated ?? ""),
    source: (meta.source as MemoryNode["source"]) ?? "manual",
    confidence: meta.confidence as MemoryNode["confidence"],
    stale: isExpired(meta.ttl),
    phantom: false,
    mtime,
  };
  return { node, edges };
}

function phantomNode(name: string): MemoryNode {
  return {
    name,
    type: "reference",
    description: "",
    metadata: {},
    body: "",
    path: "",
    created: "",
    updated: "",
    source: "derived",
    stale: false,
    phantom: true,
    mtime: 0,
  };
}

// =======================================================================================
// Render: node → markdown + index + backlinks (Spec 08 §1, §4.5)
// =======================================================================================

/** Render a full memory file (frontmatter + body + generated backlinks). */
export function renderNode(node: MemoryNode, g: MemoryGraph): string {
  let fm = "---\n";
  fm += `name: ${node.name}\n`;
  fm += `description: >\n  ${node.description.replace(/\s+/g, " ").trim()}\n`;
  fm += "metadata:\n";
  for (const [key, value] of orderedMeta(node.metadata)) {
    fm += `  ${key}: ${serializeMeta(value)}\n`;
  }
  fm += "---\n";
  return fm + "\n" + composeBody(node.body.trim(), backlinkLines(g, node.name));
}

/** Append/replace the `## Backlinks` block onto a body (Spec 08 §1.4). */
function composeBody(body: string, links: string[]): string {
  const base = body.trim();
  if (links.length === 0) return base + "\n";
  const section = "## Backlinks\n" + links.map((l) => `- ${l}`).join("\n") + "\n";
  return (base ? base + "\n\n" : "") + section;
}

/** Inbound edges rendered as `[[from]] (field)` lines, deduped + stably sorted (Spec 08 §2.5). */
function backlinkLines(g: MemoryGraph, name: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of (g.in.get(name) ?? []).slice().sort((a, b) =>
    a.from === b.from ? a.field.localeCompare(b.field) : a.from.localeCompare(b.from),
  )) {
    const line = `[[${e.from}]] (${e.field})`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** Build the in-memory index (Spec 08 §1.7) from the real nodes — `MEMORY.md`'s source. */
function buildIndex(nodes: Map<string, MemoryNode>): IndexLine[] {
  const lines: IndexLine[] = [];
  for (const n of nodes.values()) {
    if (n.phantom) continue;
    lines.push({ name: n.name, type: n.type, description: n.description });
  }
  return lines.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : String(a.type).localeCompare(String(b.type)),
  );
}

/** Render `MEMORY.md` deterministically so a single-fact change is a single-line diff (§4.5). */
export function renderIndex(g: MemoryGraph): string {
  const realCount = [...g.nodes.values()].filter((n) => !n.phantom).length;
  let out = "# Beckett Memory Index\n";
  out += `<!-- GENERATED. Do not edit. Regenerated on every memory write. last: ${nowIso()}, ${realCount} nodes -->\n`;
  let lastType: string | null = null;
  for (const line of g.index) {
    if (line.type !== lastType) {
      out += `\n## ${line.type}\n`;
      lastType = String(line.type);
    }
    out += `- [[${line.name}]] — ${line.description}\n`;
  }
  return out;
}

function orderedMeta(metadata: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(metadata);
  const taken = new Set<string>();
  const result: [string, unknown][] = [];
  const take = (k: string) => {
    if (k in metadata && !taken.has(k)) {
      taken.add(k);
      result.push([k, metadata[k]]);
    }
  };
  for (const k of META_ORDER) take(k);
  for (const k of keys.filter((k) => !META_ORDER.includes(k) && !META_TAIL.includes(k)).sort()) {
    take(k);
  }
  for (const k of META_TAIL) take(k);
  return result;
}

// =======================================================================================
// YAML frontmatter parser (dependency-free; handles the Spec 08 §1.2 subset)
// =======================================================================================

/** Split a `---`-fenced frontmatter block from the markdown body. */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[1]!, body: text.slice(m[0].length) };
}

/** Return the exact `---...---` frontmatter header text (including fences) of a raw file. */
function frontmatterHead(raw: string): string {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? m[0].replace(/\r?\n?$/, "\n") : "";
}

/** Remove the generated `## Backlinks` section (to its next `## ` heading or EOF) — §1.4. */
export function stripGeneratedBacklinks(body: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Backlinks\s*$/i.test(l));
  if (start === -1) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+(?!Backlinks)/i.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

interface YamlLine {
  indent: number;
  text: string;
}

/** Parse a YAML frontmatter block into a plain object (maps, sequences, scalars, folded). */
export function parseYaml(block: string): Record<string, unknown> {
  const lines = block.split(/\r?\n/);
  const result = parseYamlMap(lines, 0, lines.length, -1).value;
  return (result ?? {}) as Record<string, unknown>;
}

function lineInfo(rawLine: string): YamlLine | null {
  if (rawLine.trim() === "") return null;
  const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
  return { indent, text: rawLine.slice(indent) };
}

/** Parse a mapping whose keys sit at `> parentIndent`, within [start, end). */
function parseYamlMap(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { value: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let i = start;
  let mapIndent = -1;

  while (i < end) {
    const info = lineInfo(lines[i]!);
    if (info === null) {
      i++;
      continue;
    }
    if (info.indent <= parentIndent) break;
    if (mapIndent === -1) mapIndent = info.indent;
    if (info.indent !== mapIndent) {
      // Should not happen for well-formed files; skip stray deeper lines defensively.
      i++;
      continue;
    }

    const content = stripInlineComment(info.text);
    const colon = findKeyColon(content);
    if (colon === -1) {
      i++;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    i++;

    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const folded = rest[0] === ">";
      const { value, next } = readBlockScalar(lines, i, end, mapIndent, folded);
      map[key] = value;
      i = next;
    } else if (rest === "") {
      // Nested map or sequence (or null if nothing deeper).
      const peek = nextMeaningful(lines, i, end);
      if (peek && peek.info.indent > mapIndent) {
        if (peek.info.text.startsWith("- ")) {
          const { value, next } = parseYamlSeq(lines, i, end, mapIndent);
          map[key] = value;
          i = next;
        } else {
          const { value, next } = parseYamlMap(lines, i, end, mapIndent);
          map[key] = value;
          i = next;
        }
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalarOrFlow(rest);
    }
  }

  return { value: map, next: i };
}

/** Parse a block sequence whose `- ` items sit at `> parentIndent`. */
function parseYamlSeq(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { value: unknown[]; next: number } {
  const seq: unknown[] = [];
  let i = start;
  let seqIndent = -1;
  while (i < end) {
    const info = lineInfo(lines[i]!);
    if (info === null) {
      i++;
      continue;
    }
    if (info.indent <= parentIndent) break;
    if (seqIndent === -1) seqIndent = info.indent;
    if (info.indent !== seqIndent || !info.text.startsWith("- ")) break;
    const item = stripInlineComment(info.text.slice(2)).trim();
    seq.push(parseScalarOrFlow(item));
    i++;
  }
  return { value: seq, next: i };
}

function nextMeaningful(
  lines: string[],
  start: number,
  end: number,
): { idx: number; info: YamlLine } | null {
  for (let i = start; i < end; i++) {
    const info = lineInfo(lines[i]!);
    if (info) return { idx: i, info };
  }
  return null;
}

/** Read a `>`/`|` block scalar: all lines indented deeper than the key's indent. */
function readBlockScalar(
  lines: string[],
  start: number,
  end: number,
  keyIndent: number,
  folded: boolean,
): { value: string; next: number } {
  const collected: string[] = [];
  let i = start;
  let blockIndent = -1;
  while (i < end) {
    const rawLine = lines[i]!;
    if (rawLine.trim() === "") {
      collected.push("");
      i++;
      continue;
    }
    const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
    if (indent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = indent;
    collected.push(rawLine.slice(Math.min(blockIndent, indent)));
    i++;
  }
  // Trim trailing blank lines.
  while (collected.length && collected[collected.length - 1] === "") collected.pop();
  const value = folded
    ? collected.map((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim()
    : collected.join("\n");
  return { value, next: i };
}

/** Find the `:` that separates a YAML key from its value (skips `::`/quotes/brackets). */
function findKeyColon(s: string): number {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"' && s[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && (i === s.length - 1 || s[i + 1] === " ")) return i;
  }
  return -1;
}

/** Strip a trailing ` # comment` that is not inside quotes/brackets. */
function stripInlineComment(line: string): string {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"' && line[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "#" && depth === 0 && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line;
}

function parseScalarOrFlow(s: string): unknown {
  const t = s.trim();
  if (t.startsWith("[")) return parseFlowSeq(t);
  if (t.startsWith("{")) return parseFlowMap(t);
  return parseScalar(t);
}

function parseFlowSeq(s: string): unknown[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return splitTopLevel(inner).map((x) => parseScalarOrFlow(x.trim()));
}

function parseFlowMap(s: string): Record<string, unknown> {
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  const obj: Record<string, unknown> = {};
  if (inner.trim() === "") return obj;
  for (const pair of splitTopLevel(inner)) {
    const colon = findKeyColon(pair);
    if (colon === -1) continue;
    obj[pair.slice(0, colon).trim()] = parseScalarOrFlow(pair.slice(colon + 1).trim());
  }
  return obj;
}

/** Split on top-level commas, honoring quotes and nested brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inS) {
      buf += c;
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      buf += c;
      if (c === '"' && s[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      buf += c;
    } else if (c === '"') {
      inD = true;
      buf += c;
    } else if (c === "[" || c === "{") {
      depth++;
      buf += c;
    } else if (c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

// =======================================================================================
// YAML serialization (deterministic, round-trippable through the parser above)
// =======================================================================================

function serializeMeta(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(serializeFlowItem).join(", ") + "]";
  return serializeMaybeQuoted(String(v));
}

function serializeFlowItem(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v)); // always quote strings inside flow arrays (safe)
}

function serializeMaybeQuoted(s: string): string {
  if (s === "") return '""';
  // Plain scalar is safe only for simple, comment/flow-free tokens (dates, slugs, paths, emails).
  const safe = /^[A-Za-z0-9][A-Za-z0-9 _.\-:/@+]*$/.test(s) && !/:\s/.test(s) && !/\s#/.test(s);
  return safe ? s : JSON.stringify(s);
}

// =======================================================================================
// Small utilities
// =======================================================================================

function matchWikilink(v: string): { name: string; alias?: string } | null {
  const m = v.match(/\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/);
  if (m) return { name: m[1]!, alias: m[2] };
  const bare = v.trim();
  if (/^[a-z0-9-]+$/.test(bare)) return { name: bare };
  return null;
}

function extractName(v: string): string {
  const m = matchWikilink(v);
  return m ? m.name : v.trim();
}

function pushEdge(map: Map<string, MemoryEdge[]>, key: string, e: MemoryEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(e);
  else map.set(key, [e]);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Coerce a metadata value into an array of strings (single value, array, or absent). */
function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

function isExpired(ttl: unknown): boolean {
  if (typeof ttl !== "string" || ttl.trim() === "") return false;
  const t = Date.parse(ttl);
  return Number.isFinite(t) && t < Date.now();
}

function nowIso(): string {
  return new Date().toISOString();
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
