/**
 * Regression for the duplicate-Discord-message bug. On a direct @mention the Concierge has two
 * ways to reach the human: (a) the turn's return text, which `onMessage` auto-posts as a native
 * reply, and (b) running `beckett discord reply` from its Bash tool, which routes through
 * `onBusRequest`. The bug was both firing for ONE turn → the person got the same answer twice.
 * These pin the dedup: when the Concierge answers a live @mention via the CLI, that becomes THE
 * reply (native, once) and the auto-post is suppressed; when it doesn't, the auto-post is the reply.
 */

import { expect, test } from "bun:test";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const MSG = "msg-42";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

/**
 * Build a Concierge whose session, when it runs a turn, optionally simulates the Concierge
 * answering via `beckett discord reply` (the bus path) before returning its turn text.
 */
function harness(opts: { replyViaCli: boolean; turnText: string; cliText?: string }) {
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
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
  return { concierge, posts };
}

function mention(): IncomingMessage {
  return {
    messageId: MSG,
    channelId: CHAN,
    content: "@beckett where my site at",
    mentionsBot: true,
  } as unknown as IncomingMessage;
}

test("answers via CLI → exactly one post, native reply, no auto-post duplicate", async () => {
  const { concierge, posts } = harness({ replyViaCli: true, turnText: "the turn text", cliText: "the cli answer" });
  await concierge.onMessage(mention());
  // Only the CLI reply lands — once — and it's a NATIVE reply to the @mention (not a bare post).
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "the cli answer", replyTo: MSG });
});

test("answers normally (no CLI) → the turn text is auto-posted once as a native reply", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "just the turn text" });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "just the turn text", replyTo: MSG });
});

test("a CLI reply OUTSIDE any live @mention turn posts plainly (proactive update path)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  // No @mention in flight (this models notify()'s update turn) → plain post, no reply-bar.
  await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "shipped it" } });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "shipped it", replyTo: undefined });
});
