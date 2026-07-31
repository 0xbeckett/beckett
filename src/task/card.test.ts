import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiscordMessageEditError,
  DiscordMessageEditPermissionError,
  DiscordTransientMessageEditError,
  DiscordUnknownMessageError,
} from "../discord/gateway.ts";
import type { DiscordMessageEditPayload, Logger, ReplyOptions } from "../types.ts";
import { TaskCardService } from "./card.ts";
import { TaskStore, type WorkTask } from "./store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that keeps every line so tests can assert on level, message, and fields. */
function capturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push = (level: LogRecord["level"]) => (msg: string, fields?: Record<string, unknown>) =>
    void records.push({ level, msg, fields });
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  };
  return { logger, records };
}

class FakeGateway {
  posts: Array<{ channelId: string; opts?: ReplyOptions }> = [];
  edits: Array<{ channelId: string; messageId: string; payload: DiscordMessageEditPayload }> = [];
  deletes: Array<{ channelId: string; messageId: string }> = [];
  nextEditError: Error | null = null;
  nextDeleteError: Error | null = null;
  nextPostError: Error | null = null;
  private counter = 0;

  async post(channelId: string, _content: string, opts?: ReplyOptions): Promise<string> {
    if (this.nextPostError) {
      const error = this.nextPostError;
      this.nextPostError = null;
      throw error;
    }
    this.posts.push({ channelId, opts });
    return `message-${++this.counter}`;
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessageEditPayload): Promise<void> {
    if (this.nextEditError) {
      const error = this.nextEditError;
      this.nextEditError = null;
      throw error;
    }
    this.edits.push({ channelId, messageId, payload });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (this.nextDeleteError) {
      const error = this.nextDeleteError;
      this.nextDeleteError = null;
      throw error;
    }
    this.deletes.push({ channelId, messageId });
  }
}

async function seed(
  logger: Logger = silent,
): Promise<{ store: TaskStore; gateway: FakeGateway; service: TaskCardService; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-card-"));
  dirs.push(dir);
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Card task", originChannelId: "chan-1" });
  const gateway = new FakeGateway();
  const service = new TaskCardService({
    store,
    gateway,
    resolveChannel: (task: WorkTask) => task.originChannelId ?? null,
    logger,
  });
  return { store, gateway, service, dir };
}

test("first refresh posts one card and persists its id + channel against the task", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(gateway.posts[0]?.channelId).toBe("chan-1");
  // The card is a Components V2 container carrying the branch controls.
  expect(gateway.posts[0]?.opts?.card?.blocks.length).toBeGreaterThan(0);
  const card = store.getTask(1)?.card;
  expect(card?.messageId).toBe("message-1");
  expect(card?.channelId).toBe("chan-1");
  expect(card?.v).toBe(2);
});

test("later refreshes edit the same message in place instead of posting again", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1);
  await store.setBranchStatus("1.1", "running");
  await service.refresh(1);
  await store.setBranchStatus("1.1", "review");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(gateway.edits).toHaveLength(2);
  expect(gateway.edits.every((e) => e.messageId === "message-1")).toBe(true);
  expect(gateway.edits.every((e) => e.payload.card !== undefined)).toBe(true);
});

test("a restarted service reads the persisted card id and resumes editing", async () => {
  const { store, gateway, service, dir } = await seed();
  await service.refresh(1);
  const revived = new TaskCardService({
    store: new TaskStore(join(dir, "tasks.json")),
    gateway,
    resolveChannel: () => "chan-1",
    logger: silent,
  });
  await revived.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(gateway.edits).toHaveLength(1);
  expect(gateway.edits[0]?.messageId).toBe("message-1");
});

test("a pre-versioning legacy card is deleted and reposted once, never edited", async () => {
  const { store, gateway, service } = await seed();
  // Simulate a card posted by the legacy embed renderer: no `v` on the stored record.
  await store.setCard(1, { channelId: "chan-1", messageId: "legacy-1" });
  await service.refresh(1);
  expect(gateway.edits).toHaveLength(0);
  expect(gateway.deletes).toEqual([{ channelId: "chan-1", messageId: "legacy-1" }]);
  expect(gateway.posts).toHaveLength(1);
  const card = store.getTask(1)?.card;
  expect(card?.messageId).toBe("message-1");
  expect(card?.v).toBe(2);
  // From here on the fresh V2 card edits in place like any other.
  await store.setBranchStatus("1.1", "running");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(gateway.edits).toHaveLength(1);
  expect(gateway.edits[0]?.messageId).toBe("message-1");
});

test("a deleted legacy card still gets its V2 replacement", async () => {
  const { store, gateway, service } = await seed();
  await store.setCard(1, { channelId: "chan-1", messageId: "legacy-gone" });
  gateway.nextDeleteError = new Error("unknown message");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(store.getTask(1)?.card?.v).toBe(2);
});

test("a deleted card is reposted exactly once and the stored id updated", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1);
  gateway.nextEditError = new DiscordUnknownMessageError("chan-1", "message-1");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(2);
  expect(store.getTask(1)?.card?.messageId).toBe("message-2");
  // The next change edits the fresh id, not a loop of reposts.
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(2);
  expect(gateway.edits.at(-1)?.messageId).toBe("message-2");
});

