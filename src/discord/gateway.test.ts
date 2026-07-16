/**
 * Coverage for Discord transport edge cases that should not depend on a live Discord connection:
 * no-ping native replies to Beckett's own messages and overlong reply splitting.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import type { ReplyOptions } from "../types.ts";
import { chunkReply } from "./chunk.ts";
import { DiscordJsGateway, splitDiscordContent, taskThreadName } from "./gateway.ts";
import {
  BROWSER_QUESTION_ATTACHMENT_NAME,
  BROWSER_QUESTION_SUFFIX,
} from "../browser/question-message.ts";

test("splitDiscordContent splits long replies without truncating", () => {
  const input = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}\n\n${"c".repeat(1500)}`;
  const chunks = splitDiscordContent(input);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((c) => c.length <= 2000)).toBe(true);
  expect(chunks.join("\n\n")).toBe(input);
});

test("an expiring post can fail fast instead of queueing while Discord is offline", async () => {
  const gateway = new DiscordJsGateway();
  await expect(gateway.post("chan-1", "question", { queueIfOffline: false })).rejects.toThrow("offline");
});

test("native reply to a bot-authored message counts as addressed", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  (gateway as unknown as { ownMessageIds: Set<string> }).ownMessageIds = new Set(["bot-msg-1"]);

  const normalized = await (
    gateway as unknown as {
      normalize: (msg: {
        id: string;
        guildId: string;
        channelId: string;
        content: string;
        createdTimestamp: number;
        author: { id: string; bot: boolean; username: string; globalName: string | null };
        member: { displayName: string; roles: { cache: Map<string, unknown> } };
        mentions: { has: () => boolean };
        reference: { messageId: string };
        attachments: Map<string, unknown>;
        fetchReference: () => Promise<never>;
      }) => Promise<{ mentionsBot: boolean; repliedToId: string | null; roleIds?: string[] }>;
    }
  ).normalize({
    id: "human-msg-1",
    guildId: "guild-1",
    channelId: "chan-1",
    content: "following up without ping",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map([["1520985787062030456", {}]]) } },
    mentions: { has: () => false },
    reference: { messageId: "bot-msg-1" },
    attachments: new Map(),
    fetchReference: async () => {
      throw new Error("should not fetch when the message id is known");
    },
  });

  expect(normalized.repliedToId).toBe("bot-msg-1");
  expect(normalized.mentionsBot).toBe(true);
  expect(normalized.roleIds).toEqual(["1520985787062030456"]);
});

test("a referenced atomic browser question is recognizable after the gateway restarts", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  const normalized = await (
    gateway as unknown as { normalize: (msg: Record<string, unknown>) => Promise<{
      mentionsBot: boolean;
      repliedToBrowserQuestion?: boolean;
    }> }
  ).normalize({
    id: "late-secret",
    guildId: "guild-1",
    channelId: "chan-1",
    channel: { name: "ops" },
    content: "739184",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false, repliedUser: { id: "bot-1" } },
    reference: { messageId: "orphan-question" },
    attachments: new Map(),
    fetchReference: async () => ({
      author: { id: "bot-1" },
      content: `Which code?${BROWSER_QUESTION_SUFFIX}`,
      attachments: new Map([["attachment", { name: BROWSER_QUESTION_ATTACHMENT_NAME }]]),
    }),
  });
  expect(normalized.mentionsBot).toBe(true);
  expect(normalized.repliedToBrowserQuestion).toBe(true);
});

test("copied browser-question wording without the reserved screenshot marker stays ordinary", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  const normalized = await (
    gateway as unknown as { normalize: (msg: Record<string, unknown>) => Promise<{
      mentionsBot: boolean;
      repliedToBrowserQuestion?: boolean;
      repliedToBotUnverified?: boolean;
    }> }
  ).normalize({
    id: "ordinary-reply",
    guildId: "guild-1",
    channelId: "chan-1",
    channel: { name: "ops" },
    content: "normal follow-up",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false, repliedUser: { id: "bot-1" } },
    reference: { messageId: "ordinary-bot-message" },
    attachments: new Map(),
    fetchReference: async () => ({
      author: { id: "bot-1" },
      content: `Copied wording${BROWSER_QUESTION_SUFFIX}`,
      attachments: new Map([["attachment", { name: "ordinary-proof.png" }]]),
    }),
  });
  expect(normalized.mentionsBot).toBe(true);
  expect(normalized.repliedToBrowserQuestion).toBeUndefined();
  expect(normalized.repliedToBotUnverified).toBeUndefined();
});

test("an uninspectable bot reply reference is marked fail-closed", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  const normalized = await (
    gateway as unknown as { normalize: (msg: Record<string, unknown>) => Promise<{
      repliedToBrowserQuestion?: boolean;
      repliedToBotUnverified?: boolean;
    }> }
  ).normalize({
    id: "ambiguous-secret",
    guildId: "guild-1",
    channelId: "chan-1",
    channel: { name: "ops" },
    content: "739184",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false, repliedUser: { id: "bot-1" } },
    reference: { messageId: "unknown-bot-message" },
    attachments: new Map(),
    fetchReference: async () => { throw new Error("transient Discord failure"); },
  });
  expect(normalized.repliedToBrowserQuestion).toBeUndefined();
  expect(normalized.repliedToBotUnverified).toBe(true);
});

test("a live browser-question id stays classified during the post-to-ledger handoff", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  (gateway as unknown as { ownMessageIds: Set<string> }).ownMessageIds = new Set(["live-question"]);
  (gateway as unknown as { browserQuestionMessageIds: Set<string> }).browserQuestionMessageIds =
    new Set(["live-question"]);
  const normalized = await (
    gateway as unknown as { normalize: (msg: Record<string, unknown>) => Promise<{
      repliedToBrowserQuestion?: boolean;
      repliedToBotUnverified?: boolean;
    }> }
  ).normalize({
    id: "fast-reply",
    guildId: "guild-1",
    channelId: "chan-1",
    channel: { name: "ops" },
    content: "739184",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false, repliedUser: { id: "bot-1" } },
    reference: { messageId: "live-question" },
    attachments: new Map(),
    fetchReference: async () => { throw new Error("known ids must not need REST"); },
  });
  expect(normalized.repliedToBrowserQuestion).toBe(true);
  expect(normalized.repliedToBotUnverified).toBeUndefined();
});

test("a user-created thread is normalized to the onThreadCreate handler; bot/replayed ones are not", async () => {
  const gateway = new DiscordJsGateway();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fakeClient = {
    user: { id: "bot-1" },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(String(event), cb);
    },
    rest: { on: () => undefined },
  };
  (gateway as unknown as { client: unknown }).client = fakeClient;
  (gateway as unknown as { wireListeners: (c: unknown) => void }).wireListeners(fakeClient);

  const seen: unknown[] = [];
  gateway.onThreadCreate((t) => {
    seen.push(t);
  });
  const emit = listeners.get("threadCreate")!;
  expect(emit).toBeDefined();

  // A person opened a thread → normalized and delivered.
  emit({ id: "thread-1", parentId: "parent-1", name: "OPS-7 auth rework", ownerId: "user-1" }, true);
  // The bot's own thread (belt and braces — it should never create one) → filtered.
  emit({ id: "thread-2", parentId: "parent-1", name: "bot thread", ownerId: "bot-1" }, true);
  // A replayed create (bot merely ADDED to an existing thread) → filtered.
  emit({ id: "thread-3", parentId: "parent-1", name: "old thread", ownerId: "user-1" }, false);
  await new Promise((r) => setTimeout(r, 0));

  expect(seen).toEqual([
    { threadId: "thread-1", parentChannelId: "parent-1", name: "OPS-7 auth rework", creatorId: "user-1" },
  ]);
});

/** Capture sendNow payloads without a live Discord connection. */
function fakeSendableGateway() {
  const sent: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const gateway = new DiscordJsGateway();
  const channel = {
    isSendable: () => true,
    send: async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      sent.push(typeof payload.content === "string" ? payload.content : "");
      return { id: `msg-${sent.length}` };
    },
  };
  (gateway as unknown as { client: unknown }).client = {
    channels: { fetch: async () => channel },
  };
  const callSendNow = (content: string, opts?: ReplyOptions) =>
    (
      gateway as unknown as {
        sendNow: (channelId: string, content: string, opts?: ReplyOptions) => Promise<string>;
      }
    ).sendNow("chan-1", content, opts);
  return { sent, payloads, callSendNow };
}

