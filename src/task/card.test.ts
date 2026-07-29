import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiscordMessageEditPermissionError,
  DiscordTransientMessageEditError,
  DiscordUnknownMessageError,
} from "../discord/gateway.ts";
import type { DiscordMessageEditPayload, ReplyOptions } from "../types.ts";
import { TaskCardService } from "./card.ts";
import { TaskStore, type WorkTask } from "./store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

class FakeGateway {
  posts: Array<{ channelId: string; opts?: ReplyOptions }> = [];
  edits: Array<{ channelId: string; messageId: string; payload: DiscordMessageEditPayload }> = [];
  nextEditError: Error | null = null;
  private counter = 0;

  async post(channelId: string, _content: string, opts?: ReplyOptions): Promise<string> {
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
}

async function seed(): Promise<{ store: TaskStore; gateway: FakeGateway; service: TaskCardService; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-card-"));
  dirs.push(dir);
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Card task", originChannelId: "chan-1" });
  const gateway = new FakeGateway();
  const service = new TaskCardService({
    store,
    gateway,
    resolveChannel: (task: WorkTask) => task.originChannelId ?? null,
    logger: silent,
  });
  return { store, gateway, service, dir };
}

test("first refresh posts one card and persists its id + channel against the task", async () => {
  const { store, gateway, service } = await seed();
  await service.refresh(1);
  expect(gateway.posts).toHaveLength(1);
  expect(gateway.posts[0]?.channelId).toBe("chan-1");
  // The card carries an embed and the 73.1 buttons.
  expect(gateway.posts[0]?.opts?.embeds).toHaveLength(1);
  expect(gateway.posts[0]?.opts?.buttons?.length).toBeGreaterThan(0);
  const card = store.getTask(1)?.card;
  expect(card?.messageId).toBe("message-1");
  expect(card?.channelId).toBe("chan-1");
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
  expect(gateway.edits.every((e) => e.payload.buttons !== undefined)).toBe(true);
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
