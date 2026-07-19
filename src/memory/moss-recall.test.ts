/**
 * Moss-served recall tests (issue #20 — the memory/recall transplant onto local moss).
 * Pins the transplant's contract:
 *   - ranking is genuinely served by the local Moss index (hit scores ARE moss scores);
 *   - a pre-moss store (markdown files only) is migrated wholesale on first recall;
 *   - remember / update / archive(delete) keep the index in sync, and out-of-band file
 *     deletion heals on the next recall;
 *   - visibility stays enforced IN CODE, fail-closed: the moss index deliberately holds
 *     owner/dm docs, yet a member viewer (or no viewer) only ever receives public facts;
 *   - a corrupt index is a cache reset, not an outage; a nonsense query stays empty.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { memoryMossDir, MEMORY_INDEX_NAME, MOSS_LEXICAL_SHARPENER_WEIGHT, mossScores, openMemoryMoss } from "./moss.ts";
import { corpusStats, scoreNode, type Audience } from "./search.ts";
import type { Logger } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

/** Deferred Moss writes are intentionally coalesced; wait past the public 50ms window for disk assertions. */
function settleMoss(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-moss-recall-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

/** Ids currently in the on-disk moss sidecar — proof of what the index holds. */
function indexedIds(dir: string): string[] {
  const sidecar = join(memoryMossDir(dir), `${MEMORY_INDEX_NAME}.docs.json`);
  if (!existsSync(sidecar)) return [];
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as { documents: { id: string }[] };
  return parsed.documents.map((d) => d.id).sort();
}

const PARTNER = "881122334455667788";
const OTHER = "112233445566778899";

function viewer(role: Audience["viewerRole"], context: Audience["context"], viewerId?: string): Audience {
  return { viewerId, viewerRole: role, context };
}

async function seedScoped(store: MemoryStore): Promise<void> {
  await store.remember({
    op: "create", name: "deploy-public", type: "project",
    description: "public deploy notes for the cloudflare tunnel",
    source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "deploy-owner", type: "project",
    description: "owner-only deploy secret for the cloudflare tunnel",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "deploy-dm", type: "project",
    description: "dm-scoped deploy note for the cloudflare tunnel",
    metadata: { visibility: "dm", dm_with: PARTNER }, source: "manual", reason: "t",
  });
}

// ── retrieval is served by moss ──────────────────────────────────────────────────────────

test("mossScores caps hybrid retrieval at the keyword-matched set", () => {
  const calls: { topK: number; semanticWeight: number }[] = [];
  const moss = {
    docCount: 5,
    query(_text: string, _filters: undefined, options: { topK: number; semanticWeight: number }) {
      calls.push(options);
      return {
        docs: options.semanticWeight === 0
          ? [{ id: "one" }, { id: "two" }]
          : [{ id: "two", score: 0.8 }, { id: "one", score: 0.7 }],
      };
    },
  } as unknown as import("../moss-local/index.ts").LocalMoss;

  expect([...mossScores(moss, "matched query")]).toEqual([["two", 0.8], ["one", 0.7]]);
  expect(calls).toEqual([
    { topK: 5, semanticWeight: 0 },
    { topK: 2, semanticWeight: 0.75 },
  ]);
});

test("recall scores are Moss-first with the normalized field-aware lexical sharpener", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create", name: "docs-site", type: "project",
    description: "Deploy the docs site to Cloudflare Pages",
    source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "loom-desk", type: "env",
    description: "Ubuntu host where beckett runs",
    body: "The cloudflared tunnel token lives in ~/.cloudflared/config.yml.",
    source: "manual", reason: "t",
  });

  const query = "how are we deploying the documentation site?";
  const r = await store.recall({ text: query });
  await settleMoss();
  expect(r.hits[0]!.node.name).toBe("docs-site");

  // Recompute the score from the persisted Moss index. Moss remains primary; the bounded
  // lexical term restores title/description weighting for close hybrid competitors.
  const moss = await openMemoryMoss(dir, quietLog);
  const raw = mossScores(moss, query);
  const graph = store.buildGraph();
  const matched = [...graph.nodes.values()].filter((node) => raw.has(node.name));
  const stats = corpusStats(matched);
  const lexical = new Map(matched.map((node) => [node.name, scoreNode(query, node, stats)]));
  const lexicalMax = Math.max(...lexical.values(), 1);
  expect(raw.size).toBeGreaterThan(0);
  for (const h of r.hits) {
    const expected = raw.get(h.node.name)! +
      MOSS_LEXICAL_SHARPENER_WEIGHT * (lexical.get(h.node.name) ?? 0) / lexicalMax +
      0.15 * 1e-3;
    expect(h.score).toBeCloseTo(expected, 9);
  }
});

test("a nonsense query returns no hits (the keyword arm is the relevance floor)", async () => {
  const { store } = tempStore();
  await seedScoped(store);
  const r = await store.recall({ text: "zzz qqq completely unmatched nonsense", audience: viewer("owner", "guild", OTHER) });
  expect(r.hits).toEqual([]);
});

// ── migration ────────────────────────────────────────────────────────────────────────────

test("a pre-moss store (bare markdown files) is fully migrated on first recall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-moss-migrate-"));
  tmpDirs.push(dir);
  // Files written by an older Beckett: no store involved, no .moss dir anywhere.
  mkdirSync(join(dir, "people"), { recursive: true });
  mkdirSync(join(dir, "env"), { recursive: true });
  writeFileSync(join(dir, "people", "jason.md"), [
    "---", "name: jason", "description: >", "  Primary user and owner",
    "metadata:", "  type: person", "---", "", "GitHub frgmt0.", "",
  ].join("\n"));
  writeFileSync(join(dir, "env", "loom-desk.md"), [
    "---", "name: loom-desk", "description: >", "  Ubuntu host where beckett runs",
    "metadata:", "  type: env", "---", "",
    "The cloudflared tunnel token lives in ~/.cloudflared/config.yml.", "",
  ].join("\n"));
  expect(existsSync(memoryMossDir(dir))).toBe(false);

  const store = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await store.recall({ text: "where is the cloudflared tunnel token" });
  expect(r.hits.map((h) => h.node.name)).toContain("loom-desk");
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["jason", "loom-desk"]); // every existing file is indexed
});

