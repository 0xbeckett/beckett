/**
 * Coverage for the Concierge half of the progress-thread feature: correlating the ticket a turn
 * files (`ticket.filed` on the control bus, mid-turn) with the ack the Concierge posts (end of
 * turn), so the thread is anchored to the RIGHT message. Both ack paths are pinned — the auto-posted
 * turn text AND the `beckett discord reply` CLI path — because whichever one fires is the ack, and
 * the thread must hang off it. Uses injected fakes (no live Discord / no claude), matching
 * `notify.test.ts`.
 */

import { expect, test } from "bun:test";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";

const CHAN = "chan-42";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

interface Recorded {
  posts: { channelId: string; content: string; replyTo?: string }[];
  threads: { channelId: string; anchorMessageId: string; name: string }[];
}

/** Fake gateway recording posts + thread opens; posts return sequential message ids. */
function fakeGateway(rec: Recorded) {
  return {
    async start() {},
    async stop() {},
    async sendTyping() {},
    onMessage() {},
    isConnected() { return true; },
    lastEventAgeMs() { return 0; },
    async post(channelId: string, content: string, o?: { replyToMessageId?: string }) {
      rec.posts.push({ channelId, content, replyTo: o?.replyToMessageId });
      return `mid-${rec.posts.length}`;
    },
    async startThread(channelId: string, anchorMessageId: string, name: string) {
      rec.threads.push({ channelId, anchorMessageId, name });
      return `thread-${rec.threads.length}`;
    },
  } as never;
}

function mention(content: string): IncomingMessage {
  return {
    messageId: "user-msg-1",
    userId: "u1",
    channelId: CHAN,
    guildId: "g1",
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
  };
}

test("a ticket filed mid-turn anchors its thread to the auto-posted ack", async () => {
  const rec: Recorded = { posts: [], threads: [] };
  const gateway = fakeGateway(rec);
  // The fake turn: claude files a ticket mid-turn (bus), then the concierge auto-posts the ack text.
  const session = {
    ask: async () => {
      await (concierge as unknown as { onBusRequest: Function }).onBusRequest({
        cmd: "ticket.filed",
        args: { identifier: "OPS-35", channelId: CHAN, title: "scan my site" },
      });
      return "bet, filing it now. OPS-35, it's cooking.";
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett scan my site for vulns"));

  // Exactly one ack post (the turn text), and one thread hung off that ack message.
  expect(rec.posts).toHaveLength(1);
  const ackId = "mid-1";
  expect(rec.threads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe(ackId);
  expect(rec.threads[0]!.channelId).toBe(CHAN);
  expect(rec.threads[0]!.name).toContain("OPS-35");
});

test("a ticket filed mid-turn anchors its thread to the CLI-reply ack (no double post)", async () => {
  const rec: Recorded = { posts: [], threads: [] };
  const gateway = fakeGateway(rec);
  // The fake turn: claude files a ticket, THEN replies itself via `beckett discord reply` (which
  // claims the turn), so onMessage must NOT auto-post a second time.
  const session = {
    ask: async () => {
      const bus = (concierge as unknown as { onBusRequest: Function }).onBusRequest.bind(concierge);
      await bus({ cmd: "ticket.filed", args: { identifier: "OPS-36", channelId: CHAN, title: "recon" } });
      await bus({ cmd: "discord.reply", args: { channelId: CHAN, text: "bet. filing it now." } });
      return "bet. filing it now."; // same text; must be suppressed (already replied via CLI)
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett recon pass"));

  // Only the CLI reply posted (no duplicate auto-post), and the thread anchors to THAT message.
  expect(rec.posts).toHaveLength(1);
  expect(rec.posts[0]!.replyTo).toBe("user-msg-1"); // native reply to the asker
  expect(rec.threads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe("mid-1");
  expect(rec.threads[0]!.name).toContain("OPS-36");
});

test("a plain chat turn (no ticket filed) opens no thread", async () => {
  const rec: Recorded = { posts: [], threads: [] };
  const gateway = fakeGateway(rec);
  const session = { ask: async () => "yeah that's just vite's default, you're good" } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett is port 5173 normal"));

  expect(rec.posts).toHaveLength(1); // the ack
  expect(rec.threads).toHaveLength(0); // but no work → no thread
});
