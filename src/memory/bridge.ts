/**
 * Beckett — the cross-store memory bridge (`src/memory/bridge.ts`, issue #160)
 * =======================================================================================
 * Beckett's memory lives in TWO stores that historically could not see each other (the
 * harness note `memory-is-two-stores` documents the split, and its "phantom list is mostly
 * cross-store links" observation is exactly what this module fixes):
 *
 *   1. **The graph store** (`config.memory_dir`, ~/.beckett/memory) — the markdown knowledge
 *      graph behind `memory.recall` / `memory.remember` and the recall/remember skills.
 *      AUTHORITATIVE for durable cross-task facts: people, projects, preferences, the
 *      environment, decisions — everything `remember()` writes.
 *   2. **The harness auto-memory** (`~/.claude/projects/<project-slug>/memory/`) — the flat
 *      per-project store the Claude Code harness seat maintains itself (hand-edited files, a
 *      hand-maintained `MEMORY.md` index injected into every harness session). AUTHORITATIVE
 *      for seat-operational lessons: how the harness behaves, workflow corrections, gotchas
 *      learned while coding/concierging.
 *
 * The bridge is READ-side federation in one direction and a GENERATED index in the other —
 * neither store's write path ever writes the other's facts:
 *
 *   - **harness → graph**: `MemoryStore.buildGraph` (when built with `bridgeDirs`) folds the
 *     harness files in as read-only "bridged" nodes ({@link loadBridgedNodes}). They rank in
 *     recall like any node, resolve the graph's cross-store `[[wikilinks]]` (no more phantom
 *     noise), and surface via one-hop expansion — but every graph WRITE path (remember dedup,
 *     maintenance archive/merge, backlink refresh) treats them as untouchable: the graph
 *     never edits, merges, archives, or rewrites a harness file. Byte-guarantee, tested.
 *     Bridged nodes default to `visibility: owner` (fail-closed — harness notes were written
 *     for Beckett's own seat, not for arbitrary guild viewers).
 *   - **graph → harness**: after every graph write, {@link syncBridgeDirs} regenerates ONE
 *     file per harness dir — `beckett-graph-index.md`, the graph's public index in harness
 *     conventions — and makes sure the harness `MEMORY.md` carries a one-line pointer to it.
 *     Those two derived touches are the ONLY writes the graph ever makes under a harness
 *     root; the harness seat finds a graph fact by grepping the bridged index, then reads it
 *     in full with `beckett memory show <name>` / `beckett recall "<query>" --as-self`.
 *
 * Wiring: the memory extension resolves the dirs via {@link resolveBridgeDirs} (env
 * `BECKETT_HARNESS_MEMORY_DIRS`, else the harness project dir derived from the daemon's cwd).
 * `createMemory` without `bridgeDirs` is byte-identical to the pre-bridge behavior — tests
 * and any embedded store stay unbridged unless they opt in.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger, MemoryEdge, MemoryGraph, MemoryNode } from "../types.ts";
import { parseMemoryFile, splitFrontmatter } from "./index.ts";
import { isInferenceNode, provenanceOf, VisibilitySchema } from "./search.ts";
import { indexAgeFlag } from "./freshness.ts";

/** The one file the graph generates inside a harness memory dir (direction graph → harness). */
export const BRIDGE_INDEX_BASENAME = "beckett-graph-index.md";

/** Metadata marker stamped on every harness-origin node folded into the graph. */
export const HARNESS_ORIGIN = "harness";

/** Is this node a read-only import from the harness auto-memory store? */
export function isBridgedNode(node: Pick<MemoryNode, "metadata">): boolean {
  return node.metadata?.origin_store === HARNESS_ORIGIN;
}

/**
 * Resolve which harness auto-memory dirs to bridge. Precedence:
 *   1. env `BECKETT_HARNESS_MEMORY_DIRS` — colon-separated absolute paths; set-but-empty
 *      explicitly disables the bridge.
 *   2. the Claude Code project dir derived from `cwd` (the daemon's working directory IS the
 *      checkout its harness seat runs in): `~/.claude/projects/<slug(cwd)>/memory`, where the
 *      slug is the harness's own path mangling (every non-alphanumeric byte → `-`).
 * Only dirs that actually exist are returned — the bridge never creates a harness store.
 */
