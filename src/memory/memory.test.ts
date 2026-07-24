/**
 * Memory subsystem tests (OPS-121 "better memory").
 * Pins: recall across wordings (stemming + full-body scan), targeted --type/--name filters,
 * cross-session retrieval (a fresh store instance sees what another wrote), write-time dedup,
 * and the maintenance pass (TTL/supersede archiving, duplicate merge, flag band, dry-run) —
 * all with the no-data-loss guarantee (archive, never delete).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, recallOver, type MemoryStore } from "./index.ts";
import { stem, scoreNode, nodeSimilarity } from "./search.ts";
import { planMaintenance, startRoutineMaintenance, TTL_GRACE_MS } from "./maintain.ts";
import type { Logger, MemoryNode } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-memory-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

async function seedWorld(store: MemoryStore): Promise<void> {
  await store.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "Primary user and owner — talks casual lowercase",
    body: "GitHub frgmt0. Works from [[loom-desk]].",
    source: "manual",
    reason: "test seed",
  });
  await store.remember({
    op: "create",
    name: "loom-desk",
    type: "env",
    description: "Ubuntu host where beckett runs",
    body: "Projects live under ~/Projects. The cloudflared tunnel token lives in ~/.cloudflared/config.yml.",
    source: "manual",
    reason: "test seed",
  });
  await store.remember({
    op: "create",
    name: "docs-site",
    type: "project",
    description: "Deploy the docs site to Cloudflare Pages",
    source: "manual",
    reason: "test seed",
  });
}

// ── stemming + scoring primitives ────────────────────────────────────────────────────────

test("stem collapses plural/-ed/-ing/-e variants onto one form", () => {
  expect(stem("deployed")).toBe(stem("deploy"));
  expect(stem("deploying")).toBe(stem("deploys"));
  expect(stem("released")).toBe(stem("release"));
  expect(stem("memories")).toBe(stem("memory"));
  expect(stem("running")).toBe("run");
});

test("scoreNode matches a fact buried in the body, not just the description", () => {
  const node = {
    name: "loom-desk",
    type: "env",
    description: "Ubuntu host where beckett runs",
    metadata: {},
    body: "The cloudflared tunnel token lives in ~/.cloudflared/config.yml.",
  } as unknown as MemoryNode;
  expect(scoreNode("cloudflared token", node)).toBeGreaterThan(0);
  expect(scoreNode("kubernetes cluster", node)).toBe(0);
});

// ── recall: wording variance + targeted filters + cross-session ─────────────────────────

test("recall surfaces the right node when the query wording differs from the stored fact", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "how are we deploying the documentation site?" });
  expect(r.hits.length).toBeGreaterThan(0);
  expect(r.hits[0]!.node.name).toBe("docs-site"); // "deploying" → "deploy", "site" exact
});

test("recall finds body-only facts (full-node scan, not just the index line)", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "where is the cloudflared tunnel token" });
  expect(r.hits.map((h) => h.node.name)).toContain("loom-desk");
});

test("recall --type is a hard filter; empty query with a filter lists the filtered set", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const typed = await store.recall({ text: "", filter: { types: ["person"] } });
  expect(typed.hits.map((h) => h.node.name)).toEqual(["jason"]);
  const scored = await store.recall({ text: "deploy the site", filter: { types: ["project"] } });
  expect(scored.hits.every((h) => h.node.type === "project")).toBe(true);
});

test("recall --name always returns the named node, even if the query text is unrelated", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "completely unrelated words", filter: { names: ["jason"] } });
  expect(r.hits.map((h) => h.node.name)).toEqual(["jason"]);
});

test("cross-session: a FRESH store instance over the same dir sees earlier writes", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  const secondSession = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await secondSession.recall({ text: "who is the owner jason" });
  expect(r.hits[0]!.node.name).toBe("jason");
  expect(r.index.length).toBe(3); // the always-loaded global index is complete
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("[[jason]]");
});

// ── remember: write-time dedup ────────────────────────────────────────────────────────────

test("remember coerces a reworded duplicate create into an update of the existing node", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "marketing-team",
    type: "person",
    description: "The marketing team at Acme handles all campaign work",
    source: "manual",
    reason: "seed",
  });
  const node = await store.remember({
    op: "create",
    name: "the-marketing-team",
    type: "person",
    description: "Marketing team at Acme handling the campaign work",
    source: "manual",
    reason: "dup attempt",
  });
  expect(node.name).toBe("marketing-team"); // updated, not duplicated
  const g = store.buildGraph();
  expect(g.nodes.has("the-marketing-team")).toBe(false);
});

test("remember rejects a description-less create instead of orphaning an unparseable file", async () => {
  const { store, dir } = tempStore();
  await expect(
    store.remember({ op: "create", name: "no-desc", type: "reference", source: "manual", reason: "seed" }),
  ).rejects.toThrow(/description/);
  const files = readdirSync(dir, { recursive: true }) as string[];
  expect(files.some((f) => String(f).includes("no-desc"))).toBe(false); // nothing landed on disk
});

// ── maintenance: staleness, supersede, dedup merge, dry-run, no data loss ────────────────

test("maintain archives a node whose ttl expired past the grace window (file preserved)", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  await store.remember({
    op: "create",
    name: "beta-freeze",
    type: "decision",
    description: "Feature freeze for the beta until launch",
    metadata: { ttl: new Date(Date.now() - TTL_GRACE_MS - 86_400_000).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives.map((a) => a.name)).toEqual(["beta-freeze"]);
  const g = store.buildGraph();
  expect(g.nodes.has("beta-freeze")).toBe(false); // out of the graph…
  const archived = readdirSync(join(dir, "archive"));
  expect(archived.some((f) => f.startsWith("beta-freeze"))).toBe(true); // …but never deleted
  const raw = readFileSync(join(dir, "archive", archived.find((f) => f.startsWith("beta-freeze"))!), "utf8");
  expect(raw).toContain("Feature freeze");
  expect(raw).toContain("archived_reason: expired-ttl");
});

test("maintain keeps a node whose ttl expired but is still inside the grace window", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "fresh-expiry",
    type: "decision",
    description: "Recently expired decision still in grace",
    metadata: { ttl: new Date(Date.now() - 3_600_000).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives).toEqual([]);
  expect(store.buildGraph().nodes.get("fresh-expiry")?.stale).toBe(true); // deprioritized, not dropped
});

test("recall notices a ttl that expired AFTER the graph was built (warm daemon)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "expiring-freeze",
    type: "decision",
    description: "Temporary feature freeze decision",
    metadata: { ttl: new Date(Date.now() + 50).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const g = store.buildGraph();
  expect(g.nodes.get("expiring-freeze")!.stale).toBe(false); // not yet expired at parse time
  await new Promise((r) => setTimeout(r, 120)); // ttl lapses while the graph sits cached
  const r = recallOver({ text: "temporary feature freeze decision" }, g);
  expect(r.notes.some((n) => n.startsWith("expiring-freeze is stale"))).toBe(true);
});

test("maintain archives a superseded decision", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "old-plan",
    type: "decision",
    description: "Ship the site from the tunnel host",
    source: "manual",
    reason: "seed",
  });
  await store.remember({
    op: "create",
    name: "new-plan",
    type: "decision",
    description: "Ship the site from Cloudflare Pages edge",
    links: [{ to: "old-plan", field: "supersedes" }],
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives).toEqual([
    { name: "old-plan", reason: "superseded", by: "new-plan", detail: "superseded by new-plan" },
  ]);
  const g = store.buildGraph();
  expect(g.nodes.has("new-plan")).toBe(true);
  expect(g.nodes.get("old-plan")?.phantom ?? true).toBe(true); // only the dangling ref remains
});

test("maintain merges near-identical nodes: content kept, alias added, inbound links rewritten", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create",
    name: "site-deploy",
    type: "project",
    description: "Deploy the docs site to Cloudflare Pages",
    metadata: { created: "2026-01-01T00:00:00.000Z" },
    body: "Canonical body.",
    source: "manual",
    reason: "seed",
  });
  // Bypass write-time dedup deliberately (as if written by an older Beckett) by writing the
  // near-duplicate with a disjoint description first, then editing the file on disk.
  await store.remember({
    op: "create",
    name: "site-deploying",
    type: "project",
    description: "zzz placeholder wording completely different",
    metadata: { created: "2026-02-01T00:00:00.000Z" },
    body: "Duplicate body with an extra detail: uses wrangler.",
    source: "manual",
    reason: "seed",
  });
  const dupPath = store.buildGraph().nodes.get("site-deploying")!.path;
  const raw = readFileSync(dupPath, "utf8").replace(
    "zzz placeholder wording completely different",
    "Deploying the docs site to Cloudflare Pages",
  );
  await Bun.write(dupPath, raw);
  await store.remember({
    op: "create",
    name: "observer",
    type: "reference",
    description: "Notes that link to the duplicate",
    body: "See [[site-deploying]] for details.",
    source: "manual",
    reason: "seed",
  });

  const report = await store.maintain();
  expect(report.merges).toEqual([
    { canonical: "site-deploy", duplicate: "site-deploying", similarity: expect.any(Number) },
  ]);

  const g = store.buildGraph();
  const canonical = g.nodes.get("site-deploy")!;
  expect(canonical.body).toContain("Canonical body.");
  expect(canonical.body).toContain("Merged from site-deploying");
  expect(canonical.body).toContain("uses wrangler"); // duplicate's content preserved
  expect(canonical.metadata.aliases).toContain("site-deploying"); // old name still resolves
  expect(g.nodes.get("site-deploying")?.phantom ?? true).toBe(true);
  expect(readFileSync(g.nodes.get("observer")!.path, "utf8")).toContain("[[site-deploy]]"); // link retargeted
  expect(existsSync(join(dir, "archive"))).toBe(true);

  // And the old name keeps working through remember's alias dedup.
  const again = await store.remember({
    op: "update",
    name: "site-deploying",
    description: "Deploy the docs site to Cloudflare Pages",
    source: "manual",
    reason: "post-merge write",
  });
  expect(again.name).toBe("site-deploy");
});

test("maintain only FLAGS a borderline pair (identical desc, mostly different names)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "jason-design",
    type: "preference",
    description: "Jason wants editorial experience-first design with real craft",
    source: "manual",
    reason: "seed",
  });
  // Write-time dedup would (correctly) collapse this pair today, so plant the borderline
  // duplicate the way it really occurs: pre-existing on disk from an older Beckett.
  await store.remember({
    op: "create",
    name: "jason-taste",
    type: "preference",
    description: "zzz totally unrelated placeholder wording",
    source: "manual",
    reason: "seed",
  });
  const path = store.buildGraph().nodes.get("jason-taste")!.path;
  await Bun.write(
    path,
    readFileSync(path, "utf8").replace(
      "zzz totally unrelated placeholder wording",
      "Jason wants editorial experience-first design with real craft",
    ),
  );
  const report = await store.maintain();
  expect(report.merges).toEqual([]);
  expect(report.flagged.length).toBe(1);
  const g = store.buildGraph();
  expect(g.nodes.has("jason-design")).toBe(true);
  expect(g.nodes.has("jason-taste")).toBe(true); // both survive — human's call
});

test("maintain --dry-run plans without touching the store", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create",
    name: "doomed",
    type: "decision",
    description: "Will be archived when executed",
    metadata: { ttl: "2020-01-01T00:00:00.000Z" },
    source: "manual",
    reason: "seed",
  });
  const before = readdirSync(dir, { recursive: true });
  const report = await store.maintain({ dryRun: true });
  expect(report.dryRun).toBe(true);
  expect(report.archives.map((a) => a.name)).toEqual(["doomed"]);
  expect(readdirSync(dir, { recursive: true })).toEqual(before);
  expect(store.buildGraph().nodes.has("doomed")).toBe(true);
});

// ── plan + scheduler plumbing ─────────────────────────────────────────────────────────────

test("planMaintenance is pure and reports phantoms", async () => {
  const { store } = tempStore();
  await seedWorld(store); // jason's body links [[loom-desk]] (real); add a dangling ref
  await store.remember({
    op: "create",
    name: "note",
    type: "reference",
    description: "A note referencing someone we have not met",
    body: "Ask [[mystery-person]] about it.",
    source: "manual",
    reason: "seed",
  });
  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.phantoms).toEqual(["mystery-person"]);
  expect(plan.archives).toEqual([]);
});

test("startRoutineMaintenance runs the pass on its timer and stop() halts it", async () => {
  let runs = 0;
  const handle = startRoutineMaintenance({
    maintain: async () => {
      runs++;
      return { scanned: 0, archives: [], merges: [], flagged: [], phantoms: [], agedObservations: [], dryRun: false };
    },
    logger: quietLog,
    initialDelayMs: 5,
    intervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 60));
  handle.stop();
  const after = runs;
  expect(runs).toBeGreaterThanOrEqual(2);
  await new Promise((r) => setTimeout(r, 40));
  expect(runs).toBe(after);
});

test("nodeSimilarity treats reworded same facts as near-identical", () => {
  const a = { name: "deploy-docs", description: "Deploy the docs site to Cloudflare Pages" };
  const b = { name: "deploying-docs", description: "Deploying the docs sites to Cloudflare Pages" };
  expect(nodeSimilarity(a, b)).toBeGreaterThanOrEqual(0.9);
  const c = { name: "unrelated", description: "Weekly standup notes for the mobile app" };
  expect(nodeSimilarity(a, c)).toBeLessThan(0.3);
});
