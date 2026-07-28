/**
 * Semantic scoring for channel search (issue #73). Pins the retrieval-quality contract:
 * the local Moss index blends with (never replaces) the keyword pass, a paraphrase with no
 * shared literal token still finds its channel, stopwords no longer inflate keyword scores,
 * DM windows are never indexed nor returned, and a broken/absent index fails open to the
 * substring scorer without throwing.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelContextStore } from "./channel-context.ts";
import { channelMossDir } from "./channel-moss.ts";
import type { ChannelContextStoreOptions, ChannelEntry } from "./channel-context.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function tempChannelsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-channel-semantic-"));
  tmpDirs.push(dir);
  return join(dir, "channels");
}

function makeStore(overrides: Partial<ChannelContextStoreOptions> = {}) {
  const channelsDir = overrides.channelsDir ?? tempChannelsDir();
  const store = createChannelContextStore({
    channelsDir,
    maxEntriesPerChannel: 50,
    maxAgeHours: 24,
    logger: quietLog,
    now: () => 1_000_000,
    ...overrides,
  });
  return { store, channelsDir };
}

function entry(messageId: string, ts: number, over: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    messageId,
    ts,
    authorId: "224712345678901234",
    authorName: "Jason",
    content: `msg ${messageId}`,
    kind: "user",
    ...over,
  };
}

// ── the wedge: a paraphrase that shares NO literal token still finds its channel ──────────

test("a paraphrase sharing no literal content token still returns the channel", async () => {
  const { store } = makeStore();
  store.noteMeta("billing", { name: "billing", guildId: "g1" });
  store.noteMeta("lunch", { name: "lunch", guildId: "g1" });
  store.append("billing", entry("m1", 1_000, { content: "still waiting on my reimbursement to arrive" }));
  store.append("lunch", entry("m2", 2_000, { content: "let's grab pizza for lunch tomorrow" }));

  await store.ensureIndexed();
  // No token of the query ("refund/show/…") appears literally in the stored message — a pure
  // substring scan scores zero. The semantic pass maps reimbursement↔refund.
  const hits = store.search("when will the refund show up");
  expect(hits.map((h) => h.channelId)).toContain("billing");
  const hit = hits.find((h) => h.channelId === "billing")!;
  expect(hit.entry.messageId).toBe("m1");
  expect(hit.score).toBeGreaterThan(0);
  // The unrelated channel is not dragged in on a nonsense-to-it query.
  expect(hits.map((h) => h.channelId)).not.toContain("lunch");
});

// ── blended, not replaced: the keyword pass still ranks literal matches ───────────────────

test("keyword hits survive and outrank a purely-semantic hit", async () => {
  const { store } = makeStore();
  store.noteMeta("a", { name: "a", guildId: "g1" });
  store.noteMeta("b", { name: "b", guildId: "g1" });
  // Literal match on both query terms in 'a'; only a semantic (concept) match in 'b'.
  store.append("a", entry("m1", 1_000, { content: "the database migration failed" }));
  store.append("b", entry("m2", 2_000, { content: "storage layer keeps erroring" }));

  await store.ensureIndexed();
  const hits = store.search("database migration");
  expect(hits[0]!.channelId).toBe("a"); // two literal terms → highest blended score
  expect(hits[0]!.score).toBeGreaterThanOrEqual(2);
});

// ── stopwords no longer inflate the keyword score ─────────────────────────────────────────

test("stopwords in the query do not inflate the keyword score", () => {
  const { store } = makeStore();
  store.noteMeta("a", { name: "a", guildId: "g1" });
  // Content is full of stopwords that the query also contains.
  store.append("a", entry("m1", 1_000, { content: "the box of pizza is on the table" }));

  // No ensureIndexed(): pure keyword pass, integer scores. Only "pizza" is a real term;
  // "the"/"of"/"is"/"on" are stopwords and must contribute nothing.
  const hits = store.search("the of is on pizza");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.score).toBe(1);
});

// ── DM windows are never indexed and never returned ───────────────────────────────────────

test("a DM window is absent from search results, whatever the query", async () => {
  const { store } = makeStore();
  store.noteMeta("dm", { name: null, guildId: null });
  store.noteMeta("guild", { name: "general", guildId: "g1" });
  store.append("dm", entry("m1", 1_000, { content: "secret reimbursement confession in a DM" }));
  store.append("guild", entry("m2", 2_000, { content: "public poll about pizza toppings" }));

  await store.ensureIndexed();

  // Literal query that matches the DM content word-for-word: still nothing from the DM.
  expect(store.search("reimbursement").map((h) => h.channelId)).not.toContain("dm");
  // Paraphrase that matches the DM semantically: still nothing from the DM.
  expect(store.search("when will the refund arrive").map((h) => h.channelId)).not.toContain("dm");
  // Even naming the DM explicitly yields nothing — the gate is hard.
  expect(store.search("reimbursement", { channelId: "dm" })).toEqual([]);
});

// ── fail open: a broken index degrades to the substring scorer, never throws ──────────────

test("search falls back to the substring scorer when the index cannot persist", async () => {
  const { store, channelsDir } = makeStore();
  store.noteMeta("a", { name: "a", guildId: "g1" });
  store.append("a", entry("m1", 1_000, { content: "watched a great movie last night" }));

  // Plant a plain file where the index cache dir needs to be: opening tolerates the missing
  // index, but any durable write (upsert during reconcile) fails.
  writeFileSync(channelMossDir(channelsDir), "not a directory", "utf8");

  // The index sync fails internally but is swallowed.
  await expect(store.ensureIndexed()).resolves.toBeUndefined();

  // Keyword search still works (trailing-s stem finds "movie"), no throw.
  const hits = store.search("movies");
  expect(hits.map((h) => h.channelId)).toEqual(["a"]);
  expect(hits[0]!.score).toBe(1);
});

test("search returns keyword hits before the index is ever primed", () => {
  const { store } = makeStore();
  store.noteMeta("a", { name: "a", guildId: "g1" });
  store.append("a", entry("m1", 1_000, { content: "pizza night" }));
  // No ensureIndexed() call at all — the index is simply absent.
  const hits = store.search("pizza");
  expect(hits.map((h) => h.channelId)).toEqual(["a"]);
  expect(hits[0]!.score).toBe(1);
});

// ── incremental sync: a later append is indexed without a full rebuild ────────────────────

test("appends after the first ensureIndexed are picked up incrementally", async () => {
  const { store } = makeStore();
  store.noteMeta("a", { name: "a", guildId: "g1" });
  store.append("a", entry("m1", 1_000, { content: "the deploy is green" }));
  await store.ensureIndexed();

  // A brand-new entry in a fresh channel, appended after the initial sync.
  store.noteMeta("b", { name: "b", guildId: "g1" });
  store.append("b", entry("m2", 2_000, { content: "still waiting on my reimbursement to arrive" }));
  await store.ensureIndexed();

  const hits = store.search("when will the refund show up");
  expect(hits.map((h) => h.channelId)).toContain("b");
});
