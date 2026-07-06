/**
 * Coverage for the living federation peer file (`peers.txt`) — load/add/remove, mirroring the
 * access-list behavior: idempotent, snowflake-validated, corruption-tolerant, atomic.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPeers, addPeer, removePeer, isValidPeerId } from "./peers.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "beckett-peers-")), "peers.txt");
}

const A = "123456789012345678";
const B = "234567890123456789";

test("missing file loads as an empty set (federation off)", () => {
  expect(loadPeers(join(tmpdir(), "does-not-exist-xyz", "peers.txt")).size).toBe(0);
});

test("add writes the id and it loads back", () => {
  const f = tmpFile();
  const r = addPeer(f, A);
  expect(r.status).toBe("added");
  expect(loadPeers(f).has(A)).toBe(true);
});

test("add is idempotent", () => {
  const f = tmpFile();
  addPeer(f, A);
  const r = addPeer(f, A);
  expect(r.status).toBe("already");
  expect(r.ok).toBe(true);
  expect([...loadPeers(f)]).toEqual([A]);
});

test("add rejects a non-snowflake id without writing", () => {
  const f = tmpFile();
  const r = addPeer(f, "not-an-id");
  expect(r.ok).toBe(false);
  expect(r.status).toBe("invalid");
  expect(loadPeers(f).size).toBe(0);
});

test("remove deletes the id; removing an absent id is a no-op", () => {
  const f = tmpFile();
  addPeer(f, A);
  addPeer(f, B);
  expect(removePeer(f, A).status).toBe("removed");
  expect(loadPeers(f).has(A)).toBe(false);
  expect(loadPeers(f).has(B)).toBe(true);
  expect(removePeer(f, A).status).toBe("absent");
});

test("blank lines, comments, and malformed ids are ignored on load", () => {
  const f = tmpFile();
  writeFileSync(f, `# a comment\n\n${A}\ngarbage\n  ${B}  \n`, "utf8");
  expect([...loadPeers(f)].sort()).toEqual([A, B].sort());
});

test("the written file round-trips through load unchanged", () => {
  const f = tmpFile();
  addPeer(f, A);
  addPeer(f, B);
  const reloaded = loadPeers(f);
  expect(reloaded.size).toBe(2);
  // header comments present, ids on their own lines
  expect(readFileSync(f, "utf8")).toContain(A);
});

test("isValidPeerId shape check", () => {
  expect(isValidPeerId(A)).toBe(true);
  expect(isValidPeerId("123")).toBe(false);
  expect(isValidPeerId("<@123456789012345678>")).toBe(false);
});
