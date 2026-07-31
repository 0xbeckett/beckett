/**
 * Cross-store memory bridge tests (issue #160, ./bridge.ts).
 * Pins the whole bridge contract:
 *   - harness → graph: harness auto-memory files fold in as READ-ONLY nodes — recallable by
 *     Beckett's own audience, fail-closed to the public, resolving cross-store [[wikilinks]]
 *     that used to be phantom noise;
 *   - write immunity: no remember / maintain / merge / backlink pass ever changes a byte
 *     under a harness root, and the graph's own MEMORY.md never lists a bridged node;
 *   - graph → harness: every graph write publishes `beckett-graph-index.md` (public natives
 *     only) into each harness dir plus a one-line MEMORY.md pointer, idempotently;
 *   - no bridgeDirs ⇒ byte-identical pre-bridge behavior (covered by the rest of the suite).
 */

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, renderIndex, type MemoryStore } from "./index.ts";
import {
  BRIDGE_INDEX_BASENAME,
  isBridgedNode,
  listBridgeFiles,
  loadBridgedNodes,
  resolveBridgeDirs,
} from "./bridge.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A graph store bridged to a fresh fake harness auto-memory dir. */
function bridgedStore(): { store: MemoryStore; dir: string; harnessDir: string } {
  const dir = tempDir("beckett-memory-");
  const harnessDir = tempDir("beckett-harness-");
  const store = createMemory({ memoryDir: dir, logger: quietLog, git: false, bridgeDirs: [harnessDir] });
  return { store, dir, harnessDir };
}

