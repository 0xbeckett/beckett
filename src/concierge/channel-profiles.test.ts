/**
 * Channel profiler (server memory, v4.1). Pins the rebuild trigger contract over a REAL
 * store: threshold gating, the hard DM/no-meta privacy gate, fail-open on summarize
 * errors (write nothing, retry later), queue dedup, incremental re-profiling from the
 * profile anchor, and parseProfile's two accepted stdout shapes.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelContextStore } from "./channel-context.ts";
import type { ChannelContextStore, ChannelEntry } from "./channel-context.ts";
import { createChannelProfiler, parseProfile } from "./channel-profiles.ts";
import type { SummarizeFn } from "./channel-profiles.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function makeStore(): ChannelContextStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-channel-profiles-"));
  tmpDirs.push(dir);
  return createChannelContextStore({
    channelsDir: join(dir, "channels"),
    maxEntriesPerChannel: 50,
    maxAgeHours: 24,
    logger: quietLog,
    now: () => 1_000_000,
  });
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

interface SummarizeCall {
  transcript: string;
  channelName: string | null;
}

/** Recording fake for the summarize seam; optionally fails the first N calls. */
function fakeSummarize(opts: { failFirst?: number } = {}) {
  const calls: SummarizeCall[] = [];
  let failuresLeft = opts.failFirst ?? 0;
  const fn: SummarizeFn = async (transcript, channelName) => {
    calls.push({ transcript, channelName });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("model exploded");
    }
    return { summary: `sum#${calls.length}`, topics: ["t1", "t2"] };
  };
  return { calls, fn };
}

function makeProfiler(store: ChannelContextStore, summarize: SummarizeFn, updateEveryMessages = 3) {
  return createChannelProfiler({
    store,
    model: "test-model",
    updateEveryMessages,
    logger: quietLog,
    summarize,
  });
}

function appendAndNotify(
  store: ChannelContextStore,
  profiler: { notifyAppend(channelId: string): void },
  channelId: string,
  ids: string[],
): void {
  for (const [i, id] of ids.entries()) {
    store.append(channelId, entry(id, 1_000 + i));
    profiler.notifyAppend(channelId);
  }
}

// ── threshold gating ────────────────────────────────────────────────────────────────────

test("below threshold: notifyAppend never calls summarize", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("chan", { name: "media", guildId: "g1" });

  appendAndNotify(store, profiler, "chan", ["m1", "m2"]);
  await profiler.idle();
  expect(calls).toHaveLength(0);
  expect(store.getProfile("chan")).toBeNull();
});

test("at threshold on a guild channel: one rebuild, profile anchored at the newest entry", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("chan", { name: "media", guildId: "g1" });

  appendAndNotify(store, profiler, "chan", ["m1", "m2", "m3"]);
  await profiler.idle();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.channelName).toBe("media");
  // The transcript really is the rendered window, not some placeholder.
  expect(calls[0]!.transcript).toContain("Jason (user:224712345678901234): msg m2");

  const profile = store.getProfile("chan")!;
  expect(profile.summary).toBe("sum#1");
  expect(profile.topics).toEqual(["t1", "t2"]);
  expect(profile.lastMessageId).toBe("m3");
  expect(profile.entryCount).toBe(3);
});

// ── privacy gate ────────────────────────────────────────────────────────────────────────

test("DM channel (guildId null) is never summarized, however many entries pile up", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("dm", { name: null, guildId: null });

  appendAndNotify(store, profiler, "dm", ["m1", "m2", "m3", "m4", "m5", "m6"]);
  await profiler.idle();
  expect(calls).toHaveLength(0);
  expect(store.getProfile("dm")).toBeNull();
});

test("channel with no recorded meta is never summarized (private by default)", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);

  appendAndNotify(store, profiler, "mystery", ["m1", "m2", "m3", "m4", "m5"]);
  await profiler.idle();
  expect(calls).toHaveLength(0);
  expect(store.getProfile("mystery")).toBeNull();
});

// ── failure path ────────────────────────────────────────────────────────────────────────

test("summarize failure writes nothing; a later notifyAppend retries and succeeds", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize({ failFirst: 1 });
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("chan", { name: "media", guildId: "g1" });

  appendAndNotify(store, profiler, "chan", ["m1", "m2", "m3"]);
  await profiler.idle();
  expect(calls).toHaveLength(1);
  // Fail open: no fabricated profile.
  expect(store.getProfile("chan")).toBeNull();

  // More traffic arrives; with no anchor the whole window counts, so the retry fires.
  appendAndNotify(store, profiler, "chan", ["m4"]);
  await profiler.idle();
  expect(calls).toHaveLength(2);
  const profile = store.getProfile("chan")!;
  expect(profile.summary).toBe("sum#2");
  expect(profile.lastMessageId).toBe("m4");
  expect(profile.entryCount).toBe(4);
});

// ── dedup ───────────────────────────────────────────────────────────────────────────────

test("repeated notifyAppend while queued collapses to exactly one summarize call", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("chan", { name: "media", guildId: "g1" });

  for (let i = 1; i <= 3; i++) store.append("chan", entry(`m${i}`, i * 1_000));
  for (let i = 0; i < 5; i++) profiler.notifyAppend("chan");
  await profiler.idle();

  expect(calls).toHaveLength(1);
  expect(store.getProfile("chan")!.lastMessageId).toBe("m3");
});

// ── incremental re-profiling ────────────────────────────────────────────────────────────

test("after a profile, only reaching the threshold AGAIN triggers a second rebuild", async () => {
  const store = makeStore();
  const { calls, fn } = fakeSummarize();
  const profiler = makeProfiler(store, fn, 3);
  store.noteMeta("chan", { name: "media", guildId: "g1" });

  appendAndNotify(store, profiler, "chan", ["m1", "m2", "m3"]);
  await profiler.idle();
  expect(calls).toHaveLength(1);

  // Two new entries since the m3 anchor — below threshold, no second call.
  appendAndNotify(store, profiler, "chan", ["m4", "m5"]);
  await profiler.idle();
  expect(calls).toHaveLength(1);

  // Third new entry crosses the threshold measured from the anchor.
  appendAndNotify(store, profiler, "chan", ["m6"]);
  await profiler.idle();
  expect(calls).toHaveLength(2);
  const profile = store.getProfile("chan")!;
  expect(profile.summary).toBe("sum#2");
  expect(profile.lastMessageId).toBe("m6");
  expect(profile.entryCount).toBe(6);
});

// ── parseProfile ────────────────────────────────────────────────────────────────────────

test("parseProfile accepts direct verdict JSON", () => {
  const verdict = parseProfile(JSON.stringify({ summary: "movie talk", topics: ["movies", "ops"] }));
  expect(verdict).toEqual({ summary: "movie talk", topics: ["movies", "ops"] });
});

test("parseProfile unwraps a {result} envelope with a fenced json block", () => {
  const wrapped = JSON.stringify({
    result: 'Here is the profile:\n```json\n{"summary":"ops chatter","topics":["deploys"]}\n```\nDone.',
  });
  expect(parseProfile(wrapped)).toEqual({ summary: "ops chatter", topics: ["deploys"] });
});

test("parseProfile rejects garbage instead of fabricating a profile", () => {
  expect(() => parseProfile("not json at all")).toThrow();
  expect(() => parseProfile(JSON.stringify({ summary: "", topics: [] }))).toThrow(); // empty summary
});
