/**
 * Coverage for the Concierge half of the progress-thread feature: correlating the ticket a turn
 * files (`ticket.filed` on the control bus, mid-turn) with the ack the Concierge posts (end of
 * turn), so the thread is anchored to the RIGHT message. Both ack paths are pinned — the auto-posted
 * turn text AND the `beckett discord reply` CLI path — because whichever one fires is the ack, and
 * the thread must hang off it. Uses injected fakes (no live Discord / no claude), matching
 * `notify.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";

const CHAN = "chan-42";
const USER = "111111111111111111";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function authorize(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-progress-thread-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
}

interface Recorded {
  posts: { channelId: string; content: string; replyTo?: string }[];
  threads: { channelId: string; anchorMessageId: string; name: string }[];
  standaloneThreads: { channelId: string; name: string; id: string }[];
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
    async startStandaloneThread(channelId: string, name: string) {
      const id = `workspace-${rec.standaloneThreads.length + 1}`;
      rec.standaloneThreads.push({ channelId, name, id });
      return id;
    },
  } as never;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mention(content: string): IncomingMessage {
  return {
    messageId: "user-msg-1",
    userId: USER,
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
  authorize();
  const rec: Recorded = { posts: [], threads: [], standaloneThreads: [] };
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

  await settle();
  // Exactly one parent-channel ack, plus an activity/workspace pair.
  expect(rec.posts.filter((p) => p.channelId === CHAN)).toHaveLength(1);
  const ackId = "mid-1";
  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe(ackId);
  expect(rec.threads[0]!.channelId).toBe(CHAN);
  expect(rec.threads[0]!.name).toBe("OPS-35 · activity");
  expect(rec.standaloneThreads[0]!.name).toBe("OPS-35 · with Beckett");
});

test("a ticket filed mid-turn anchors its thread to the CLI-reply ack (no double post)", async () => {
  authorize();
  const rec: Recorded = { posts: [], threads: [], standaloneThreads: [] };
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

  await settle();
  // Only one parent-channel reply (no duplicate auto-post), and the pair anchors to THAT message.
  const parentPosts = rec.posts.filter((p) => p.channelId === CHAN);
  expect(parentPosts).toHaveLength(1);
  expect(parentPosts[0]!.replyTo).toBe("user-msg-1"); // native reply to the asker
  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe("mid-1");
  expect(rec.threads[0]!.name).toContain("OPS-36");
});

test("a plain chat turn (no ticket filed) opens no thread", async () => {
  authorize();
  const rec: Recorded = { posts: [], threads: [], standaloneThreads: [] };
  const gateway = fakeGateway(rec);
  const session = { ask: async () => "yeah that's just vite's default, you're good" } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett is port 5173 normal"));

  expect(rec.posts).toHaveLength(1); // the ack
  expect(rec.threads).toHaveLength(0); // but no work → no thread
  expect(rec.standaloneThreads).toHaveLength(0);
});

test("an unmentioned message in the human workspace is a ticket-grounded directed turn", async () => {
  authorize();
  const rec: Recorded = { posts: [], threads: [], standaloneThreads: [] };
  const gateway = fakeGateway(rec);
  const turns: string[] = [];
  let calls = 0;
  const session = {
    ask: async (turn: string) => {
      turns.push(turn);
      calls++;
      if (calls === 1) {
        await (concierge as unknown as { onBusRequest: Function }).onBusRequest({
          cmd: "ticket.filed",
          args: { identifier: "OPS-40", channelId: CHAN, title: "auth refresh" },
        });
        return "on it. OPS-40 is moving.";
      }
      return "yeah, i'll pass that constraint to the worker.";
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett fix auth refresh"));
  await settle();
  await concierge.onMessage({
    ...mention("also preserve the old refresh tokens"),
    messageId: "workspace-msg-1",
    channelId: "workspace-1",
    channelName: "OPS-40 · with Beckett",
    content: "also preserve the old refresh tokens",
    mentionsBot: false,
  });

  expect(turns).toHaveLength(2);
  expect(turns[1]).toContain("SYSTEM (ticket workspace");
  expect(turns[1]).toContain('Plane ticket(s): "OPS-40"');
  expect(turns[1]).toContain("directed to you even without an @mention");
  const reply = rec.posts.find((p) => p.content.includes("pass that constraint"));
  expect(reply).toMatchObject({ channelId: "workspace-1", replyTo: "workspace-msg-1" });

  await concierge.onMessage({
    ...mention("let me steer this too"),
    messageId: "outsider-workspace-msg",
    userId: "222222222222222222",
    channelId: "workspace-1",
    content: "let me steer this too",
    mentionsBot: false,
  });
  expect(turns).toHaveLength(2); // workspace routing does not bypass the code-level access gate
  expect(rec.posts.some((p) => p.replyTo === "outsider-workspace-msg")).toBe(true);
});
