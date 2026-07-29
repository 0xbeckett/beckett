/**
 * Coverage for Discord transport edge cases that should not depend on a live Discord connection:
 * no-ping native replies to Beckett's own messages and overlong reply splitting.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, Events, MessageFlags } from "discord.js";
import type { ReplyOptions } from "../types.ts";
import { chunkReply } from "./chunk.ts";
import {
  DiscordJsGateway,
  DiscordTransientMessageEditError,
  DiscordUnknownMessageError,
  splitDiscordContent,
  taskThreadName,
} from "./gateway.ts";
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

/** Capture message PATCHes without a live Discord connection. */
function fakeEditableGateway(edit: (payload: Record<string, unknown>) => Promise<unknown>) {
  const gateway = new DiscordJsGateway();
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => ({ edit }) },
  };
  (gateway as unknown as { client: unknown; connected: boolean }).client = {
    channels: { fetch: async () => channel },
  };
  (gateway as unknown as { connected: boolean }).connected = true;
  return gateway;
}

test("postImage uploads the screenshot and returns its Discord CDN url (#75)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot-"));
  const png = join(dir, "frontend.png");
  writeFileSync(png, "PNG");
  try {
    const sent: Array<{ files?: unknown }> = [];
    const message = { id: "m-1", attachments: { first: () => ({ url: "https://cdn.discord/frontend.png" }) } };
    const channel = {
      isSendable: () => true,
      isTextBased: () => true,
      send: async (payload: { files?: unknown }) => {
        sent.push(payload);
        return message;
      },
      messages: { fetch: async (id: string) => (id === "m-1" ? message : null) },
    };
    const gateway = new DiscordJsGateway();
    (gateway as unknown as { client: unknown; connected: boolean }).client = {
      channels: { fetch: async () => channel },
    };
    (gateway as unknown as { connected: boolean }).connected = true;

    const url = await gateway.postImage("chan-1", "shot", png);
    expect(url).toBe("https://cdn.discord/frontend.png");
    expect(sent).toHaveLength(1); // the file was posted as the channel ping
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postImage degrades to null when the CDN url can't be resolved (#75)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot-"));
  const png = join(dir, "frontend.png");
  writeFileSync(png, "PNG");
  try {
    const channel = {
      isSendable: () => true,
      isTextBased: () => true,
      send: async () => ({ id: "m-2" }),
      messages: {
        fetch: async () => {
          throw new Error("message gone");
        },
      },
    };
    const gateway = new DiscordJsGateway();
    (gateway as unknown as { client: unknown; connected: boolean }).client = {
      channels: { fetch: async () => channel },
    };
    (gateway as unknown as { connected: boolean }).connected = true;

    const url = await gateway.postImage("chan-1", "shot", png);
    expect(url).toBe(null); // channel ping still happened; only the embed url is unavailable
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editMessage PATCHes content and embeds while connected", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const gateway = fakeEditableGateway(async (payload) => { patches.push(payload); });

  await gateway.editMessage("chan-1", "message-1", {
    content: "updated status",
    embeds: [{ title: "Build", description: "green" }],
  });

  expect(patches).toHaveLength(1);
  expect(patches[0]?.content).toBe("updated status");
  expect((patches[0]?.embeds as unknown[])?.length).toBe(1);
  expect(patches[0]?.allowedMentions).toEqual({ parse: [] });
});

test("editMessage replaces the card's buttons in place, and an empty array clears them", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const gateway = fakeEditableGateway(async (payload) => { patches.push(payload); });

  // Twelve buttons spill past Discord's five-per-row cap into three action rows.
  const buttons = Array.from({ length: 12 }, (_, i) => ({ label: `B${i}`, customId: `beckett:v1:cancel:1.${i + 1}` }));
  await gateway.editMessage("chan-1", "message-1", { embeds: [{ title: "Card" }], buttons });
  expect((patches[0]?.components as unknown[])?.length).toBe(3);

  await gateway.editMessage("chan-1", "message-1", { embeds: [{ title: "Card" }], buttons: [] });
  expect(patches[1]?.components).toEqual([]);

  // Omitting buttons leaves Discord's existing components untouched.
  await gateway.editMessage("chan-1", "message-1", { content: "no button change" });
  expect(Object.hasOwn(patches[2]!, "components")).toBe(false);
});

