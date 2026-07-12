/**
 * Coverage for Discord transport edge cases that should not depend on a live Discord connection:
 * no-ping native replies to Beckett's own messages and overlong reply splitting.
 */

import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { DiscordJsGateway, splitDiscordContent, taskThreadName } from "./gateway.ts";

test("splitDiscordContent splits long replies without truncating", () => {
  const input = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}\n\n${"c".repeat(1500)}`;
  const chunks = splitDiscordContent(input);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((c) => c.length <= 2000)).toBe(true);
  expect(chunks.join("\n\n")).toBe(input);
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
        member: null;
        mentions: { has: () => boolean };
        reference: { messageId: string };
        attachments: Map<string, unknown>;
        fetchReference: () => Promise<never>;
      }) => Promise<{ mentionsBot: boolean; repliedToId: string | null }>;
    }
  ).normalize({
    id: "human-msg-1",
    guildId: "guild-1",
    channelId: "chan-1",
    content: "following up without ping",
    createdTimestamp: 0,
    author: { id: "user-1", bot: false, username: "u", globalName: null },
    member: null,
    mentions: { has: () => false },
    reference: { messageId: "bot-msg-1" },
    attachments: new Map(),
    fetchReference: async () => {
      throw new Error("should not fetch when the message id is known");
    },
  });

  expect(normalized.repliedToId).toBe("bot-msg-1");
  expect(normalized.mentionsBot).toBe(true);
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

/**
 * Chilltext (OPS-73) is strictly OPT-IN per post. The regression this guards: wiring it
 * unconditionally into sendNow chilled the worker logs relayed into progress threads, so the
 * models supervising a ticket saw a one-line casual summary instead of the actual logs.
 */
function fakeSendableGateway() {
  const sent: string[] = [];
  const gateway = new DiscordJsGateway();
  const channel = {
    isSendable: () => true,
    send: async (payload: { content: string }) => {
      sent.push(payload.content);
      return { id: `msg-${sent.length}` };
    },
  };
  (gateway as unknown as { client: unknown }).client = {
    channels: { fetch: async () => channel },
  };
  const callSendNow = (content: string, opts?: { chill?: boolean }) =>
    (
      gateway as unknown as {
        sendNow: (channelId: string, content: string, opts?: { chill?: boolean }) => Promise<string>;
      }
    ).sendNow("chan-1", content, opts);
  return { sent, callSendNow };
}

test("sendNow without opts.chill never calls the chilltext API — logs pass through verbatim", async () => {
  const { sent, callSendNow } = fakeSendableGateway();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ messages: ["chilled"] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const logLine = "[worker wk_1] stage build: 42 tests passed, pushing branch ops-73";
    await callSendNow(logLine);
    expect(fetchCalls).toBe(0);
    expect(sent).toEqual([logLine]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sendNow with opts.chill sends the collector's bubbles instead of the raw text", async () => {
  const { sent, callSendNow } = fakeSendableGateway();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ messages: ["short casual version"] }), {
      status: 200,
    })) as unknown as typeof fetch;
  try {
    await callSendNow("A long formal multi-sentence reply that should be compressed.", {
      chill: true,
    });
    expect(sent).toEqual(["short casual version"]);
  } finally {
    globalThis.fetch = realFetch;
  }
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
