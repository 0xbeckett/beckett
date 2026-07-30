/**
 * #140 — trusted peer Beckett handling on the live Concierge turn path (`Concierge.onMessage`).
 *
 * Proves the four things the primitive alone couldn't: a peer arrives explicitly stamped `role:peer`
 * with its bot id + display name; it is authorized strictly below a non-owner human (converse yes,
 * queue work no — an access grant on its say-so is code-refused); a peer that doesn't address
 * Beckett gets no reply; and a two-bot exchange provably terminates at the consecutive-turn cap.
 * The empty-peer-list / human path is exercised (unchanged) by identity-turn.test.ts and access.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import { loadAccess, requestGrant } from "../discord/access.ts";

const CHAN = "1097283746520174592";
const OWNER = "444444444444444444";
const MEMBER = "333333333333333333";
const PEER = "1527859594741682347"; // Beckett [DEV]
const PEER_NAME = "Beckett [DEV]";
const CANDIDATE = "555555555555555555";

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

function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-federation-turn-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  delete process.env.DISCORD_OWNER_ID;
  return d;
}

/** A Config with an optional federation block (the schema default cap is 6 when omitted). */
function config(peerCap?: number): Config {
  const federation =
    peerCap === undefined ? undefined : { peers: [], peer_burst_per_min: 5, peer_max_consecutive_turns: peerCap };
  return { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {}, ...(federation ? { federation } : {}) } as unknown as Config;
}

function harness(cfg: Config = config()) {
  const asks: TurnMessage[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];
  const session = {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return "ok";
    },
  } as unknown as ConciergeSession;
  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (channelId: string, text: string, o?: { replyToMessageId?: string }) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return "posted-id";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  return { concierge: new Concierge({ config: cfg, session, gateway }), asks, posts };
}

function peerMessage(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "pmsg-1",
    userId: PEER,
    authorDisplayName: PEER_NAME,
    channelId: CHAN,
    guildId: "guild-1",
    content: "@beckett how's staging looking?",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: true,
    peer: { botId: PEER, displayName: PEER_NAME },
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

function humanMessage(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "hmsg-1",
    userId: MEMBER,
    authorDisplayName: "mabel",
    channelId: CHAN,
    guildId: "guild-1",
    content: "@beckett hey",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

function stamp(turn: TurnMessage): string {
  return typeof turn === "string" ? turn : "";
}

test("an addressing peer reaches the session stamped role:peer with its bot id and display name", async () => {
  tmpBeckettDir();
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(peerMessage({ messageId: "m9" }));

  expect(asks).toHaveLength(1);
  const s = stamp(asks[0]!);
  expect(s).toContain(`user:${PEER}`);
  expect(s).toContain(`display:${JSON.stringify(PEER_NAME)}`);
  expect(s).toContain("role:peer");
  // Distinguishable from a human and from an authority stamp: never owner/maintainer.
  expect(s).not.toContain("role:owner");
  expect(s).not.toContain("role:maintainer");
  // Conversation is allowed — the peer clears the invite-only gate and gets a reply.
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toBe("ok");
});

test("a peer is authorized below a human: it converses but a member's turn carries no peer stamp", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks } = harness();

  await concierge.onMessage(peerMessage({ messageId: "p1" }));
  await concierge.onMessage(humanMessage({ messageId: "h1" }));

  expect(asks).toHaveLength(2);
  expect(stamp(asks[0]!)).toContain("role:peer");
  // A real member in the same channel reads as a different, higher tier — no peer stamp on them.
  expect(stamp(asks[1]!)).toContain(`user:${MEMBER}`);
  expect(stamp(asks[1]!)).not.toContain("role:peer");
});

test("an access grant on a peer's say-so is code-refused (owner-only), and nothing is granted", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  const r = requestGrant(join(dir, "access-pending.json"), join(dir, "access.txt"), CANDIDATE, OWNER);
  expect(r.status).toBe("pending");
  const code = r.code!;
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(peerMessage({ messageId: "p1", content: `approve ${code}` }));

  expect(asks).toHaveLength(0); // never reached the LLM
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toContain("owner-only");
  expect(loadAccess(join(dir, "access.txt")).ids.has(CANDIDATE)).toBe(false);
});

test("a peer that does not address Beckett produces no reply", async () => {
  tmpBeckettDir();
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(
    peerMessage({ messageId: "p1", mentionsBot: false, content: "just thinking out loud over here" }),
  );

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("consecutive peer-to-peer turns are capped so a two-bot exchange provably terminates", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8"); // so the human's own turn runs
  const { concierge, asks, posts } = harness(config(2)); // cap of 2 consecutive peer turns

  // A ping-pong with no human in between: distinct message ids so nothing dedups.
  await concierge.onMessage(peerMessage({ messageId: "p1" }));
  await concierge.onMessage(peerMessage({ messageId: "p2" }));
  await concierge.onMessage(peerMessage({ messageId: "p3" }));
  await concierge.onMessage(peerMessage({ messageId: "p4" }));

  // Only the first two were answered; the exchange terminated at the cap.
  expect(asks).toHaveLength(2);
  expect(posts).toHaveLength(2);

  // A human speaking resets the budget — the peer can be answered again afterward.
  await concierge.onMessage(humanMessage({ messageId: "h1" }));
  await concierge.onMessage(peerMessage({ messageId: "p5" }));
  expect(asks).toHaveLength(4); // human turn + the re-opened peer turn
});