test("an offline edit is applied once after reconnect", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const gateway = fakeEditableGateway(async (payload) => { patches.push(payload); });
  (gateway as unknown as { connected: boolean }).connected = false;

  await expect(gateway.editMessage("chan-1", "message-1", { content: "offline update" })).rejects
    .toBeInstanceOf(DiscordTransientMessageEditError);
  expect(patches).toEqual([]);

  (gateway as unknown as { connected: boolean }).connected = true;
  await (gateway as unknown as { flushQueuedEdits: () => Promise<void> }).flushQueuedEdits();
  expect(patches.map((patch) => patch.content)).toEqual(["offline update"]);
});

test("offline edits coalesce to their latest payload before reconnect", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const gateway = fakeEditableGateway(async (payload) => { patches.push(payload); });
  (gateway as unknown as { connected: boolean }).connected = false;

  await expect(gateway.editMessage("chan-1", "message-1", { content: "first" })).rejects
    .toBeInstanceOf(DiscordTransientMessageEditError);
  await expect(gateway.editMessage("chan-1", "message-1", { content: "latest" })).rejects
    .toBeInstanceOf(DiscordTransientMessageEditError);

  (gateway as unknown as { connected: boolean }).connected = true;
  await (gateway as unknown as { flushQueuedEdits: () => Promise<void> }).flushQueuedEdits();
  expect(patches).toHaveLength(1);
  expect(patches[0]?.content).toBe("latest");
});

test("a Discord 404 edit is a typed unknown-message error", async () => {
  const gateway = fakeEditableGateway(async () => {
    throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10_008 });
  });

  await expect(gateway.editMessage("chan-1", "deleted", { content: "update" })).rejects
    .toBeInstanceOf(DiscordUnknownMessageError);
});

test("a 429 edit waits for retry_after before retrying the one queued payload", async () => {
  const attempts: number[] = [];
  let first = true;
  const gateway = fakeEditableGateway(async () => {
    attempts.push(Date.now());
    if (first) {
      first = false;
      throw Object.assign(new Error("rate limited"), { status: 429, retry_after: 0.02 });
    }
  });

  await expect(gateway.editMessage("chan-1", "message-1", { content: "update" })).rejects
    .toBeInstanceOf(DiscordTransientMessageEditError);
  await new Promise((resolve) => setTimeout(resolve, 35));

  expect(attempts).toHaveLength(2);
  expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(15);
});

test("downtime reconciliation fetches messages after the stored cursor and normalizes them oldest-first", async () => {
  const gateway = new DiscordJsGateway();
  const fetches: Array<Record<string, unknown>> = [];
  const raw = (id: string, createdTimestamp: number) => ({
    id,
    createdTimestamp,
    guildId: "guild-1",
    channelId: "chan-1",
    channel: { name: "ops" },
    content: `message ${id}`,
    author: { id: `user-${id}`, bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false },
    reference: null,
    attachments: new Map(),
  });
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async (opts: Record<string, unknown>) => {
        fetches.push(opts);
        return new Map([["newer", raw("newer", 20)], ["older", raw("older", 10)]]);
      },
    },
  };
  (gateway as unknown as { client: unknown }).client = {
    user: { id: "bot-1" },
    channels: { fetch: async () => channel },
  };

  const messages = await gateway.fetchMessagesAfter("chan-1", "stored-1");
  expect(fetches).toEqual([{ after: "stored-1", limit: 100 }]);
  expect(messages.map((m) => m.messageId)).toEqual(["older", "newer"]);
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

