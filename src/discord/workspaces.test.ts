/**
 * Coverage for the workspace registry: user-opened threads become ticket workspaces. No Discord
 * side-effects live here — the registry is pure routing state fed by the gateway's thread-create
 * event, grounded by ticket identifiers in the thread name and tickets filed from inside, and
 * persisted so unmentioned routing survives a daemon restart.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "./workspaces.ts";
import type { Logger } from "../types.ts";

const quietLog = (() => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l } as unknown as Logger;
  return l;
})();

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-workspaces-"));
  tmpDirs.push(dir);
  return join(dir, "workspaces.json");
}

test("a user thread registers a workspace, grounded by ticket idents in its name", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-1", parentChannelId: "chan-1", name: "OPS-120 auth rework", creatorId: "u-1" });

  expect(reg.contextFor("t-1")).toEqual({
    parentChannelId: "chan-1",
    name: "OPS-120 auth rework",
    ticketIdents: ["OPS-120"],
    branchRefs: [],
  });
  // A channel that isn't a workspace resolves to nothing.
  expect(reg.contextFor("chan-1")).toBeNull();
});

test("a thread with no ticket in the name is still a workspace (grounded later)", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-2", parentChannelId: "chan-1", name: "brainstorm corner", creatorId: "u-1" });
  expect(reg.contextFor("t-2")).toEqual({ parentChannelId: "chan-1", name: "brainstorm corner", ticketIdents: [], branchRefs: [] });

  // A ticket filed FROM the workspace grounds it.
  reg.bindTicket("t-2", "OPS-7");
  expect(reg.contextFor("t-2")?.ticketIdents).toEqual(["OPS-7"]);
  // Binding against a non-workspace channel is a no-op, not a registration.
  reg.bindTicket("chan-1", "OPS-8");
  expect(reg.contextFor("chan-1")).toBeNull();
});

test("registration is idempotent and binds are deduped", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-3", parentChannelId: "chan-1", name: "OPS-1 and OPS-2", creatorId: "u-1" });
  reg.registerThread({ threadId: "t-3", parentChannelId: "chan-9", name: "renamed", creatorId: "u-2" });
  reg.bindTicket("t-3", "OPS-1");

  expect(reg.contextFor("t-3")).toEqual({
    parentChannelId: "chan-1", // the first registration wins
    name: "OPS-1 and OPS-2",
    ticketIdents: ["OPS-1", "OPS-2"],
    branchRefs: [],
  });
});

test("workspace routing survives a restart via the state file", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerThread({ threadId: "t-4", parentChannelId: "chan-1", name: "OPS-9 migration", creatorId: "u-1" });
  first.bindTicket("t-4", "OPS-10");

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("t-4")).toEqual({
    parentChannelId: "chan-1",
    name: "OPS-9 migration",
    ticketIdents: ["OPS-10", "OPS-9"],
    branchRefs: [],
  });
});

test("a Beckett-created task thread persists task/branch grounding and reverse ticket routing", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerTaskThread(
    { threadId: "task-thread", parentChannelId: "chan-1", name: "#42 - Voting" },
    "#42",
    ["#42.1"],
  );
  first.bindBranch("task-thread", "42.2", "OPS-143");

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("task-thread")).toMatchObject({
    taskRef: "42",
    branchRefs: ["42.1", "42.2"],
    ticketIdents: ["OPS-143"],
  });
  expect(second.channelForTask("#42")).toBe("task-thread");
  expect(second.channelForTicket("OPS-143")).toBe("task-thread");
});

test("registering a repaired task thread replaces its stale route without losing grounding", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerTaskThread(
    { threadId: "thread-deleted", parentChannelId: "chan-1", name: "#42 - Voting" },
    "42",
    ["42.1"],
  );
  reg.bindBranch("thread-deleted", "42.2", "OPS-143");

  reg.registerTaskThread(
    { threadId: "thread-repaired", parentChannelId: "chan-1", name: "#42 - Voting" },
    "42",
    ["42.1", "42.2"],
  );

  expect(reg.contextFor("thread-deleted")).toBeNull();
  expect(reg.channelForTask("42")).toBe("thread-repaired");
  expect(reg.channelForTicket("OPS-143")).toBe("thread-repaired");
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).contextFor("thread-repaired")).toMatchObject({
    taskRef: "42",
    branchRefs: ["42.1", "42.2"],
    ticketIdents: ["OPS-143"],
  });
});

test("a corrupt state file starts fresh instead of throwing", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerThread({ threadId: "t-5", parentChannelId: "chan-1", name: "x", creatorId: "u-1" });
  writeFileSync(file, "{not json", "utf8");

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("t-5")).toBeNull();
  // …and it can still register + persist going forward.
  second.registerThread({ threadId: "t-6", parentChannelId: "chan-1", name: "y", creatorId: "u-1" });
  expect(second.contextFor("t-6")).not.toBeNull();
});