/** Write a harness-convention memory file (the shape the Claude Code seat maintains). */
function writeHarnessNote(
  harnessDir: string,
  name: string,
  description: string,
  body: string,
  extraMeta = "",
): string {
  const path = join(harnessDir, `${name}.md`);
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: reference\n${extraMeta}---\n\n${body}\n`,
  );
  return path;
}

// ── harness → graph: findability ─────────────────────────────────────────────────────────

test("a fact learned in the harness seat is recallable from the graph seat", async () => {
  const { store, harnessDir } = bridgedStore();
  writeHarnessNote(
    harnessDir,
    "courier-lockfile-conflict",
    "courier rebases die on bun.lock conflicts; regenerate the lockfile",
    "When couriering a branch, a bun.lock conflict means regenerate, never hand-merge.",
  );

  const r = await store.recall({ text: "lockfile conflict when couriering", audience: SELF_AUDIENCE });
  const hit = r.hits.find((h) => h.node.name === "courier-lockfile-conflict");
  expect(hit).toBeDefined();
  expect(isBridgedNode(hit!.node)).toBe(true);
  expect(hit!.node.source).toBe("import");
});

test("bridged nodes are owner-scoped by default: invisible to a public (no-audience) recall", async () => {
  const { store, harnessDir } = bridgedStore();
  writeHarnessNote(harnessDir, "seat-note", "a seat-operational lesson", "Only for my own seat.");

  const asPublic = await store.recall({ text: "seat-operational lesson" });
  expect(asPublic.hits.some((h) => h.node.name === "seat-note")).toBe(false);
  expect(asPublic.index.some((l) => l.name === "seat-note")).toBe(false);

  const asSelf = await store.recall({ text: "seat-operational lesson", audience: SELF_AUDIENCE });
  expect(asSelf.hits.some((h) => h.node.name === "seat-note")).toBe(true);
});

test("a graph [[link]] to a harness slug resolves to the bridged node — no phantom, expansion follows it", async () => {
  const { store, harnessDir } = bridgedStore();
  writeHarnessNote(harnessDir, "claude-model-casting", "how to cast claude models", "Sonnet med/high.");
  await store.remember({
    op: "create",
    name: "casting-doctrine",
    type: "decision",
    description: "worker casting rules",
    body: "Casting follows [[claude-model-casting]].",
    source: "manual",
    reason: "test",
  });

  // The cross-store link is a real edge now: maintain no longer reports it as a phantom…
  const report = await store.maintain({ dryRun: true });
  expect(report.phantoms).not.toContain("claude-model-casting");

  // …and recall's one-hop expansion surfaces the harness fact from the graph seed.
  const r = await store.recall({ text: "worker casting rules", audience: SELF_AUDIENCE });
  const names = [...r.hits, ...r.expanded].map((x) => x.node.name);
  expect(names).toContain("claude-model-casting");
});

test("a harness file that fails the strict parse degrades leniently instead of vanishing", async () => {
  const { store, harnessDir } = bridgedStore();
  // No frontmatter at all — the strict parser refuses this.
  writeFileSync(join(harnessDir, "Hand Written.md"), "The metrics dashboard needs HOME set.\n");

  const r = await store.recall({ text: "metrics dashboard HOME", audience: SELF_AUDIENCE });
  const hit = r.hits.find((h) => h.node.name === "hand-written");
  expect(hit).toBeDefined();
  expect(hit!.node.description).toContain("metrics dashboard");
});

// ── write immunity: the graph never touches a harness byte ───────────────────────────────

test("remember reusing a bridged name creates a NATIVE node and leaves the harness file untouched", async () => {
  const { store, dir, harnessDir } = bridgedStore();
  const path = writeHarnessNote(harnessDir, "deploy-recipe", "old harness deploy recipe", "Old body.");
  const before = readFileSync(path, "utf8");

  await store.remember({
    op: "update",
    name: "deploy-recipe",
    type: "env",
    description: "the graph's own deploy recipe",
    body: "New graph-side body.",
    source: "manual",
    reason: "test",
  });

  expect(readFileSync(path, "utf8")).toBe(before);
  // The native node landed under the graph root and wins the name in the graph.
  expect(existsSync(join(dir, "env", "deploy-recipe.md"))).toBe(true);
  const node = store.buildGraph().nodes.get("deploy-recipe")!;
  expect(isBridgedNode(node)).toBe(false);
  expect(node.description).toBe("the graph's own deploy recipe");
});

test("maintain never archives, merges, or rewrites bridged files — cross-store dups demote to flags", async () => {
  const { store, harnessDir } = bridgedStore();
  // A ttl-expired harness note (would be archived if it were native)…
  const expired = writeHarnessNote(
    harnessDir,
    "expired-note",
    "an old harness note",
    "Body.",
    '  ttl: "2001-01-01T00:00:00.000Z"\n',
  );
  // …and a harness note that is a near-duplicate of a native node, linking to it too.
  const dupPath = writeHarnessNote(
    harnessDir,
    "tunnel-token-location",
    "the cloudflared tunnel token lives in the cloudflared config",
    "See [[tunnel-token]].",
  );
  // Same type + same effective visibility as the bridged node (reference/owner) — the only
  // shape planMaintenance would actually merge, so the demotion below is the real guard.
  await store.remember({
    op: "create",
    name: "tunnel-token",
    type: "reference",
    description: "the cloudflared tunnel token lives in the cloudflared config",
    metadata: { visibility: "owner" },
    source: "manual",
    reason: "test",
  });
  const beforeExpired = readFileSync(expired, "utf8");
  const beforeDup = readFileSync(dupPath, "utf8");

  const report = await store.maintain({});
  expect(report.archives.map((a) => a.name)).not.toContain("expired-note");
  expect(report.merges).toHaveLength(0);
  const flaggedPairs = report.flagged.map((f) => [f.a, f.b].sort().join("+"));
  expect(flaggedPairs).toContain("tunnel-token+tunnel-token-location");

  expect(readFileSync(expired, "utf8")).toBe(beforeExpired);
  expect(readFileSync(dupPath, "utf8")).toBe(beforeDup);
  // Both harness files are still there — nothing moved to archive/.
  expect(listBridgeFiles([harnessDir])).toHaveLength(2);
});

test("the graph's own MEMORY.md never lists bridged nodes", async () => {
  const { store, dir, harnessDir } = bridgedStore();
  // Even an explicitly public harness note stays out of the graph's index file.
  writeHarnessNote(harnessDir, "public-harness-note", "a public harness note", "Body.", "  visibility: public\n");
  await store.remember({
    op: "create",
    name: "native-fact",
    type: "reference",
    description: "a native public fact",
    source: "manual",
    reason: "test",
  });

  const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(index).toContain("native-fact");
  expect(index).not.toContain("public-harness-note");
  // …but the public bridged node IS recallable without an audience (it opted into public).
  const r = await store.recall({ text: "public harness note" });
  expect(r.hits.some((h) => h.node.name === "public-harness-note")).toBe(true);
});

// ── graph → harness: the published index ─────────────────────────────────────────────────

test("a graph write publishes the public index into the harness dir with a MEMORY.md pointer", async () => {
  const { store, harnessDir } = bridgedStore();
  writeFileSync(join(harnessDir, "MEMORY.md"), "- [existing](existing.md) — a hand line\n");
  writeHarnessNote(harnessDir, "seat-note", "a seat note", "Body.");

  await store.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "Primary user and owner",
    source: "manual",
    reason: "test",
  });
  await store.remember({
    op: "create",
    name: "secret-fact",
    type: "reference",
    description: "owner-scoped fact",
    metadata: { visibility: "owner" },
    source: "manual",
    reason: "test",
  });

  const bridgeIndex = readFileSync(join(harnessDir, BRIDGE_INDEX_BASENAME), "utf8");
  // Public native facts are listed; scoped natives and the harness's own notes are not.
  expect(bridgeIndex).toContain("jason — Primary user and owner");
  expect(bridgeIndex).not.toContain("secret-fact");
  expect(bridgeIndex).not.toContain("seat-note");
  // The file explains the authority split and how to query the full store.
  expect(bridgeIndex).toContain("beckett recall");
  expect(bridgeIndex).toContain("AUTHORITATIVE");

  // The hand-maintained MEMORY.md kept its content and gained exactly one pointer line.
  const memoryMd = readFileSync(join(harnessDir, "MEMORY.md"), "utf8");
  expect(memoryMd).toContain("a hand line");
  expect(memoryMd.split(BRIDGE_INDEX_BASENAME).length - 1).toBe(1); // exactly one pointer

  // Idempotent: another write adds no second pointer.
  await store.remember({
    op: "append",
    name: "jason",
    type: "person",
    body: "Still the owner.",
    source: "manual",
    reason: "test",
  });
  const again = readFileSync(join(harnessDir, "MEMORY.md"), "utf8");
  expect(again).toBe(memoryMd);
});

test("the bridge index is never re-imported into the graph, and a missing harness dir is a no-op", async () => {
  const { store, harnessDir } = bridgedStore();
  await store.remember({
    op: "create",
    name: "native-fact",
    type: "reference",
    description: "a native fact",
    source: "manual",
    reason: "test",
  });
  // The published index exists in the harness dir but never becomes a graph node.
  expect(existsSync(join(harnessDir, BRIDGE_INDEX_BASENAME))).toBe(true);
  expect(store.buildGraph().nodes.has("beckett-graph-index")).toBe(false);

  // A store bridged to a dir that doesn't exist: reads and writes still work, nothing created.
  const ghost = join(tempDir("beckett-ghost-"), "nope", "memory");
  const dir2 = tempDir("beckett-memory-");
  const store2 = createMemory({ memoryDir: dir2, logger: quietLog, git: false, bridgeDirs: [ghost] });
  await store2.remember({
    op: "create",
    name: "x",
    type: "reference",
    description: "y",
    source: "manual",
    reason: "test",
  });
  expect(existsSync(ghost)).toBe(false);
});

test("an out-of-band harness edit reaches the next recall of a WARM store (stamp includes bridge files)", async () => {
  const dir = tempDir("beckett-memory-");
  const harnessDir = tempDir("beckett-harness-");
  const store = createMemory({
    memoryDir: dir,
    logger: quietLog,
    git: false,
    warm: true,
    bridgeDirs: [harnessDir],
  });
  await store.recall({ text: "warm-up", audience: SELF_AUDIENCE }); // builds + caches the graph

  const path = writeHarnessNote(harnessDir, "fresh-note", "a brand new harness fact", "Body.");
  // Nudge mtime so the metadata stamp definitely changes even on coarse filesystems.
  utimesSync(path, new Date(Date.now() + 2000), new Date(Date.now() + 2000));

  const r = await store.recall({ text: "brand new harness fact", audience: SELF_AUDIENCE });
  expect(r.hits.some((h) => h.node.name === "fresh-note")).toBe(true);
});

// ── resolveBridgeDirs ────────────────────────────────────────────────────────────────────

test("resolveBridgeDirs: env override wins, empty env disables, default derives the harness project slug", () => {
  const harnessDir = tempDir("beckett-harness-");
  expect(resolveBridgeDirs({ BECKETT_HARNESS_MEMORY_DIRS: harnessDir }, "/anywhere", "/nohome")).toEqual([harnessDir]);
  expect(resolveBridgeDirs({ BECKETT_HARNESS_MEMORY_DIRS: "" }, "/anywhere", "/nohome")).toEqual([]);

  // Default: <home>/.claude/projects/<slug(cwd)>/memory, returned only when it exists.
  const home = tempDir("beckett-home-");
  const cwd = "/home/beckett/beckett";
  const expected = join(home, ".claude", "projects", "-home-beckett-beckett", "memory");
  expect(resolveBridgeDirs({}, cwd, home)).toEqual([]);
  mkdirSync(expected, { recursive: true });
  expect(resolveBridgeDirs({}, cwd, home)).toEqual([expected]);
});

test("loadBridgedNodes maps harness `modified` metadata onto `updated` so recency shaping works", () => {
  const harnessDir = tempDir("beckett-harness-");
  writeHarnessNote(harnessDir, "dated-note", "a dated note", "Body.", '  modified: "2026-07-30T03:50:48.289Z"\n');
  const [entry] = loadBridgedNodes([harnessDir], quietLog);
  expect(entry!.node.updated).toBe("2026-07-30T03:50:48.289Z");
  expect(entry!.node.metadata.visibility).toBe("owner");
});

// ── renderIndex purity (regression guard for the shared exported renderer) ───────────────

test("renderIndex over a bridged graph equals renderIndex over the same natives unbridged", async () => {
  const { store, harnessDir } = bridgedStore();
  writeHarnessNote(harnessDir, "noise", "harness noise", "Body.");
  await store.remember({
    op: "create",
    name: "native-fact",
    type: "reference",
    description: "a native fact",
    source: "manual",
    reason: "test",
  });
  const bridgedRender = renderIndex(store.buildGraph()).replace(/last: [^,]*/, "");

  const dir2 = tempDir("beckett-memory-");
  const plain = createMemory({ memoryDir: dir2, logger: quietLog, git: false });
  await plain.remember({
    op: "create",
    name: "native-fact",
    type: "reference",
    description: "a native fact",
    source: "manual",
    reason: "test",
  });
  const plainRender = renderIndex(plain.buildGraph()).replace(/last: [^,]*/, "");
  expect(bridgedRender).toBe(plainRender);
});
