/**
 * Live v3 Concierge access gate. The pure access library already has its own unit tests; these pin
 * the actual Discord turn path so an ungranted user cannot reach the bypassPermissions session.
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
const OUTSIDER = "222222222222222222";
const MEMBER = "333333333333333333";
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

function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-access-gate-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  delete process.env.DISCORD_OWNER_ID;
  return d;
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "msg-1",
    userId: OUTSIDER,
    channelId: CHAN,
    guildId: null,
    content: "help me ship this",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

function harness() {
  const asks: TurnMessage[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];
  const typings: string[] = [];
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
    sendTyping: async (channelId: string) => {
      typings.push(channelId);
    },
    post: async (channelId: string, text: string, o?: { replyToMessageId?: string }) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return "posted-id";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  return { concierge: new Concierge({ config, session, gateway }), asks, posts, typings };
}

test("outsider DM is denied before typing or session turn", async () => {
  tmpBeckettDir();
  const { concierge, asks, posts, typings } = harness();

  await concierge.onMessage(message());

  expect(asks).toHaveLength(0);
  expect(typings).toHaveLength(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.replyTo).toBe("msg-1");
  expect(posts[0]!.text).toContain("invite-only");
});

test("member in access.txt reaches the normal session path", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks, posts, typings } = harness();

  await concierge.onMessage(message({ userId: MEMBER, guildId: "guild-1", content: "@beckett help" }));

  expect(asks).toHaveLength(1);
  expect(typings.length).toBeGreaterThan(0);
  expect(posts).toEqual([{ channelId: CHAN, text: "ok", replyTo: "msg-1" }]);
});

// ── two-phase grant: the code-level approval intercept ────────────────────────────────────

const OWNER = "444444444444444444";
const CANDIDATE = "555555555555555555";

function fileRequest(dir: string, ownerId: string): string {
  process.env.DISCORD_OWNER_ID = ownerId;
  const r = requestGrant(join(dir, "access-pending.json"), join(dir, "access.txt"), CANDIDATE, ownerId);
  expect(r.status).toBe("pending");
  return r.code!;
}

test("owner saying `approve <code>` grants at code level — no LLM turn involved", async () => {
  const dir = tmpBeckettDir();
  const code = fileRequest(dir, OWNER);
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(message({ userId: OWNER, content: `<@1385001> approve ${code.toLowerCase()}` }));

  expect(asks).toHaveLength(0); // never reached the session
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toContain(CANDIDATE);
  expect(posts[0]!.text).toContain("is in");
  expect(loadAccess(join(dir, "access.txt")).ids.has(CANDIDATE)).toBe(true);
});

test("a MEMBER echoing the code is refused and the code survives for the owner", async () => {
  const dir = tmpBeckettDir();
  const code = fileRequest(dir, OWNER);
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(message({ userId: MEMBER, content: `approve ${code}` }));

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toContain("owner-only");
  expect(loadAccess(join(dir, "access.txt")).ids.has(CANDIDATE)).toBe(false);

  // The impostor attempt must not have burned the code — the real owner can still approve.
  await concierge.onMessage(message({ userId: OWNER, messageId: "msg-2", content: `deny ${code}` }));
  expect(posts[1]!.text).toContain("discarded");
});

test("owner mentioning approve mid-sentence is a normal LLM turn, not an approval", async () => {
  const dir = tmpBeckettDir();
  fileRequest(dir, OWNER);
  const { concierge, asks } = harness();

  await concierge.onMessage(message({ userId: OWNER, content: "should I approve BQZ2XW or not, what do you think?" }));

  expect(asks).toHaveLength(1); // fell through to the session — shape must match exactly
  expect(loadAccess(join(dir, "access.txt")).ids.has(CANDIDATE)).toBe(false);
});

test("owner approving a bogus code gets 'no pending request' and nothing is granted", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(message({ userId: OWNER, content: "approve ZZZZZZ" }));

  expect(asks).toHaveLength(0);
  expect(posts[0]!.text).toContain("no pending request");
  expect(loadAccess(join(dir, "access.txt")).ids.size).toBe(0);
});

