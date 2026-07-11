import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import type { DiscordGateway, ReplyOptions } from "../types.ts";
import type { SubscriptionUsageReader } from "../subscription-usage.ts";
import { TaskStore } from "../task/store.ts";
import type { BranchStatusService } from "../task/status.ts";
import type { WorkspaceRegistry } from "../discord/workspaces.ts";
import { branchCardReference, Concierge, type ConciergeSession } from "./index.ts";

const OWNER = "111111111111111111";
const MEMBER = "222222222222222222";
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
  usage?: SubscriptionUsageReader,
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
    ...(usage ? { subscriptionUsage: usage } : {}),
  });
  return { concierge, tasks, createdNames, createdChannels, threadCalls, asks, posts, dir };
}

test("/task create allocates #N, creates its named thread once, and returns a task card", async () => {
  const { concierge, tasks, createdNames } = harness();
  const reply = await concierge.onCommand({
    name: "task",
    subcommand: "create",
    userId: OWNER,
    channelId: "channel-1",
    options: { name: "  Build   voting  " },
  });

  expect(createdNames).toEqual(["#1 - Build voting"]);
  expect(reply.content).toContain("Created #1 - Build voting in <#thread-1>");
  expect(reply.embeds?.[0]?.title).toBe("#1 - Build voting");
  expect(tasks.getTask(1)).toMatchObject({ number: 1, threadId: "thread-1" });

  const shown = await concierge.onCommand({
    name: "task",
    subcommand: "show",
    userId: OWNER,
    channelId: "channel-1",
    options: { number: "#1" },
  });
  expect(shown.embeds?.[0]?.title).toBe("#1 - Build voting");
  expect(createdNames).toHaveLength(1);
});

test("a numbered task thread is directed context and a new task inside it gets a sibling thread", async () => {
  const { concierge, tasks, createdChannels, asks } = harness();
  await concierge.onCommand({
    name: "task",
    subcommand: "create",
    userId: OWNER,
    channelId: "parent-1",
    options: { name: "First task" },
  });

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

  await concierge.onCommand({
    name: "task",
    subcommand: "create",
    userId: OWNER,
    channelId: "thread-1",
    options: { name: "Second task" },
  });
  expect(createdChannels).toEqual(["parent-1", "parent-1"]);
  expect(tasks.getTask(2)?.originChannelId).toBe("parent-1");
});

test("a Discord thread failure reports the durable task and `/task workspace` repairs it", async () => {
  const { concierge, tasks, createdNames } = harness(undefined, { failThreadOnce: true });
  const partial = await concierge.onCommand({
    name: "task",
    subcommand: "create",
    userId: OWNER,
    channelId: "channel-1",
    options: { name: "Durable task" },
  });
  expect(partial.content).toContain("Created #1 - Durable task");
  expect(partial.content).toContain("/task workspace number:1");
  expect(tasks.getTask(1)?.threadId).toBeUndefined();

  const repaired = await concierge.onCommand({
    name: "task",
    subcommand: "workspace",
    userId: OWNER,
    channelId: "channel-1",
    options: { number: "1" },
  });
  expect(repaired.content).toContain("<#thread-1>");
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(createdNames).toEqual(["#1 - Durable task"]);
});

test("/task workspace gateway-validates a stored thread instead of blindly recreating it", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness(undefined, {
    existingThreads: { "thread-live": "parent-1" },
  });
  await tasks.createTask({ title: "Live task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-live", "parent-1");

  const reply = await concierge.onCommand({
    name: "task",
    subcommand: "workspace",
    userId: OWNER,
    channelId: "different-channel",
    options: { number: "1" },
  });

  expect(threadCalls).toEqual(["thread-live"]);
  expect(createdNames).toEqual([]);
  expect(reply.content).toContain("<#thread-live>");
});

test("/task workspace replaces a deleted stored thread under its durable parent", async () => {
  const { concierge, tasks, createdChannels, threadCalls } = harness(undefined, {
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

  const reply = await concierge.onCommand({
    name: "task",
    subcommand: "workspace",
    userId: OWNER,
    channelId: "different-channel",
    options: { number: "1" },
  });

  expect(threadCalls).toEqual(["thread-deleted", "parent-1"]);
  expect(createdChannels).toEqual(["parent-1"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(workspaces.contextFor("thread-deleted")).toBeNull();
  expect(workspaces.channelForTask("1")).toBe("thread-1");
  expect(reply.content).toContain("<#thread-1>");
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
  const { concierge, tasks, threadCalls } = harness(undefined, {
    unavailableThreadIds: ["thread-deleted"],
  });
  await tasks.createTask({ title: "Offline repair", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-deleted", "parent-1");
  await tasks.linkTicket(
    "1.1",
    { id: "ticket-id", identifier: "OPS-321", board: "ops", projectId: "project-id", url: "https://plane/OPS-321" },
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

test("/stats is owner-only and renders every connected subscription", async () => {
  let reads = 0;
  const usage: SubscriptionUsageReader = {
    readAll: async () => {
      reads++;
      return [
        {
          provider: "claude",
          plan: "Max",
          status: "ok",
          windows: [{ label: "Weekly", usedPercent: 20, remainingPercent: 80, reset: null }],
          observedAt: 1_784_000_000_000,
        },
        {
          provider: "codex",
          plan: "Pro",
          status: "ok",
          windows: [{ label: "5-hour", usedPercent: 10, remainingPercent: 90, reset: null }],
          observedAt: 1_784_000_000_000,
        },
      ];
    },
  };
  const { concierge, dir } = harness(usage);
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

  const denied = await concierge.onCommand({
    name: "stats",
    userId: MEMBER,
    channelId: "channel-1",
    options: {},
  });
  expect(denied.content).toContain("private");
  expect(reads).toBe(0);

  const reply = await concierge.onCommand({
    name: "stats",
    userId: OWNER,
    channelId: "channel-1",
    options: {},
  });
  expect(reads).toBe(1);
  expect(reply.embeds?.map((embed) => embed.title)).toEqual(["Claude usage", "Codex usage"]);
  expect(JSON.stringify(reply)).toContain("80% left");
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
  const { concierge, asks, posts } = harness(undefined, { branchStatus });
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
  expect(posts[0]?.options?.embeds?.[0]?.title).toBe("#42.1 - Voting API");
  expect(posts[0]?.options?.buttons?.[0]?.label).toBe("Open PR");
  expect(branchCardReference("please change #42.1 instead")).toBeNull();
});
