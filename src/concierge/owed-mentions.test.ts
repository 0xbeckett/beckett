/**
 * Issue #3 — the owed-mention ledger. The durable half of "a mention whose turn died gets
 * replayed, not re-asked". These pin the store's contract in isolation from the daemon:
 * idempotent claims, the deliver-before-post stamp that prevents a double answer, a replay
 * budget that survives the restart it is counting, and bounds on both age and count.
 *
 * The standing rule under all of it: a ledger that can throw into a turn is worse than no
 * ledger, so a corrupt file and an unwritable path both degrade quietly.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwedMentionStore,
  OWED_MENTION_MAX_AGE_MS,
  type OwedMentionStore,
} from "./owed-mentions.ts";
import type { IncomingMessage } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-owed-"));
  tmpDirs.push(dir);
  return dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function msg(messageId: string, content = "hey, what's the deploy status?"): IncomingMessage {
  return {
    messageId,
    channelId: "1520986792373911622",
    userId: "111111111111111111",
    guildId: null,
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 1_700_000_000_000,
    attachments: [],
  } as unknown as IncomingMessage;
}

function storeAt(file: string, now?: () => number): OwedMentionStore {
  return createOwedMentionStore({ file, logger: quietLog, ...(now ? { now } : {}) });
}

test("a claimed mention survives the process that claimed it", () => {
  const file = join(tempDir(), "owed.json");
  storeAt(file).claim(msg("m-1"));

  // A fresh store == the next boot: the debt is still on the books, with the message verbatim.
  const owed = storeAt(file).list();
  expect(owed).toHaveLength(1);
  expect(owed[0]!.messageId).toBe("m-1");
  expect(owed[0]!.phase).toBe("queued");
  expect(owed[0]!.replays).toBe(0);
  expect(owed[0]!.message.content).toBe("hey, what's the deploy status?");
});

test("settling strikes the debt off for good", () => {
  const file = join(tempDir(), "owed.json");
  const store = storeAt(file);
  store.claim(msg("m-1"));
  store.settle("m-1");

  expect(store.list()).toEqual([]);
  expect(storeAt(file).list()).toEqual([]); // and across the restart
});

test("a re-claim never resets age or replay budget (idempotent by message id)", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000;
  const store = storeAt(file, () => clock);
  store.claim(msg("m-1"));
  store.noteReplay("m-1");

  clock = 5_000;
  store.claim(msg("m-1")); // the same message reaching claim() twice must not launder its history

  const [entry] = store.list();
  expect(entry!.claimedAt).toBe(1_000);
  expect(entry!.replays).toBe(1);
  expect(store.list()).toHaveLength(1);
});

test("markDelivering is what a crash-between-post-and-settle looks like on disk", () => {
  const file = join(tempDir(), "owed.json");
  const store = storeAt(file);
  store.claim(msg("m-1"));
  store.markDelivering("m-1");

  // The stamp is persisted at the moment of the stamp — not at settle time, which by definition
  // never runs in the window this exists for. The next boot must be able to SEE the ambiguity.
  expect(storeAt(file).list()[0]!.phase).toBe("delivering");
});

test("a replay is spent before it runs, so a message that keeps killing the daemon gives up", () => {
  const file = join(tempDir(), "owed.json");
  storeAt(file).claim(msg("m-1"));

  // Each "boot" notes its replay and then dies before settling anything.
  expect(storeAt(file).noteReplay("m-1")).toBe(1);
  expect(storeAt(file).noteReplay("m-1")).toBe(2);
  expect(storeAt(file).noteReplay("m-1")).toBe(3);
  expect(storeAt(file).list()[0]!.replays).toBe(3);
});

test("noteReplay on an unknown id is a no-op, not a resurrection", () => {
  const store = storeAt(join(tempDir(), "owed.json"));
  expect(store.noteReplay("never-claimed")).toBe(0);
  expect(store.list()).toEqual([]);
});

test("a mention nobody answered by tomorrow is dropped rather than answered out of nowhere", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000_000;
  storeAt(file, () => clock).claim(msg("m-stale"));

  clock += OWED_MENTION_MAX_AGE_MS + 1;
  expect(storeAt(file, () => clock).list()).toEqual([]);

  // Just inside the window it is still owed — the bound is a bound, not a rounding error.
  const fresh = join(tempDir(), "owed.json");
  let freshClock = 1_000_000;
  storeAt(fresh, () => freshClock).claim(msg("m-fresh"));
  freshClock += OWED_MENTION_MAX_AGE_MS - 1;
  expect(storeAt(fresh, () => freshClock).list().map((e) => e.messageId)).toEqual(["m-fresh"]);
});

test("the queue is count-bounded, oldest first", () => {
  const file = join(tempDir(), "owed.json");
  const store = createOwedMentionStore({ file, logger: quietLog, maxEntries: 3 });
  for (const id of ["m-1", "m-2", "m-3", "m-4", "m-5"]) store.claim(msg(id));

  expect(store.list().map((e) => e.messageId)).toEqual(["m-3", "m-4", "m-5"]);
});

test("a corrupt ledger loses the queue, never the daemon", () => {
  const file = join(tempDir(), "owed.json");
  writeFileSync(file, "{ this is not json");
  const store = storeAt(file);

  expect(store.list()).toEqual([]);
  expect(() => store.claim(msg("m-1"))).not.toThrow();
  expect(store.list()).toHaveLength(1);
});

test("rows that could not be replayed are dropped rather than carried", () => {
  const file = join(tempDir(), "owed.json");
  writeFileSync(
    file,
    JSON.stringify([
      { messageId: "m-ok", channelId: "c", message: { messageId: "m-ok", userId: "u" }, claimedAt: Date.now(), replays: 0, phase: "queued" },
      { messageId: "m-no-body", channelId: "c", claimedAt: Date.now() },
      // No author to reply TO — replaying this would post at nobody.
      { messageId: "m-no-author", channelId: "c", message: { messageId: "m-no-author" }, claimedAt: Date.now() },
      { channelId: "c", message: { messageId: "?", userId: "u" } },
      "not even an object",
    ]),
  );

  expect(storeAt(file).list().map((e) => e.messageId)).toEqual(["m-ok"]);
});

test("an unwritable ledger degrades to memory instead of throwing into a turn", () => {
  const dir = tempDir();
  // A directory where the file should be: every write fails, for the whole run.
  const file = join(dir, "owed.json");
  mkdirSync(file);
  const store = storeAt(file);

  expect(() => store.claim(msg("m-1"))).not.toThrow();
  expect(() => store.markDelivering("m-1")).not.toThrow();
  // This run still refuses to double-answer — it just has nothing to hand the next boot.
  expect(store.list()[0]!.phase).toBe("delivering");
  expect(() => store.settle("m-1")).not.toThrow();
});

test("the ledger writes atomically and leaves no temp file behind", () => {
  const dir = tempDir();
  const file = join(dir, "owed.json");
  const store = storeAt(file);
  store.claim(msg("m-1"));
  store.markDelivering("m-1");
  store.settle("m-1");

  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  // The rename target is the only artifact: a stray `.tmp` sitting next to it is a half-written
  // ledger, which is the one file shape this whole module must never leave behind.
  expect(readdirSync(dir)).toEqual(["owed.json"]);
});