test("interactionCreate defers component clicks ephemerally before routing", async () => {
  const gateway = new DiscordJsGateway();
  const listeners = new Map<string, (...args: any[]) => void>();
  const client = {
    on: (event: string, cb: (...args: any[]) => void) => listeners.set(event, cb),
  };
  (gateway as unknown as { client: unknown }).client = client;
  (gateway as unknown as { wireListeners: (c: unknown) => void }).wireListeners(client);
  const deferred: unknown[] = [];
  const replies: unknown[] = [];
  gateway.onInteraction(async (interaction) => {
    expect(interaction.userId).toBe("owner-1");
    expect(interaction.messageId).toBe("card-msg-1");
    await interaction.editReply("done");
  });

  listeners.get(Events.InteractionCreate)!({
    id: "interaction-1",
    isButton: () => true,
    isStringSelectMenu: () => false,
    customId: "beckett:v1:attach:12",
    user: { id: "owner-1" },
    channelId: "thread-1",
    channel: { isThread: () => true, parentId: "parent-1", name: "work" },
    message: { id: "card-msg-1" },
    deferReply: async (payload: unknown) => { deferred.push(payload); },
    editReply: async (payload: unknown) => { replies.push(payload); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(deferred).toEqual([{ flags: MessageFlags.Ephemeral }]);
  expect(replies).toEqual([{ content: "done" }]);
});

test("both a freshly created thread and one Beckett was added to reach onThreadCreate; bot/parentless ones do not", async () => {
  const gateway = new DiscordJsGateway();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fetched: string[] = [];
  const fakeClient = {
    user: { id: "bot-1" },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(String(event), cb);
    },
    rest: { on: () => undefined },
    // Records any join attempt. `joinThread` starts with `channels.fetch`, so a non-empty list
    // means the gateway tried to join off the raw event — which it must not: it cannot see the
    // access list, so that made Beckett a member of any room anyone could open, before the
    // Concierge had a chance to bounce the creator. Joining now happens behind that gate.
    channels: { fetch: async (id: string) => { fetched.push(id); return null; } },
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
  // The bot's own thread (belt and braces — it should never create one) → still filtered.
  emit({ id: "thread-2", parentId: "parent-1", name: "bot thread", ownerId: "bot-1" }, true);
  // Beckett ADDED to a thread that already existed (newlyCreated === false) → delivered, tagged.
  // This is the only signal we get for a thread that predates the daemon; dropping it made those
  // threads invisible forever.
  emit({ id: "thread-3", parentId: "parent-1", name: "old thread", ownerId: "user-1" }, false);
  // No parent channel → not a channel workspace, still filtered.
  emit({ id: "thread-4", parentId: null, name: "orphan", ownerId: "user-1" }, true);
  await new Promise((r) => setTimeout(r, 0));

  expect(seen).toEqual([
    {
      threadId: "thread-1",
      parentChannelId: "parent-1",
      name: "OPS-7 auth rework",
      creatorId: "user-1",
      newlyCreated: true,
    },
    {
      threadId: "thread-3",
      parentChannelId: "parent-1",
      name: "old thread",
      creatorId: "user-1",
      newlyCreated: false,
    },
  ]);
  // The gateway forwards and nothing more: no join, for any of them.
  expect(fetched).toEqual([]);
});

test("a surfaced thread is joined once so Beckett stays subscribed", async () => {
  const gateway = new DiscordJsGateway();
  let joins = 0;
  const thread = {
    isThread: () => true,
    joined: false,
    join: async () => {
      joins++;
      thread.joined = true;
    },
  };
  (gateway as unknown as { client: unknown }).client = {
    channels: { fetch: async () => thread },
  };

  await gateway.joinThread("thread-1");
  expect(joins).toBe(1);
  // Already a member: re-surfacing must not burn another rate-limited REST call.
  await gateway.joinThread("thread-1");
  expect(joins).toBe(1);
});

test("joining a thread we cannot see is swallowed, not thrown at the gateway", async () => {
  const gateway = new DiscordJsGateway();
  const missingAccess = Object.assign(new Error("Missing Access"), { code: 50_001 });
  (gateway as unknown as { client: unknown }).client = {
    channels: {
      fetch: async () => {
        throw missingAccess;
      },
    },
  };

  await expect(gateway.joinThread("private-thread")).resolves.toBeUndefined();
});

test("a non-thread channel is never joined", async () => {
  const gateway = new DiscordJsGateway();
  let joins = 0;
  (gateway as unknown as { client: unknown }).client = {
    channels: {
      fetch: async () => ({ isThread: () => false, join: async () => { joins++; } }),
    },
  };

  await gateway.joinThread("plain-channel");
  expect(joins).toBe(0);
});

// ── reactions (#103) ─────────────────────────────────────────────────────────────────────────

/** Wire the real listeners onto a fake client and hand back the captured event callbacks. */
function reactionHarness(botId = "bot-1") {
  const gateway = new DiscordJsGateway();
  const listeners = new Map<string, (...args: any[]) => void>();
  const client = {
    user: { id: botId },
    on: (event: string, cb: (...args: any[]) => void) => listeners.set(String(event), cb),
    rest: { on: () => undefined },
  };
  (gateway as unknown as { client: unknown }).client = client;
  (gateway as unknown as { wireListeners: (c: unknown) => void }).wireListeners(client);
  return { gateway, emit: (r: unknown, u: unknown) => listeners.get(Events.MessageReactionAdd)!(r, u) };
}

test("a reaction from a bot (including self) is dropped before any fetch or handler", async () => {
  const { gateway, emit } = reactionHarness();
  const seen: unknown[] = [];
  gateway.onReaction((r) => { seen.push(r); });
  let fetched = false;
  const reaction = {
    partial: true,
    fetch: async () => { fetched = true; return reaction; },
    message: { partial: false, id: "m", channelId: "c", guildId: "g", author: { id: "bot-1" }, components: [] },
    emoji: { name: "✅" },
  };

  emit(reaction, { id: "bot-1", bot: true, partial: false });
  await new Promise((r) => setTimeout(r, 0));

  expect(seen).toEqual([]);
  expect(fetched).toBe(false); // never even fetched — a busy channel's bot emoji stays cheap
});

test("a partial reaction on an uncached message is fetched, then normalized with author + component ids", async () => {
  const { gateway, emit } = reactionHarness();
  const seen: any[] = [];
  gateway.onReaction((r) => { seen.push(r); });

  const fullMessage = {
    partial: false,
    id: "msg-1",
    channelId: "chan-1",
    guildId: "guild-1",
    author: { id: "bot-1" },
    components: [{ components: [{ customId: "beckett:v1:merge:12.1" }, { customId: "beckett:v1:cancel:12.1" }] }],
  };
  const partialMessage = { partial: true, id: "msg-1", fetch: async () => fullMessage };
  const fullReaction = { partial: false, message: partialMessage, emoji: { name: "✅" } };
  const partialReaction = { partial: true, message: partialMessage, emoji: { name: "✅" }, fetch: async () => fullReaction };

  emit(partialReaction, { id: "user-9", bot: false, partial: false });
  await new Promise((r) => setTimeout(r, 0));

  expect(seen).toEqual([
    {
      messageId: "msg-1",
      channelId: "chan-1",
      guildId: "guild-1",
      userId: "user-9",
      emoji: "✅",
      messageAuthorId: "bot-1",
      messageComponentIds: ["beckett:v1:merge:12.1", "beckett:v1:cancel:12.1"],
    },
  ]);
});

test("a partial reacting user is fetched and re-checked, dropping a bot that arrived partial", async () => {
  const { gateway, emit } = reactionHarness();
  const seen: unknown[] = [];
  gateway.onReaction((r) => { seen.push(r); });
  const message = { partial: false, id: "m", channelId: "c", guildId: "g", author: { id: "bot-1" }, components: [] };
  const reaction = { partial: false, message, emoji: { name: "✅" } };
  // bot flag is hidden until the partial user is fetched; the fetched user turns out to be a bot.
  const user = { id: "peer-bot", bot: false, partial: true, fetch: async () => ({ id: "peer-bot", bot: true, partial: false }) };

  emit(reaction, user);
  await new Promise((r) => setTimeout(r, 0));

  expect(seen).toEqual([]);
});

test("addReaction reacts to the target message and no-ops a deleted one", async () => {
  const reacted: string[] = [];
  const gateway = new DiscordJsGateway();
  const message = { react: async (emoji: string) => { reacted.push(emoji); } };
  (gateway as unknown as { client: unknown }).client = {
    channels: { fetch: async () => ({ isTextBased: () => true, messages: { fetch: async () => message } }) },
  };
  await gateway.addReaction("chan-1", "msg-1", "✅");
  expect(reacted).toEqual(["✅"]);

  const gone = new DiscordJsGateway();
  (gone as unknown as { client: unknown }).client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: { fetch: async () => { throw Object.assign(new Error("Unknown Message"), { code: 10_008 }); } },
      }),
    },
  };
  await expect(gone.addReaction("chan-1", "ghost", "✅")).resolves.toBeUndefined();
});

