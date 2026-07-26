import { expect, test } from "bun:test";
import { fetchModelNewsFeed, isQualifyingItem, pickModelId, type ModelNewsItem } from "./model-news.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function item(overrides: Partial<ModelNewsItem> = {}): ModelNewsItem {
  return {
    id: "item-1",
    title: "Claude added claude-opus-5",
    summary: "Anthropic shipped claude-opus-5.",
    tags: [],
    source: { url: "https://example.com/release" },
    publishedAt: "2026-07-24T17:01:43.103Z",
    newModel: true,
    models: ["claude-opus-5"],
    removedModels: [],
    ...overrides,
  };
}

// ── isQualifyingItem ─────────────────────────────────────────────────────────────────────────

test("qualifies an unseen, newModel item published inside the last 24h with a source url", () => {
  expect(isQualifyingItem(item(), { seenIds: new Set(), now: NOW })).toBe(true);
});

test("does not qualify an item already in the seen-set", () => {
  expect(isQualifyingItem(item(), { seenIds: new Set(["item-1"]), now: NOW })).toBe(false);
});

test("does not qualify a non-newModel item (a changelog entry about something else)", () => {
  expect(isQualifyingItem(item({ newModel: false }), { seenIds: new Set(), now: NOW })).toBe(false);
});

test("does not qualify an item older than 24h", () => {
  const stale = item({ publishedAt: "2026-07-20T00:00:00.000Z" });
  expect(isQualifyingItem(stale, { seenIds: new Set(), now: NOW })).toBe(false);
});

test("does not qualify an item with no source url — nothing to verify against", () => {
  expect(isQualifyingItem(item({ source: undefined }), { seenIds: new Set(), now: NOW })).toBe(false);
  expect(isQualifyingItem(item({ source: { url: "" } }), { seenIds: new Set(), now: NOW })).toBe(false);
});

test("does not qualify an item with an unparseable publishedAt", () => {
  expect(isQualifyingItem(item({ publishedAt: "not-a-date" }), { seenIds: new Set(), now: NOW })).toBe(false);
});

test("tolerates small clock skew (published slightly in the future)", () => {
  const skewed = item({ publishedAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() });
  expect(isQualifyingItem(skewed, { seenIds: new Set(), now: NOW })).toBe(true);
});

test("rejects an item published far in the future — bad data, not clock skew", () => {
  const future = item({ publishedAt: new Date(NOW.getTime() + 3 * 60 * 60_000).toISOString() });
  expect(isQualifyingItem(future, { seenIds: new Set(), now: NOW })).toBe(false);
});

// ── pickModelId ──────────────────────────────────────────────────────────────────────────────

test("pickModelId uses the first named model", () => {
  expect(pickModelId(item({ models: ["a", "b"] }))).toBe("a");
});

test("pickModelId falls back to the feed id when no model is named", () => {
  expect(pickModelId(item({ models: [] }))).toBe("item-1");
});

// ── fetchModelNewsFeed — defensive against a third-party feed ──────────────────────────────────

test("parses a well-formed feed", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ items: [item()], hasMore: false }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.items).toHaveLength(1);
});

test("a non-200 response is reported, not thrown", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("503");
});

test("a network error / timeout is reported, not thrown", async () => {
  const fetchImpl = (async () => {
    throw new Error("timed out");
  }) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("timed out");
});

test("unparseable JSON is reported, not thrown", async () => {
  const fetchImpl = (async () => new Response("{not json", { status: 200 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("JSON");
});

test("an unexpected top-level shape (no items array) is reported, not thrown", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ oops: true }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(false);
});

test("a single malformed item is dropped without failing the round", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ items: [item(), { no: "id here" }] }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.id).toBe("item-1");
  }
});

test("unknown/extra fields on an item never crash parsing", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ items: [{ ...item(), somethingNew: { nested: true } }] }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchModelNewsFeed("https://example.com/feed", { fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.items).toHaveLength(1);
});
