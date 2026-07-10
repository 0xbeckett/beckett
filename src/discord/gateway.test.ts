/**
 * Coverage for Discord transport edge cases that should not depend on a live Discord connection:
 * no-ping native replies to Beckett's own messages and overlong reply splitting.
 */

import { expect, test } from "bun:test";
import { DiscordJsGateway, splitDiscordContent } from "./gateway.ts";

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

test("startStandaloneThread creates a public sibling under the parent channel", async () => {
  const gateway = new DiscordJsGateway();
  const creates: Array<Record<string, unknown>> = [];
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    threads: {
      create: async (opts: Record<string, unknown>) => {
        creates.push(opts);
        return { id: "workspace-1" };
      },
    },
  };
  (gateway as unknown as { connected: boolean }).connected = true;
  (gateway as unknown as { client: unknown }).client = {
    channels: { fetch: async () => channel },
  };

  const id = await gateway.startStandaloneThread("parent-1", "OPS-7 · with Beckett");

  expect(id).toBe("workspace-1");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    name: "OPS-7 · with Beckett",
    autoArchiveDuration: 10080,
    type: 11,
  });
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
