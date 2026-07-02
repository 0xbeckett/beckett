/**
 * OPS-59 — thread-native steering. Pins the load-bearing gate in `Concierge.onMessage`:
 *   - a message in a Beckett-created thread is handled as if @mentioned (no ping required)
 *   - ONLY Beckett's own threads bypass; arbitrary threads / the parent channel do not
 *   - the access model is unchanged — only access.txt members + owner trip the worker here
 *   - bot / self messages never engage (no self-loops)
 *   - a live-worker thread frames the turn as steering via `beckett ticket comment`; a parked/done
 *     thread frames it as a plain in-thread reply
 *   - a cooled (terminal) thread stops auto-triggering
 * Real access.txt + a real ThreadRegistry are used (not mocked) so the guardrails are exercised end
 * to end, against an injected fake session/gateway.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { ThreadRegistry } from "../discord/threads.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const THREAD = "thread-1";
const PARENT = "parent-chan";
const TICKET_ID = "uuid-ticket-1";
const OWNER = "111";
const MEMBER = "222";
const OUTSIDER = "999";

let dir: string;
let savedDir: string | undefined;
let savedOwner: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-ts-"));
  savedDir = process.env.BECKETT_DIR;
  savedOwner = process.env.DISCORD_OWNER_ID;
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  rmSync(dir, { recursive: true, force: true });
});

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

interface Post {
  channelId: string;
  text: string;
}

function harness(opts: { workerLive?: boolean; registerThread?: boolean; terminal?: boolean } = {}) {
  const asks: string[] = [];
  const posts: Post[] = [];
  const session = {
    async start() {},
    async stop() {},
    ask: async (m: string) => {
      asks.push(m);
      return ""; // concierge relays via CLI; return text unused here
    },
  } as unknown as ConciergeSession;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string) {
      posts.push({ channelId, text });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;

  const threads = new ThreadRegistry(join(dir, "threads.json"));
  if (opts.registerThread !== false) {
    threads.register({
      threadId: THREAD,
      ticketId: TICKET_ID,
      ticketIdentifier: "OPS-59",
      parentChannelId: PARENT,
    });
    if (opts.terminal) threads.markTerminalByTicket(TICKET_ID);
  }

  const concierge = new Concierge({
    config,
    session,
    gateway,
    threads,
    workerLive: () => opts.workerLive ?? false,
  });
  return { concierge, asks, posts, threads };
}

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "m1",
    userId: MEMBER,
    channelId: THREAD,
    parentId: PARENT,
    guildId: "g1",
    content: "bump the padding to 20px",
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
    ...over,
  } as IncomingMessage;
}

test("a member's message in a Beckett thread engages WITHOUT an @mention", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg());
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("bump the padding to 20px");
});

test("live worker → the turn is framed as steering via `beckett ticket comment <id>`", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg());
  expect(asks[0]).toContain(`beckett ticket comment ${TICKET_ID}`);
  expect(asks[0]).toContain("safe boundary");
});

test("no live worker → framed as a plain in-thread reply, not steering", async () => {
  const { concierge, asks } = harness({ workerLive: false });
  await concierge.onMessage(msg());
  expect(asks).toHaveLength(1);
  expect(asks[0]).not.toContain("beckett ticket comment");
  expect(asks[0]!.toLowerCase()).toContain("conversationally");
});

test("access unchanged: an OUTSIDER in the thread is ignored (no new access granted)", async () => {
  const { concierge, asks, posts } = harness({ workerLive: true });
  await concierge.onMessage(msg({ userId: OUTSIDER }));
  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("the owner is allowed in the thread even when not in access.txt", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg({ userId: OWNER }));
  expect(asks).toHaveLength(1);
});

test("bot / self messages never engage (no self-loops)", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg({ authorIsBot: true }));
  expect(asks).toHaveLength(0);
});

test("ONLY Beckett threads bypass — an unknown thread stays mention-gated", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg({ channelId: "some-other-thread" }));
  expect(asks).toHaveLength(0);
});

test("the parent channel is never treated as a work thread", async () => {
  const { concierge, asks } = harness({ workerLive: true });
  await concierge.onMessage(msg({ channelId: PARENT }));
  expect(asks).toHaveLength(0);
});

test("a cooled (terminal) thread stops auto-triggering (goes cold)", async () => {
  const { concierge, asks } = harness({ workerLive: true, terminal: true });
  await concierge.onMessage(msg());
  expect(asks).toHaveLength(0);
});

test("an explicit @mention in a Beckett thread still works (mention path, no access gate)", async () => {
  // Even an outsider's @mention goes through the normal mention path (the LLM gatekeeps there),
  // exactly as anywhere else — the thread widening only adds the no-mention bypass, it removes nothing.
  const { concierge, asks } = harness({ workerLive: false });
  await concierge.onMessage(msg({ userId: OUTSIDER, mentionsBot: true }));
  expect(asks).toHaveLength(1);
  // Mention path → normal turn framing, not the thread-steering directive.
  expect(asks[0]).not.toContain("work-thread steering");
});