test("a transient edit failure skips the tick without reposting or losing the id", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1);
  gateway.nextEditError = new DiscordTransientMessageEditError("chan-1", "message-1", "offline");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(store.getTask(1)?.card?.messageId).toBe("message-1");
});

test("a permission failure never reposts (would loop on a message we cannot touch)", async () => {
  const { gateway, service } = await seed();
  await service.refresh(1);
  gateway.nextEditError = new DiscordMessageEditPermissionError("chan-1", "message-1");
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
});

test("a permanent edit rejection logs at error WITH the Discord response body, not a retry warning", async () => {
  const { logger, records } = capturingLogger();
  const { gateway, service } = await seed(logger);
  await service.refresh(1);
  // A generic (non-repost, non-permission, non-transient) edit error is the permanent 4xx bucket:
  // e.g. Discord 400 Invalid Form Body, whose body names the rejected components.
  gateway.nextEditError = new DiscordMessageEditError("failed", "chan-1", "message-1", "invalid form body", {
    cause: { status: 400, rawError: { code: 50035, message: "Invalid Form Body", errors: { components: {} } } },
  });
  await service.refresh(1);
  const errorLine = records.find((r) => r.level === "error");
  expect(errorLine).toBeDefined();
  expect(records.some((r) => r.level === "warn" && r.msg.includes("will retry"))).toBe(false);
  // The actual Discord body rides along so the next 400 takes minutes to find, not months.
  expect(String(errorLine?.fields?.response)).toContain("Invalid Form Body");
  expect(String(errorLine?.fields?.response)).toContain("50035");
  // A permanent failure is skipped this tick like any other — it must not spin into a repost.
  expect(gateway.posts).toHaveLength(1);
});

test("a permanent post rejection logs at error WITH the Discord response body", async () => {
  const { logger, records } = capturingLogger();
  const { gateway, service } = await seed(logger);
  // The raw REST error the post path throws carries an HTTP status and Discord's parsed body.
  gateway.nextPostError = Object.assign(new Error("Invalid Form Body"), {
    status: 400,
    rawError: { code: 50035, message: "Invalid Form Body", errors: { components: {} } },
  });
  await service.refresh(1); // first refresh → fresh post → permanent rejection
  const errorLine = records.find((r) => r.level === "error");
  expect(errorLine).toBeDefined();
  expect(records.some((r) => r.level === "warn" && r.msg.includes("will retry"))).toBe(false);
  expect(String(errorLine?.fields?.response)).toContain("Invalid Form Body");
});

test("a transient (offline / rate-limit) edit failure stays a warn, never an error", async () => {
  const { logger, records } = capturingLogger();
  const { gateway, service } = await seed(logger);
  await service.refresh(1);
  gateway.nextEditError = new DiscordTransientMessageEditError("chan-1", "message-1", "offline");
  await service.refresh(1);
  expect(records.some((r) => r.level === "error")).toBe(false);
  expect(records.some((r) => r.level === "warn" && r.msg.includes("will retry"))).toBe(true);
});

test("concurrent refreshes for one task post only one card", async () => {
  const { gateway, service } = await seed();
  await Promise.all([service.refresh(1), service.refresh(1), service.refresh(1)]);
  expect(gateway.posts).toHaveLength(1);
});

test("a task with no reporting channel gets no card and does not crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-card-"));
  dirs.push(dir);
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Channelless" });
  const gateway = new FakeGateway();
  const service = new TaskCardService({ store, gateway, resolveChannel: () => null, logger: silent });
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(0);
  expect(store.getTask(1)?.card).toBeUndefined();
});

test("refresh of an unknown task is a silent no-op", async () => {
  const { gateway, service } = await seed();
  await service.refresh(999);
  expect(gateway.posts).toHaveLength(0);
});

test("postFresh posts a new card at the given channel even though one already exists elsewhere", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1); // existing card in chan-1
  await service.postFresh(1, "thread-99");
  expect(gateway.posts).toHaveLength(2);
  expect(gateway.posts[1]?.channelId).toBe("thread-99");
  // The fresh post becomes canonical: the next refresh edits IT, not the old card.
  expect(store.getTask(1)?.card).toMatchObject({ channelId: "thread-99", messageId: "message-2" });
  await store.setBranchStatus("1.1", "running");
  await service.refresh(1);
  expect(gateway.edits).toHaveLength(1);
  expect(gateway.edits[0]?.channelId).toBe("thread-99");
  expect(gateway.edits[0]?.messageId).toBe("message-2");
});

test("postFresh on an unknown task throws instead of silently doing nothing", async () => {
  const { service } = await seed();
  await expect(service.postFresh(999, "thread-99")).rejects.toThrow("no such task: #999");
});

test("postFresh propagates a post failure to the caller", async () => {
  const { service } = await seed();
  const failing = new TaskCardService({
    store: (service as unknown as { opts: { store: TaskStore } }).opts.store,
    gateway: { post: async () => { throw new Error("missing permission"); }, editMessage: async () => {}, deleteMessage: async () => {} },
    resolveChannel: () => "chan-1",
    logger: silent,
  });
  await expect(failing.postFresh(1, "thread-99")).rejects.toThrow("missing permission");
});