test("direct replies use a native reply and whitelist only its author", async () => {
  const { payloads, callSendNow } = fakeSendableGateway();
  const userId = "1151230208783945818";
  await callSendNow(`@everyone @here <@&987654321> <@${userId}> got it`, {
    replyToMessageId: "message-1",
    replyToUserId: userId,
  });

  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.reply).toEqual({ messageReference: "message-1", failIfNotExists: false });
  expect(payloads[0]?.allowedMentions).toEqual({ parse: [], users: [userId], repliedUser: true });
  // The native reply is the one notification: a model-authored duplicate <@user> is removed.
  expect(payloads[0]?.content).toBe("@everyone @here <@&987654321> got it");
});

test("a reply containing only a redundant mention remains deliverable without double-pinging", async () => {
  const { payloads, callSendNow } = fakeSendableGateway();
  const userId = "1151230208783945818";
  await callSendNow(`<@${userId}>`, { replyToMessageId: "message-1", replyToUserId: userId });

  expect(payloads[0]?.content).toBe("\u200b");
  expect(payloads[0]?.allowedMentions).toEqual({ parse: [], users: [userId], repliedUser: true });
});

test("ambient one-liners have no reply or ping, and all implicit mention parsing is disabled", async () => {
  const { payloads, callSendNow } = fakeSendableGateway();
  await callSendNow("@everyone @here <@&987654321> <@1151230208783945818> nice");

  expect(payloads).toHaveLength(1);
  expect(payloads[0]).not.toHaveProperty("reply");
  expect(payloads[0]?.allowedMentions).toEqual({ parse: [] });
});

