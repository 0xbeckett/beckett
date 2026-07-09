/**
 * Regression for the duplicate-Discord-message bug. On a direct @mention the Concierge has two
 * ways to reach the human: (a) the turn's return text, which `onMessage` auto-posts as a native
 * reply, and (b) running `beckett discord reply` from its Bash tool, which routes through
 * `onBusRequest`. The bug was both firing for ONE turn → the person got the same answer twice.
 * These pin the dedup: when the Concierge answers a live @mention via the CLI, that becomes THE
 * reply (native, once) and the auto-post is suppressed; when it doesn't, the auto-post is the reply.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { callBus, ControlBusTimeoutError, serveBus } from "../shell/control-bus.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const MSG = "msg-42";
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

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
  files?: string[];
}

/**
 * Build a Concierge whose session, when it runs a turn, optionally simulates the Concierge
 * answering via `beckett discord reply` (the bus path) before returning its turn text.
 */
function harness(opts: { replyViaCli: boolean; turnText: string; cliText?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string; files?: string[] }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId, files: o?.files });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;

  // Late-bound so the fake session can call back into the Concierge's bus handler mid-turn.
  let concierge!: Concierge;
  const session = {
    async start() {},
    async stop() {},
    ask: async (_m: string) => {
      if (opts.replyViaCli) {
        await concierge.onBusRequest({
          cmd: "discord.reply",
          args: { channelId: CHAN, text: opts.cliText ?? "via cli" },
        });
      }
      return opts.turnText;
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config, session, gateway });
  return { concierge, posts, dir };
}

function mention(): IncomingMessage {
  return {
    messageId: MSG,
    userId: USER,
    channelId: CHAN,
    content: "@beckett where my site at",
    mentionsBot: true,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("answers via CLI → exactly one post, native reply, no auto-post duplicate", async () => {
  const { concierge, posts } = harness({ replyViaCli: true, turnText: "the turn text", cliText: "the cli answer" });
  await concierge.onMessage(mention());
  // Only the CLI reply lands — once — and it's a NATIVE reply to the @mention (not a bare post).
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "the cli answer", replyTo: MSG, files: undefined });
});

test("answers normally (no CLI) → the turn text is auto-posted once as a native reply", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "just the turn text" });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "just the turn text", replyTo: MSG, files: undefined });
});

test("a CLI reply OUTSIDE any live @mention turn posts plainly (proactive update path)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  // No @mention in flight (this models notify()'s update turn) → plain post, no reply-bar.
  await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "shipped it" } });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "shipped it", replyTo: undefined, files: undefined });
});

test("discord.reply forwards files and permits image-only posts", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN, text: "", files: ["/tmp/logo.png"] },
  });
  expect(posts).toEqual([{ channelId: CHAN, text: "", replyTo: undefined, files: ["/tmp/logo.png"] }]);
});

test("a send that succeeds before its bus ack times out is not posted again on retry", async () => {
  const { concierge, posts, dir } = harness({ replyViaCli: false, turnText: "" });
  const socket = join(dir, "control.sock");
  let first = true;
  let releaseFirstAck!: () => void;
  let ackIsWaiting!: () => void;
  const waitingForAck = new Promise<void>((resolve) => { ackIsWaiting = resolve; });
  const stop = serveBus(socket, async (req) => {
    const response = await concierge.onBusRequest(req);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        releaseFirstAck = resolve;
        ackIsWaiting();
      });
    }
    return response;
  });

  try {
    // The fake Discord gateway resolves immediately (the post exists), while the control-bus
    // response is deliberately held past the caller's deadline.
    const firstAttempt = callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 10);
    await waitingForAck;
    await expect(firstAttempt).rejects.toBeInstanceOf(ControlBusTimeoutError);
    expect(posts).toHaveLength(1);

    releaseFirstAck();
    const retry = await callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 100);
    expect(retry.ok).toBeTrue();
    expect(posts).toHaveLength(1);
  } finally {
    stop();
  }
});