// ── scope: enforced in code, fail-closed, with the docs sitting IN the index ─────────────

test("owner/dm docs live in the moss index yet NEVER reach a member viewer (fail-closed in code)", async () => {
  const { store, dir } = tempStore();
  await seedScoped(store);
  await settleMoss();

  // The retrieval index itself holds all three docs — moss is not the access authority…
  expect(indexedIds(dir)).toEqual(["deploy-dm", "deploy-owner", "deploy-public"]);

  const names = async (audience?: Audience) =>
    (await store.recall({ text: "cloudflare tunnel deploy", audience })).hits
      .map((h) => h.node.name).sort();

  // …because the in-code gate decides. A member sees only public; owner/dm are excluded.
  expect(await names(viewer("member", "guild", OTHER))).toEqual(["deploy-public"]);
  // A forgotten viewer (no audience at all) fail-closes to public-only.
  expect(await names(undefined)).toEqual(["deploy-public"]);
  // An owner gains owner-scoped facts, still not the dm fact.
  expect(await names(viewer("owner", "guild", OTHER))).toEqual(["deploy-owner", "deploy-public"]);
  // The dm partner sees their dm fact in the DM…
  expect(await names(viewer("member", "dm", PARTNER))).toEqual(["deploy-dm", "deploy-public"]);
  // …and loses it outside the DM (dm facts stay in the DM).
  expect(await names(viewer("member", "guild", PARTNER))).toEqual(["deploy-public"]);

  // The trailing always-loaded index obeys the same gate — no name/description leaks.
  const memberIndex = (await store.recall({ text: "cloudflare tunnel deploy", audience: viewer("member", "guild", OTHER) })).index;
  expect(memberIndex.map((l) => l.name)).toEqual(["deploy-public"]);
});

// ── index sync: remember / update / archive / out-of-band delete ─────────────────────────

test("remember and update keep the moss index in sync (content hash changes with the fact)", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create", name: "fact", type: "reference",
    description: "the first wording of the fact", source: "manual", reason: "t",
  });
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["fact"]);
  const before = readFileSync(join(memoryMossDir(dir), `${MEMORY_INDEX_NAME}.docs.json`), "utf8");

  await store.remember({
    op: "update", name: "fact", type: "reference",
    description: "a completely different second wording", source: "manual", reason: "t",
  });
  await settleMoss();
  const after = readFileSync(join(memoryMossDir(dir), `${MEMORY_INDEX_NAME}.docs.json`), "utf8");
  expect(after).not.toBe(before);
  expect(after).toContain("completely different second wording");

  // And the fresh wording is retrievable via a fresh store (cross-session, from disk).
  const fresh = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await fresh.recall({ text: "different second wording" });
  expect(r.hits[0]!.node.name).toBe("fact");
});

test("maintain-archiving a node removes it from the moss index (delete stays in sync)", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create", name: "keeper", type: "reference",
    description: "a fact that stays", source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "doomed", type: "decision",
    description: "an expired decision headed for the archive",
    metadata: { ttl: "2020-01-01T00:00:00.000Z" }, source: "manual", reason: "t",
  });
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["doomed", "keeper"]);

  const report = await store.maintain();
  expect(report.archives.map((a) => a.name)).toEqual(["doomed"]);
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["keeper"]);

  // The post-delete index must survive a reload intact: a FRESH store (new process in real
  // life) queries the persisted binary and only the surviving fact comes back.
  const fresh = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await fresh.recall({ text: "a fact that stays" });
  expect(r.hits.map((h) => h.node.name)).toEqual(["keeper"]);
});

test("an out-of-band file delete heals from the index on the next recall", async () => {
  const { store, dir } = tempStore();
  await seedScoped(store);
  await settleMoss();
  expect(indexedIds(dir)).toContain("deploy-public");

  unlinkSync(store.buildGraph().nodes.get("deploy-public")!.path); // e.g. a git pull removed it
  const r = await store.recall({ text: "cloudflare tunnel deploy", audience: viewer("owner", "guild", OTHER) });
  expect(r.hits.map((h) => h.node.name)).not.toContain("deploy-public");
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["deploy-dm", "deploy-owner"]);
});

// ── resilience ───────────────────────────────────────────────────────────────────────────

test("a corrupt .moss cache is reset and rebuilt — recall keeps working", async () => {
  const { store, dir } = tempStore();
  await seedScoped(store);
  await settleMoss();
  writeFileSync(join(memoryMossDir(dir), `${MEMORY_INDEX_NAME}.moss`), "not a moss index");

  // A FRESH store must reload from disk, hit the corrupt binary, reset, and resync.
  const fresh = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await fresh.recall({ text: "cloudflare tunnel deploy", audience: viewer("owner", "guild", OTHER) });
  expect(r.hits.map((h) => h.node.name).sort()).toEqual(["deploy-owner", "deploy-public"]);
  await settleMoss();
  expect(indexedIds(dir)).toEqual(["deploy-dm", "deploy-owner", "deploy-public"]);
});

test("the memory repo gitignores the .moss cache (derived data never enters history)", async () => {
  const { store, dir } = tempStore();
  await seedScoped(store);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".moss/");
});