test("a message inside a thread is normalized with its thread flag and parent channel", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  const normalize = (msg: Record<string, unknown>) =>
    (
      gateway as unknown as {
        normalize: (m: Record<string, unknown>) => Promise<{
          isThread?: boolean;
          parentChannelId?: string;
        }>;
      }
    ).normalize(msg);
  const base = {
    guildId: "guild-1",
    createdTimestamp: 0,
    content: "status?",
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: { displayName: "u", roles: { cache: new Map() } },
    mentions: { has: () => false },
    reference: null,
    attachments: new Map(),
  };

  const inThread = await normalize({
    ...base,
    id: "msg-thread",
    channelId: "thread-1",
    channel: { name: "OPS-7", isThread: () => true, parentId: "parent-1" },
  });
  expect(inThread.isThread).toBe(true);
  expect(inThread.parentChannelId).toBe("parent-1");

  const inChannel = await normalize({
    ...base,
    id: "msg-channel",
    channelId: "chan-1",
    channel: { name: "ops", isThread: () => false, parentId: "category-1" },
  });
  expect(inChannel.isThread).toBe(false);
  expect(inChannel.parentChannelId).toBeUndefined();
});

test("a partial or uncached channel leaves thread fields unknown instead of losing the message", async () => {
  const gateway = new DiscordJsGateway();
  (gateway as unknown as { client: { user: { id: string } } }).client = { user: { id: "bot-1" } };
  const normalize = (channel: unknown) =>
    (
      gateway as unknown as {
        normalize: (m: Record<string, unknown>) => Promise<{
          messageId: string;
          isThread?: boolean;
          parentChannelId?: string;
        }>;
      }
    ).normalize({
      id: "msg-partial",
      guildId: null,
      channelId: "dm-1",
      channel,
      createdTimestamp: 0,
      content: "hey",
      author: { id: "user-1", bot: false, username: "u", globalName: null },
      member: null,
      mentions: { has: () => false },
      reference: null,
      attachments: new Map(),
    });

  // A DM partial with no isThread(), and a channel whose isThread() blows up: both degrade to
  // "unknown" rather than throwing out of normalize.
  for (const channel of [
    null,
    {},
    { isThread: () => { throw new Error("uncached channel"); } },
  ]) {
    const normalized = await normalize(channel);
    expect(normalized.messageId).toBe("msg-partial");
    expect(normalized.isThread).toBeUndefined();
    expect(normalized.parentChannelId).toBeUndefined();
  }
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

test("outbound Discord messages redact internal ticket URLs but preserve public URLs", async () => {
  const redactions: Array<Record<string, unknown> | undefined> = [];
  const logger = {
    debug: () => {}, info: () => {}, error: () => {}, child: () => logger,
    warn: (_message: string, fields?: Record<string, unknown>) => { redactions.push(fields); },
  };
  const payloads: Array<Record<string, unknown>> = [];
  const gateway = new DiscordJsGateway({ logger });
  const channel = {
    isSendable: () => true,
    send: async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return { id: "msg-1" };
    },
  };
  (gateway as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } };

  await (gateway as unknown as {
    sendNow: (channelId: string, content: string, opts?: ReplyOptions) => Promise<string>;
  }).sendNow(
    "chan-1",
    "Ticket http://127.0.0.1:7770/tickets/%2342 is filed; see https://github.com/0xbeckett/beckett too.",
  );

  const content = payloads[0]?.content as string;
  expect(content).not.toContain("http://127.0.0.1:7770/tickets/%2342");
  expect(content).toContain("Ticket [internal link removed] is filed");
  expect(content).toContain("https://github.com/0xbeckett/beckett");
  expect(redactions).toHaveLength(1);
  expect(redactions[0]).toMatchObject({ channelId: "chan-1", host: "127.0.0.1" });
});

test("outbound Discord messages redact every prohibited internal host form", async () => {
  const { sent, callSendNow } = fakeSendableGateway();
  const unsafe = [
    "http://localhost:3000/one",
    "http://127.42.0.1/two",
    "http://[::1]/three",
    "http://0.0.0.0/four",
    "http://worker.local/five",
    "http://10.0.0.1/six",
    "http://172.16.0.1/seven",
    "http://192.168.1.1/eight",
  ];
  await callSendNow(`Updates: ${unsafe.join("; ")}.`);

  for (const url of unsafe) expect(sent.join(" ")).not.toContain(url);
  expect(sent.join(" ")).toContain("Updates:");
});

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
