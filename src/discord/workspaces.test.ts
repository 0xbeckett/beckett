/**
 * Coverage for the workspace registry: user-opened threads become work workspaces. No Discord
 * side-effects live here — the registry is pure routing state fed by the gateway's thread-create
 * event, grounded by identifiers in the thread name and by explicit `&<taskRef>` / `&recent`
 * attachments, and persisted so unmentioned routing survives a daemon restart.
 *
 * The invariants worth breaking a build over: attachment is ADDITIVE within a thread (a second wave
 * never drops the first) but EXCLUSIVE across threads (a ref routes to exactly one workspace, and
 * `&ref` moves it there even when the target already holds it), a legacy scalar `taskRef` on disk
 * MIGRATES rather than vanishing, and neither `&ref` nor registering a task thread ever STEALS a
 * whole workspace out from under the person who opened it — only the one ref moves.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    taskRefs: [],
    branchRefs: [],
  });
  // A channel that isn't a workspace resolves to nothing.
  expect(reg.contextFor("chan-1")).toBeNull();
});

test("a thread named for a numbered task grounds itself on that task", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-n", parentChannelId: "chan-1", name: "#12 auth rework", creatorId: "u-1" });
  reg.registerThread({ threadId: "t-sub", parentChannelId: "chan-1", name: "#12.1 retry logic", creatorId: "u-1" });

  expect(reg.contextFor("t-n")?.taskRefs).toEqual(["12"]);
  expect(reg.contextFor("t-sub")?.taskRefs).toEqual(["12.1"]);
  expect(reg.channelForTask("#12")).toBe("t-n");
  expect(reg.channelForTask("12.1")).toBe("t-sub");
});

test("name scraping takes both vocabularies and refuses lookalikes", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({
    threadId: "t-mixed",
    parentChannelId: "chan-1",
    name: "OPS-120 + #2 and #10 (see #10 again)",
    creatorId: "u-1",
  });
  // Deduped, and ordered the way a human reads a wave: #2 before #10, not lexicographically.
  expect(reg.contextFor("t-mixed")).toMatchObject({
    ticketIdents: ["OPS-120"],
    taskRefs: ["2", "10"],
  });

  // Bare numbers, `#` + non-digits, and refs glued into a longer token are all NOT task refs.
  reg.registerThread({
    threadId: "t-noise",
    parentChannelId: "chan-1",
    name: "12 ideas for #general, ping auth#7 or #12abc",
    creatorId: "u-1",
  });
  expect(reg.contextFor("t-noise")?.taskRefs).toEqual([]);
});

test("a thread with no work in the name is still a workspace (grounded later)", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-2", parentChannelId: "chan-1", name: "brainstorm corner", creatorId: "u-1" });
  expect(reg.contextFor("t-2")).toEqual({
    parentChannelId: "chan-1",
    name: "brainstorm corner",
    ticketIdents: [],
    taskRefs: [],
    branchRefs: [],
  });

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
    taskRefs: [],
    branchRefs: [],
  });
});

test("attachTasks binds a whole wave to a thread the person opened", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "t-wave", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });

  // The `&recent` case: many refs at once, mixed sigils, duplicates and blanks tolerated.
  reg.attachTasks("t-wave", ["#3", "1", "#3", "  ", "10"]);
  expect(reg.contextFor("t-wave")?.taskRefs).toEqual(["1", "3", "10"]);
  expect(reg.channelForTask("#1")).toBe("t-wave");
  expect(reg.channelForTask("10")).toBe("t-wave");

  // …and it survives a restart.
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).channelForTask("3")).toBe("t-wave");
});

test("attachTasks is additive and idempotent — attaching #2 never drops #1", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-add", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });

  reg.attachTasks("t-add", ["#1"]);
  reg.attachTasks("t-add", ["#2"]);
  expect(reg.contextFor("t-add")?.taskRefs).toEqual(["1", "2"]);

  // Re-attaching an existing ref changes nothing at all.
  reg.attachTasks("t-add", ["#2", "#1"]);
  expect(reg.contextFor("t-add")?.taskRefs).toEqual(["1", "2"]);
});

test("attachTasks MOVES a ref: '&12' in thread B takes routing away from thread A", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  // Thread A grounds itself on #12 just by being named for it — the trap case, because the person
  // never typed `&12` there and has no reason to suspect A is holding the routing hostage.
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "#12 auth rework", creatorId: "u-1" });
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "second attempt", creatorId: "u-1" });
  expect(reg.channelForTask("12")).toBe("A");

  reg.attachTasks("B", ["#12"]);

  // Beckett confirms "#12 reports in here now" — routing has to actually agree.
  expect(reg.channelForTask("12")).toBe("B");
  expect(reg.contextFor("B")?.taskRefs).toEqual(["12"]);
  // A yields the one ref and nothing else: still a workspace, just no longer holding #12.
  expect(reg.contextFor("A")).toEqual({
    parentChannelId: "chan-1",
    name: "#12 auth rework",
    ticketIdents: [],
    taskRefs: [],
    branchRefs: [],
  });
});

test("attachTasks moves only the named refs and leaves the loser's other work alone", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });
  reg.attachTasks("A", ["#12", "#13", "#14"]);
  reg.bindBranch("A", "12.1", "OPS-9");
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "the retry room", creatorId: "u-1" });

  reg.attachTasks("B", ["#12", "#14"]);

  expect(reg.contextFor("A")).toMatchObject({
    taskRefs: ["13"],
    ticketIdents: ["OPS-9"],
    branchRefs: ["12.1"],
  });
  expect(reg.contextFor("B")?.taskRefs).toEqual(["12", "14"]);
  expect(reg.channelForTask("13")).toBe("A");
  expect(reg.channelForTicket("OPS-9")).toBe("A");
});

test("re-attaching a ref the target ALREADY holds still withdraws it from the other workspace", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  // B is grounded on #12 by its name; A is grounded first, so insertion order hands A the routing.
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "#12 first attempt", creatorId: "u-1" });
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "#12 second attempt", creatorId: "u-1" });
  expect(reg.channelForTask("12")).toBe("A");

  // The user types `&12` in B *because it didn't work*. B's own set is already {12}, so a
  // merge-only implementation would early-return and leave routing stuck on A forever.
  reg.attachTasks("B", ["#12"]);

  expect(reg.channelForTask("12")).toBe("B");
  expect(reg.contextFor("A")?.taskRefs).toEqual([]);
});

test("an attach that only withdraws is still persisted across a save/load cycle", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "#12 first attempt", creatorId: "u-1" });
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "#12 second attempt", creatorId: "u-1" });

  reg.attachTasks("B", ["#12"]); // withdrawal-only: B's own set does not change

  // The write must have happened, or the daemon restarts straight back into the wrong routing.
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  expect(onDisk.A.taskRefs).toEqual([]);

  const reloaded = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reloaded.channelForTask("12")).toBe("B");
  expect(reloaded.contextFor("A")?.taskRefs).toEqual([]);
});

test("losing its last ref leaves a workspace REGISTERED, just ungrounded", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "the old room", creatorId: "u-1" });
  reg.attachTasks("A", ["#12"]);
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "the new room", creatorId: "u-1" });

  reg.attachTasks("B", ["#12"]);

  // A is emptied, never deleted — Beckett still listens there without an @mention…
  expect(reg.contextFor("A")).not.toBeNull();
  expect(reg.contextFor("A")?.taskRefs).toEqual([]);
  // …and it can take work again, which would be impossible if it had been unregistered.
  reg.attachTasks("A", ["#20"]);
  expect(reg.channelForTask("20")).toBe("A");
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).contextFor("A")).toMatchObject({
    name: "the old room",
    taskRefs: ["20"],
  });
});

test("a fully inert attachTasks still skips the write", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "solo", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });
  reg.attachTasks("solo", ["#1"]);

  const before = readFileSync(file, "utf8");
  writeFileSync(file, "SENTINEL", "utf8");
  reg.attachTasks("solo", ["#1"]); // nobody else holds it, target already has it: no state change
  expect(readFileSync(file, "utf8")).toBe("SENTINEL");

  // Sanity: the sentinel would have been clobbered had a write occurred.
  reg.attachTasks("solo", ["#2"]);
  expect(readFileSync(file, "utf8")).not.toBe("SENTINEL");
  expect(readFileSync(file, "utf8")).not.toBe(before);
});

test("attachTasks on a thread that is not a workspace is a no-op, not an implicit registration", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.attachTasks("never-registered", ["#1"]);
  expect(reg.contextFor("never-registered")).toBeNull();
  expect(reg.channelForTask("#1")).toBeNull();
});

test("detachAll clears the work but keeps the thread a workspace", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "t-det", parentChannelId: "chan-1", name: "OPS-5 room", creatorId: "u-1" });
  reg.attachTasks("t-det", ["#1", "#2"]);
  reg.bindBranch("t-det", "#1.1");

  reg.detachAll("t-det");

  expect(reg.contextFor("t-det")).toEqual({
    parentChannelId: "chan-1",
    name: "OPS-5 room",
    ticketIdents: [],
    taskRefs: [],
    branchRefs: [],
  });
  expect(reg.channelForTask("#1")).toBeNull();
  expect(reg.channelForTicket("OPS-5")).toBeNull();
  // Still registered, so a later `&ref` lands — and the clear was persisted.
  reg.attachTasks("t-det", ["#9"]);
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).contextFor("t-det")?.taskRefs).toEqual(["9"]);
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
    taskRefs: [],
    branchRefs: [],
  });
});

test("a legacy scalar taskRef on disk migrates into taskRefs instead of being dropped", () => {
  const file = stateFile();
  writeFileSync(
    file,
    JSON.stringify({
      "old-thread": {
        parentChannelId: "chan-1",
        name: "#42 - Voting",
        ticketIdents: ["OPS-143"],
        taskRef: "#42",
        branchRefs: ["42.1"],
      },
    }),
    "utf8",
  );

  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reg.contextFor("old-thread")).toMatchObject({ taskRefs: ["42"], branchRefs: ["42.1"] });
  expect(reg.channelForTask("#42")).toBe("old-thread");

  // And the migrated shape is what gets written back out.
  reg.attachTasks("old-thread", ["#43"]);
  const rewritten = JSON.parse(readFileSync(file, "utf8"));
  expect(rewritten["old-thread"].taskRefs).toEqual(["42", "43"]);
  expect(rewritten["old-thread"].taskRef).toBeUndefined();
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
    taskRefs: ["42"],
    branchRefs: ["42.1", "42.2"],
    ticketIdents: ["OPS-143"],
  });
  expect(second.channelForTask("#42")).toBe("task-thread");
  expect(second.channelForTicket("OPS-143")).toBe("task-thread");
});

test("registerTaskThread withdraws only the one ref from another workspace, never the workspace", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  // A room a person opened, holding a wave.
  reg.registerThread({ threadId: "user-room", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });
  reg.attachTasks("user-room", ["#42", "#43"]);
  reg.bindBranch("user-room", "42.2", "OPS-143");

  reg.registerTaskThread({ threadId: "task-thread", parentChannelId: "chan-1", name: "#42 - Voting" }, "42", ["42.1"]);

  // #42 moved. Everything else about the person's room is untouched.
  expect(reg.channelForTask("42")).toBe("task-thread");
  expect(reg.contextFor("user-room")).toMatchObject({
    name: "release cleanup",
    taskRefs: ["43"],
    ticketIdents: ["OPS-143"],
    branchRefs: ["42.2"],
  });
  expect(reg.channelForTask("43")).toBe("user-room");
  expect(reg.channelForTicket("OPS-143")).toBe("user-room");

  const reloaded = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reloaded.contextFor("user-room")?.taskRefs).toEqual(["43"]);
  expect(reloaded.contextFor("task-thread")).toMatchObject({ taskRefs: ["42"], branchRefs: ["42.1"] });
});

test("registerTaskThread is additive on a thread that already holds other work", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "room", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });
  reg.attachTasks("room", ["#7"]);

  reg.registerTaskThread({ threadId: "room", parentChannelId: "chan-2", name: "#8 - Voting" }, "#8");

  expect(reg.contextFor("room")).toMatchObject({
    parentChannelId: "chan-2",
    taskRefs: ["7", "8"],
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