export function resolveBridgeDirs(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string[] {
  const raw = env.BECKETT_HARNESS_MEMORY_DIRS;
  const dirs =
    raw !== undefined
      ? raw.split(":").map((s) => s.trim()).filter(Boolean)
      : [join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory")];
  return dirs.filter((d) => existsSync(d));
}

/** Flat `*.md` listing of the harness dirs — the store is flat by convention, and a flat scan
 *  also keeps its `.moss/` cache and any stray subdirs out. `MEMORY.md` (the hand-maintained
 *  index) and the generated bridge index are never imported (the latter would round-trip the
 *  graph's own facts back into itself). */
export function listBridgeFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith(".md") || e === "MEMORY.md" || e === BRIDGE_INDEX_BASENAME) continue;
      out.push(join(dir, e));
    }
  }
  return out.sort();
}

/**
 * Parse every harness file into a read-only graph node. Conforming files (the harness
 * convention shares the graph's frontmatter shape: `name`, `description`, `metadata.type`) go
 * through the graph's own {@link parseMemoryFile}, wikilinks and all; a file that fails that
 * parse degrades to a lenient, edge-free node (name from the filename, description from its
 * first prose line) — a hand-written harness note is still findable, never silently dropped.
 *
 * Every node is stamped on the way in:
 *   - `metadata.origin_store = "harness"` — the read-only marker every write path checks;
 *   - `source: "import"`;
 *   - `visibility` defaults to `owner` unless the file EXPLICITLY carries a valid value
 *     (fail-closed: harness notes are Beckett's seat notes, not public statements);
 *   - `updated` falls back to `metadata.modified`, then the file mtime, so recall's recency
 *     shaping sees a real date.
 */
export function loadBridgedNodes(
  dirs: string[],
  logger?: Logger,
): { node: MemoryNode; edges: MemoryEdge[] }[] {
  const out: { node: MemoryNode; edges: MemoryEdge[] }[] = [];
  for (const path of listBridgeFiles(dirs)) {
    let raw: string;
    let mtime: number;
    try {
      raw = readFileSync(path, "utf8");
      mtime = statMtime(path);
    } catch (err) {
      logger?.warn("memory bridge: unreadable harness file skipped", { path, err: String(err) });
      continue;
    }
    let parsed: { node: MemoryNode; edges: MemoryEdge[] };
    try {
      parsed = parseMemoryFile(path, raw, mtime);
    } catch {
      const lenient = lenientNode(path, raw, mtime);
      if (!lenient) {
        logger?.warn("memory bridge: unparseable harness file skipped", { path });
        continue;
      }
      parsed = { node: lenient, edges: [] };
    }
    out.push({ node: adaptBridgedNode(parsed.node, mtime), edges: parsed.edges });
  }
  return out;
}

/** Stamp a parsed harness node with the bridge markers (see {@link loadBridgedNodes}). */
function adaptBridgedNode(node: MemoryNode, mtime: number): MemoryNode {
  const metadata: Record<string, unknown> = { ...node.metadata, origin_store: HARNESS_ORIGIN };
  if (!VisibilitySchema.safeParse(metadata.visibility).success) metadata.visibility = "owner";
  const updated =
    node.updated ||
    (typeof metadata.modified === "string" ? metadata.modified : "") ||
    new Date(mtime).toISOString();
  return { ...node, metadata, updated, source: "import" };
}

/** The lenient fallback for a harness file the strict parser refuses (missing/odd
 *  frontmatter). Name from the filename, description from the first prose line. */
function lenientNode(path: string, raw: string, mtime: number): MemoryNode | null {
  const name = basename(path, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) return null;
  const { body } = splitFrontmatter(raw);
  const firstLine =
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*>]|#{1,6}|\d+[.)])\s+/, "").trim())
      .find((l) => l.length > 0) ?? name;
  return {
    name,
    type: "reference",
    description: firstLine.slice(0, 200),
    metadata: { type: "reference" },
    body: body.trim(),
    path,
    created: "",
    updated: "",
    source: "import",
    stale: false,
    phantom: false,
    mtime,
  };
}