test("sendNow singleMessage keeps a long browser question and screenshot in one API message", async () => {
  const { payloads, callSendNow } = fakeSendableGateway();
  const dir = mkdtempSync(join(tmpdir(), "beckett-atomic-discord-"));
  const screenshot = join(dir, "question.png");
  writeFileSync(screenshot, "png fixture");
  const sentence = "The browser shows private account context that must stay beside its screenshot. ";
  const question = "Which account should I choose before continuing?";
  const instruction = " Reply directly to this message and I'll continue from the same page.";
  const fixedText = `${question}${instruction}`;
  const content = `${sentence.repeat(Math.floor((1_900 - fixedText.length) / sentence.length))}${fixedText}`;
  try {
    expect(content.length).toBeGreaterThan(1_800);
    expect(content.length).toBeLessThanOrEqual(2_000);
    expect(chunkReply(content).length).toBeGreaterThan(1);

    const id = await callSendNow(content, {
      files: [screenshot],
      singleMessage: true,
      browserQuestion: true,
    });

    expect(id).toBe("msg-1");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.content).toBe(content);
    expect(payloads[0]?.files).toHaveLength(1);
    expect((payloads[0]?.files as Array<{ name?: string }>)[0]?.name).toBe(BROWSER_QUESTION_ATTACHMENT_NAME);
    expect(payloads[0]?.content).toEndWith(instruction.trimStart());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendNow singleMessage rejects content Discord cannot accept atomically", async () => {
  const { payloads, callSendNow } = fakeSendableGateway();
  await expect(callSendNow("x".repeat(2_001), { singleMessage: true })).rejects.toThrow(
    "exceeds 2000 characters",
  );
  await expect(callSendNow("privacy-critical question", { browserQuestion: true })).rejects.toThrow(
    "one atomic Discord message",
  );
  expect(payloads).toEqual([]);
});

test("sendNow supports an embed-only status card with a link button", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const gateway = new DiscordJsGateway();
  const channel = {
    isSendable: () => true,
    send: async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return { id: "status-card" };
    },
  };
  (gateway as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } };

  const id = await (
    gateway as unknown as {
      sendNow: (channelId: string, content: string, opts: unknown) => Promise<string>;
    }
  ).sendNow("chan-1", "", {
    embeds: [{ title: "#42.1 - API", fields: [{ name: "Changes", value: "+18 / -4" }] }],
    buttons: [{ label: "Open PR", url: "https://github.com/0xbeckett/beckett/pull/101" }],
  });

  expect(id).toBe("status-card");
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).not.toHaveProperty("content");
  expect((payloads[0]?.embeds as unknown[])?.length).toBe(1);
  expect((payloads[0]?.components as unknown[])?.length).toBe(1);
});

test("task thread names are normalized and Discord-safe", () => {
  expect(taskThreadName(" #42 -   Voting\nlaunch ")).toBe("#42 - Voting launch");
  expect([...taskThreadName("x".repeat(101))]).toHaveLength(100);
  expect(() => taskThreadName("\n\t")).toThrow("cannot be empty");
});

test("createTaskThread opens a named workspace from a text channel", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const gateway = new DiscordJsGateway();
  const channel = {
    id: "parent-1",
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { id: "thread-1", name: request.name as string };
      },
    },
  };
  (gateway as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } };

  const created = await gateway.createTaskThread("parent-1", "#9 - Ship export");
  expect(created).toEqual({ threadId: "thread-1", parentChannelId: "parent-1", name: "#9 - Ship export" });
  expect(requests[0]).toMatchObject({ name: "#9 - Ship export", reason: "Beckett task workspace" });
});

test("slash-command replies disable mentions in user-controlled task titles", async () => {
  const gateway = new DiscordJsGateway();
  gateway.onCommand(async () => ({ content: "Created #1 - <@&123> @everyone" }));
  const edits: Array<Record<string, unknown>> = [];
  const interaction = {
    commandName: "task",
    user: { id: "user-1" },
    channelId: "channel-1",
    options: {
      getSubcommand: () => "create",
      data: [{ name: "create", options: [{ name: "name", value: "<@&123> @everyone" }] }],
    },
    deferReply: async () => {},
    editReply: async (payload: Record<string, unknown>) => { edits.push(payload); },
  };
  await (
    gateway as unknown as { handleCommandInteraction(value: unknown): Promise<void> }
  ).handleCommandInteraction(interaction);
  expect(edits[0]).toMatchObject({ allowedMentions: { parse: [] } });
});
