import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import type { DiscordGateway, ReplyOptions } from "../types.ts";
import { TaskStore } from "../task/store.ts";
import type { BranchStatusService } from "../task/status.ts";
import type { WorkspaceRegistry } from "../discord/workspaces.ts";
import { branchCardReference, CARDS_CHANNEL_ID, Concierge, type ConciergeSession } from "./index.ts";

// The Discord slash surface (`onCommand` — /task create|show|workspace, /stats, /branch) was
// deleted in the v6 Phase-4 product cut: @mention + CLI are the flow.
//
// Beckett no longer creates a thread per task at all — that is the whole point of the threads
// rework, and the FIRST thing these tests pin: `task.created` (what `beckett task create|branch|
// start` calls) and startup recovery must both be thread-silent. `ensureTaskThread` survives for
// the one case still legitimate (the person asking for a thread in words), so its stored-thread
// validation, deleted-thread recreation and sibling-thread logic are exercised by calling it
// directly instead of through a bus command that no longer reaches it.

const OWNER = "111111111111111111";
const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const dirs: string[] = [];

afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(
  opts: {
    failThreadOnce?: boolean;
    branchStatus?: BranchStatusService;
    unavailableThreadIds?: string[];
    existingThreads?: Record<string, string>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-command-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  const createdNames: string[] = [];
  const createdChannels: string[] = [];
  const threadCalls: string[] = [];
  const asks: string[] = [];
  const posts: Array<{ channelId: string; content: string; options?: ReplyOptions }> = [];
  let failThread = opts.failThreadOnce ?? false;
  const gateway = {
    createTaskThread: async (channelId: string, name: string) => {
      threadCalls.push(channelId);
      if (failThread) {
        failThread = false;
        throw new Error("missing CreatePublicThreads");
      }
      if (opts.unavailableThreadIds?.includes(channelId)) throw new Error("Unknown Channel");
      const existingParent = opts.existingThreads?.[channelId];
      if (existingParent) return { threadId: channelId, parentChannelId: existingParent, name };
      createdNames.push(name);
      createdChannels.push(channelId);
      return { threadId: `thread-${createdNames.length}`, parentChannelId: channelId, name };
    },
    sendTyping: async () => {},
    post: async (channelId: string, content: string, options?: ReplyOptions) => {
      posts.push({ channelId, content, options });
      return `message-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  const session = {
    ask: async (turn: string) => {
      asks.push(turn);
      return "got it";
    },
  } as unknown as ConciergeSession;
  const tasks = new TaskStore(join(dir, "tasks.json"));
  const concierge = new Concierge({
    config: validateConfig({}),
    session,
    gateway,
    tasks,
    channelProfiler: null,
    ...(opts.branchStatus ? { branchStatus: opts.branchStatus } : {}),
  });
  return { concierge, tasks, createdNames, createdChannels, threadCalls, asks, posts, dir };
}

/** The private explicit-request path, reachable only by a deliberate call. */
function threadMaker(concierge: Concierge) {
  return (concierge as unknown as {
    ensureTaskThread(taskNumber: number, fallbackChannelId?: string): Promise<{ threadId: string; name: string }>;
  }).ensureTaskThread.bind(concierge);
}

test("task.created records the task and creates NO Discord thread", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: "channel-1" });

  const first = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "channel-1" } });
  // No threadId in the reply and none on the task: the work reports into channel-1 itself.
  expect(first).toEqual({ ok: true, data: { taskRef: "#1" } });
  expect(createdNames).toEqual([]);
  expect(threadCalls).toEqual([]);
  expect(tasks.getTask(1)?.threadId).toBeUndefined();
});

test("task.created on a nonexistent task fails without touching Discord", async () => {
  const { concierge, threadCalls } = harness();
  const reply = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 9, channelId: "channel-1" } });
  expect(reply).toEqual({ ok: false, error: "no such task: #9" });
  expect(threadCalls).toEqual([]);
});

test("task.created grounds the thread it was filed from, and only when that thread is a workspace", async () => {
  const { concierge, tasks } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  concierge.onThreadCreated({
    threadId: "user-thread",
    parentChannelId: "parent-1",
    name: "voting corner",
    creatorId: OWNER,
  });
  await tasks.createTask({ title: "Build voting", originChannelId: "user-thread", initialBranchTitle: "API" });
  await tasks.linkTicket(
    "1.1",
    { id: "t", identifier: "OPS-9", board: "ops", projectId: "p", url: "https://tracker.test/OPS-9" },
    "in_progress",
  );

  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "user-thread" } });
  expect(workspaces.channelForTask("1")).toBe("user-thread");
  expect(workspaces.channelForTicket("OPS-9")).toBe("user-thread");

  // A plain channel is not a workspace, so nothing is recorded and results stay in that channel.
  await tasks.createTask({ title: "Other work", originChannelId: "channel-1" });
  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 2, channelId: "channel-1" } });
  expect(workspaces.channelForTask("2")).toBeNull();
});

test("a thread holding attached work is directed context framed with that work", async () => {
  const { concierge, tasks, asks } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  await tasks.createTask({ title: "First task", originChannelId: "parent-1", initialBranchTitle: "API" });
  concierge.onThreadCreated({
    threadId: "thread-1",
    parentChannelId: "parent-1",
    name: "first task corner",
    creatorId: OWNER,
  });
  workspaces.attachTasks("thread-1", ["1"]);
  workspaces.bindBranch("thread-1", "1.1");

  await concierge.onMessage({
    messageId: "m1",
    userId: OWNER,
    channelId: "thread-1",
    channelName: "first task corner",
    guildId: "guild-1",
    content: "start the main branch now",
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
  });
  expect(asks[0]).toContain("numbered task workspace");
  expect(asks[0]).toContain("task #1");
  expect(asks[0]).toContain("#1.1");
  expect(asks[0]).toContain("do not create a duplicate task");
});

test("an explicitly requested task thread lands as a sibling of the thread it was asked for in", async () => {
  const { concierge, tasks, createdChannels } = harness();
  const ensureTaskThread = threadMaker(concierge);
  await tasks.createTask({ title: "First task", originChannelId: "parent-1" });
  await ensureTaskThread(1, "parent-1");

  // Asking for a thread from inside a thread that already owns work puts the new one under the
  // durable parent, never nested. This is the `currentWorkspace.taskRefs.length` branch.
  await tasks.createTask({ title: "Second task", originChannelId: "thread-1" });
  await ensureTaskThread(2, "thread-1");
  expect(createdChannels).toEqual(["parent-1", "parent-1"]);
  expect(tasks.getTask(2)?.originChannelId).toBe("parent-1");
});

test("an explicit thread request keeps the task durable when Discord refuses, and repairs on retry", async () => {
  const { concierge, tasks, createdNames } = harness({ failThreadOnce: true });
  const ensureTaskThread = threadMaker(concierge);
  await tasks.createTask({ title: "Durable task", originChannelId: "channel-1" });

  await expect(ensureTaskThread(1, "channel-1")).rejects.toThrow("missing CreatePublicThreads");
  expect(tasks.getTask(1)?.threadId).toBeUndefined();

  const repaired = await ensureTaskThread(1, "channel-1");
  expect(repaired.threadId).toBe("thread-1");
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(createdNames).toEqual(["#1 - Durable task"]);
});

test("an explicit thread request gateway-validates a stored thread instead of blindly recreating it", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness({
    existingThreads: { "thread-live": "parent-1" },
  });
  await tasks.createTask({ title: "Live task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-live", "parent-1");

  const thread = await threadMaker(concierge)(1, "different-channel");

  expect(threadCalls).toEqual(["thread-live"]);
  expect(createdNames).toEqual([]);
  expect(thread.threadId).toBe("thread-live");
});

test("an explicit thread request replaces a deleted stored thread under its durable parent", async () => {
  const { concierge, tasks, createdChannels, threadCalls } = harness({
    unavailableThreadIds: ["thread-deleted"],
  });
  await tasks.createTask({ title: "Repair task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-deleted", "parent-1");
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  workspaces.registerTaskThread(
    { threadId: "thread-deleted", parentChannelId: "parent-1", name: "#1 - Repair task" },
    "1",
    ["1.1"],
  );

  const thread = await threadMaker(concierge)(1, "different-channel");

  expect(threadCalls).toEqual(["thread-deleted", "parent-1"]);
  expect(createdChannels).toEqual(["parent-1"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  // The stale workspace yields the ref but stays a registered room the person opened.
  expect(workspaces.contextFor("thread-deleted")?.taskRefs).toEqual([]);
  expect(workspaces.channelForTask("1")).toBe("thread-1");
  expect(thread.threadId).toBe("thread-1");
});

test("startup recovery creates NO thread for a task that never had one", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness();
  await tasks.createTask({ title: "Offline task", originChannelId: "parent-1" });
  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();
  // A boot that spawned a thread per task would recreate the exact noise we removed.
  expect(createdNames).toEqual([]);
  expect(threadCalls).toEqual([]);
  expect(tasks.getTask(1)?.threadId).toBeUndefined();
});

test("startup recovery re-binds branches linked while the daemon was down, and skips vanished threads", async () => {
  const { concierge, tasks, threadCalls } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  await tasks.createTask({ title: "Offline repair", originChannelId: "parent-1", initialBranchTitle: "API" });
  await tasks.setThread(1, "user-thread", "parent-1");
  await tasks.linkTicket(
    "1.1",
    { id: "ticket-id", identifier: "OPS-321", board: "ops", projectId: "project-id", url: "https://tracker.test/OPS-321" },
    "in_progress",
  );
  // The thread is still live in workspaces.json, but the ticket was linked while we were down.
  concierge.onThreadCreated({
    threadId: "user-thread",
    parentChannelId: "parent-1",
    name: "offline repair corner",
    creatorId: OWNER,
  });

  // A second task whose thread the person deleted (never registered) must be left alone.
  await tasks.createTask({ title: "Closed room", originChannelId: "parent-1" });
  await tasks.setThread(2, "thread-gone", "parent-1");

  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();

  expect(threadCalls).toEqual([]);
  expect(workspaces.contextFor("user-thread")).toMatchObject({
    taskRefs: ["1"],
    branchRefs: ["1.1"],
    ticketIdents: ["OPS-321"],
  });
  expect(workspaces.channelForTicket("OPS-321")).toBe("user-thread");
  expect(workspaces.contextFor("thread-gone")).toBeNull();
});

test("a conversational branch-status reference returns the rich card without an LLM turn", async () => {
  const branchStatus = {
    read: async () => ({
      ref: "42.1",
      title: "Voting API",
      taskNumber: 42,
      taskTitle: "Voting",
      status: "review",
      source: "pull_request",
      changes: { additions: 18, deletions: 4, files: 3, commits: 2 },
      pullRequest: { number: 9, url: "https://github.com/acme/voting/pull/9", state: "OPEN", draft: false },
      checks: { total: 2, passed: 2, pending: 0, failed: 0, skipped: 0, conclusion: "SUCCESS" },
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  } as unknown as BranchStatusService;
  const { concierge, asks, posts } = harness({ branchStatus });
  await concierge.onMessage({
    messageId: "branch-question",
    userId: OWNER,
    channelId: "channel-1",
    guildId: "guild-1",
    content: "what's #42.1 looking like?",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
  });

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.channelId).toBe(CARDS_CHANNEL_ID);
  expect(posts[0]?.options?.replyToMessageId).toBeUndefined();
  expect(posts[0]?.options?.embeds?.[0]?.title).toBe("#42.1 - Voting API");
  expect(posts[0]?.options?.buttons?.[0]?.label).toBe("Open PR");
  expect(branchCardReference("please change #42.1 instead")).toBeNull();
});
