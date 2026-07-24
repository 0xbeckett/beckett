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
// deleted in the v6 Phase-4 product cut: @mention + CLI are the flow. These tests pin the
// SURVIVING task-workspace logic — `ensureTaskThread` stored-thread validation, deleted-thread
// recreation, sibling threads, startup reconciliation, and the conversational branch card — which
// were previously reachable ONLY through the removed slash controller. They drive the live
// entrypoints instead: the `task.created` control-bus command (what `beckett task create` calls),
// `restoreTaskWorkspaces` (startup recovery), and `onMessage`.

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

test("task.created allocates the numbered thread and routes it under its channel", async () => {
  const { concierge, tasks, createdNames } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: "channel-1" });

  const first = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "channel-1" } });
  expect(first).toMatchObject({ ok: true, data: { taskRef: "#1", threadId: "thread-1", name: "#1 - Build voting" } });
  expect(createdNames).toEqual(["#1 - Build voting"]);
  expect(tasks.getTask(1)).toMatchObject({ number: 1, threadId: "thread-1" });
});

test("a numbered task thread is directed context and a new task inside it gets a sibling thread", async () => {
  const { concierge, tasks, createdChannels, asks } = harness();
  await tasks.createTask({ title: "First task", originChannelId: "parent-1" });
  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "parent-1" } });

  await concierge.onMessage({
    messageId: "m1",
    userId: OWNER,
    channelId: "thread-1",
    channelName: "#1 - First task",
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

  // A task filed from inside an existing task's thread gets a sibling thread under the durable
  // parent, not a nested thread. This is the `currentWorkspace?.taskRef → parentChannelId` branch.
  await tasks.createTask({ title: "Second task", originChannelId: "thread-1" });
  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 2, channelId: "thread-1" } });
  expect(createdChannels).toEqual(["parent-1", "parent-1"]);
  expect(tasks.getTask(2)?.originChannelId).toBe("parent-1");
});

test("task.created reports a durable task when the thread fails and repairs it on retry", async () => {
  const { concierge, tasks, createdNames } = harness({ failThreadOnce: true });
  await tasks.createTask({ title: "Durable task", originChannelId: "channel-1" });

  const partial = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "channel-1" } });
  expect(partial).toMatchObject({ ok: false });
  expect(tasks.getTask(1)?.threadId).toBeUndefined();

  const repaired = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "channel-1" } });
  expect(repaired).toMatchObject({ ok: true, data: { threadId: "thread-1" } });
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(createdNames).toEqual(["#1 - Durable task"]);
});

test("task.created gateway-validates a stored thread instead of blindly recreating it", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness({
    existingThreads: { "thread-live": "parent-1" },
  });
  await tasks.createTask({ title: "Live task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-live", "parent-1");

  const reply = await concierge.onBusRequest({
    cmd: "task.created",
    args: { taskNumber: 1, channelId: "different-channel" },
  });

  expect(threadCalls).toEqual(["thread-live"]);
  expect(createdNames).toEqual([]);
  expect(reply).toMatchObject({ ok: true, data: { threadId: "thread-live" } });
});

test("task.created replaces a deleted stored thread under its durable parent", async () => {
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

  const reply = await concierge.onBusRequest({
    cmd: "task.created",
    args: { taskNumber: 1, channelId: "different-channel" },
  });

  expect(threadCalls).toEqual(["thread-deleted", "parent-1"]);
  expect(createdChannels).toEqual(["parent-1"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(workspaces.contextFor("thread-deleted")).toBeNull();
  expect(workspaces.channelForTask("1")).toBe("thread-1");
  expect(reply).toMatchObject({ ok: true, data: { threadId: "thread-1" } });
});

test("startup workspace reconciliation creates a task thread missed while the daemon was offline", async () => {
  const { concierge, tasks, createdNames } = harness();
  await tasks.createTask({ title: "Offline task", originChannelId: "parent-1" });
  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();
  expect(createdNames).toEqual(["#1 - Offline task"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
});

test("startup repairs a deleted task thread and restores linked-ticket routing", async () => {
  const { concierge, tasks, threadCalls } = harness({
    unavailableThreadIds: ["thread-deleted"],
  });
  await tasks.createTask({ title: "Offline repair", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-deleted", "parent-1");
  await tasks.linkTicket(
    "1.1",
    { id: "ticket-id", identifier: "OPS-321", board: "ops", projectId: "project-id", url: "https://tracker.test/OPS-321" },
    "in_progress",
  );

  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();

  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  expect(threadCalls).toEqual(["thread-deleted", "parent-1"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(workspaces.contextFor("thread-1")).toMatchObject({
    taskRef: "1",
    branchRefs: ["1.1"],
    ticketIdents: ["OPS-321"],
  });
  expect(workspaces.channelForTicket("OPS-321")).toBe("thread-1");
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