/**
 * Render the graph's PUBLIC index as a harness-convention memory file (direction
 * graph → harness). Public-only mirrors the graph's own `MEMORY.md` leak rule — the harness
 * `MEMORY.md` (and files it points at) reach every harness session, so a scoped fact's name +
 * description landing here would bypass recall's fail-closed audience gate. Bridged nodes are
 * excluded (they ARE the harness's facts — echoing them back would be circular). Deliberately
 * timestamp-free so an unchanged graph renders byte-identical output and the sync can skip
 * the write (no mtime churn in the harness dir).
 */
export function renderBridgeIndex(g: MemoryGraph): string {
  const lines = g.index.filter((line) => {
    const node = g.nodes.get(line.name);
    return node
      ? !isBridgedNode(node) && provenanceOf(node).visibility === "public"
      : false;
  });
  const now = Date.now();
  let out = "---\n";
  out += "name: beckett-graph-index\n";
  out +=
    "description: >\n  GENERATED cross-store bridge — the public index of the beckett graph memory" +
    " (memory.recall/memory.remember). Full fact: `beckett memory show <name>`; search:" +
    " `beckett recall \"<query>\" --as-self`.\n";
  out += "metadata:\n  type: reference\n  origin_store: graph\n";
  out += "---\n\n";
  out += "<!-- GENERATED by beckett (src/memory/bridge.ts) on every graph memory write. Do not edit. -->\n\n";
  out +=
    "The beckett graph store (`~/.beckett/memory`, behind `memory.recall`/`memory.remember` and the\n" +
    "recall/remember skills) is AUTHORITATIVE for durable cross-task facts — people, projects,\n" +
    "preferences, environment, decisions. This store (the harness auto-memory) stays authoritative\n" +
    "for seat-operational lessons. Public graph facts are indexed below so they are findable from\n" +
    "this seat; owner-/dm-scoped graph facts are deliberately NOT listed — query those with\n" +
    '`beckett recall "<query>" --as-self`. Read any fact in full with `beckett memory show <name>`.\n';
  let lastType: string | null = null;
  for (const line of lines) {
    if (line.type !== lastType) {
      out += `\n## ${line.type}\n`;
      lastType = String(line.type);
    }
    const node = g.nodes.get(line.name);
    const inference = node && isInferenceNode(node) ? "[inference] " : "";
    out += `- ${line.name} — ${inference}${line.description}${indexAgeFlag(line.updated, now)}\n`;
  }
  return out;
}

/** The one-line pointer {@link syncBridgeDirs} keeps in the harness `MEMORY.md` index. */
const POINTER_LINE =
  `- [beckett graph memory (bridge)](${BRIDGE_INDEX_BASENAME}) — GENERATED index of the graph ` +
  "store (memory.recall/remember); full facts via `beckett memory show <name>` / `beckett recall`";

/**
 * Publish the graph's public index into each harness auto-memory dir and make sure the
 * harness `MEMORY.md` points at it. Best-effort by contract: a missing dir is skipped, any
 * error is logged and swallowed — the bridge must never fail a graph write. These are the
 * ONLY writes the graph ever makes under a harness root, and both are derived state:
 *   - `beckett-graph-index.md` is rewritten atomically, only when its content changed;
 *   - `MEMORY.md` gets the pointer line appended once (never rewritten if already present;
 *     created with just that line when the dir exists but has no index yet).
 */
export function syncBridgeDirs(g: MemoryGraph, dirs: string[], logger?: Logger): void {
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const indexPath = join(dir, BRIDGE_INDEX_BASENAME);
      const content = renderBridgeIndex(g);
      if (readIfExists(indexPath) !== content) atomicWrite(indexPath, content);

      const memoryMd = join(dir, "MEMORY.md");
      const existing = readIfExists(memoryMd);
      if (existing === null) {
        atomicWrite(memoryMd, POINTER_LINE + "\n");
      } else if (!existing.includes(BRIDGE_INDEX_BASENAME)) {
        atomicWrite(memoryMd, existing.replace(/\n?$/, "\n") + POINTER_LINE + "\n");
      }
    } catch (err) {
      logger?.warn("memory bridge: could not sync harness dir", { dir, err: String(err) });
    }
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Same tmp+rename atomic write discipline as the store's own (Spec 08 §8.1). */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
