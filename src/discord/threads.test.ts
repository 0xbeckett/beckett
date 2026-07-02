/**
 * Coverage for the Beckett work-thread registry (OPS-59). This is the load-bearing gate's data
 * store — "is this thread one Beckett created, and is it still active?" — so its persistence,
 * fail-safe parse, and terminal-cooling are pinned here.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadRegistry } from "./threads.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-threads-"));
  file = join(dir, "threads.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("register → get / isActive / getByTicket round-trip", () => {
  const reg = new ThreadRegistry(file);
  reg.register({ threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C1" });
  expect(reg.get("T1")?.ticketIdentifier).toBe("OPS-1");
  expect(reg.isActive("T1")).toBe(true);
  expect(reg.getByTicket("id-1")?.threadId).toBe("T1");
  expect(reg.hasActiveTicketThread("id-1")).toBe(true);
});

test("an unknown thread is never active (fail-safe: stays mention-gated)", () => {
  const reg = new ThreadRegistry(file);
  expect(reg.isActive("nope")).toBe(false);
  expect(reg.get("nope")).toBeUndefined();
});

test("markTerminalByTicket cools the thread — isActive goes false (goes cold)", () => {
  const reg = new ThreadRegistry(file);
  reg.register({ threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C1" });
  const cooled = reg.markTerminalByTicket("id-1");
  expect(cooled?.terminal).toBe(true);
  expect(reg.isActive("T1")).toBe(false); // cold — no longer auto-triggers
  expect(reg.get("T1")).toBeDefined(); // but the record is kept
  expect(reg.hasActiveTicketThread("id-1")).toBe(false);
  // Idempotent: cooling an already-terminal ticket is a no-op.
  expect(reg.markTerminalByTicket("id-1")).toBeUndefined();
});

test("state persists across instances (survives a daemon restart)", () => {
  const a = new ThreadRegistry(file);
  a.register({ threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C1" });
  a.markTerminalByTicket("id-1");
  expect(existsSync(file)).toBe(true);

  const b = new ThreadRegistry(file);
  expect(b.get("T1")?.ticketIdentifier).toBe("OPS-1");
  expect(b.isActive("T1")).toBe(false); // terminal state survived
});

test("a corrupt file degrades to an empty registry — never throws, never widens", () => {
  writeFileSync(file, "{ this is not json ", "utf8");
  const reg = new ThreadRegistry(file); // must not throw
  expect(reg.isActive("anything")).toBe(false);
});

test("malformed rows are skipped, well-formed ones kept", () => {
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      threads: [
        { threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C1" },
        { ticketId: "id-2" }, // no threadId — dropped
        null,
      ],
    }),
    "utf8",
  );
  const reg = new ThreadRegistry(file);
  expect(reg.isActive("T1")).toBe(true);
  expect(reg.getByTicket("id-2")).toBeUndefined();
});

test("re-registering the same thread overwrites cleanly (recovery)", () => {
  const reg = new ThreadRegistry(file);
  reg.register({ threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C1" });
  reg.register({ threadId: "T1", ticketId: "id-1", ticketIdentifier: "OPS-1", parentChannelId: "C9" });
  expect(reg.get("T1")?.parentChannelId).toBe("C9");
  // Only one row on disk for the thread.
  const onDisk = JSON.parse(readFileSync(file, "utf8")).threads.filter((t: { threadId: string }) => t.threadId === "T1");
  expect(onDisk).toHaveLength(1);
});
