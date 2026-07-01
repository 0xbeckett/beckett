/**
 * OPS-42 — the identity stamp on a live Discord turn, exercised through {@link Concierge.onMessage}.
 * Verifies the speaker's user id + address reach the model turn, that a stored preferred_address is
 * honored, that the env owner is tagged (and only for their id), and that two ids in one channel
 * read as two people.
 */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { upsertIdentity } from "../discord/identity.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const OWNER = "999888777666555444";
const ALICE = "222222222222222222";
const BOB = "333333333333333333";

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
  const d = mkdtempSync(join(tmpdir(), "beckett-identity-turn-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  return d;
}

function config(): Config {
  return { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;
}

function fakeSession(asks: TurnMessage[]): ConciergeSession {
  return {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return "ok";
    },
  } as unknown as ConciergeSession;
}

function fakeGateway(): DiscordGateway {
  return {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async () => "posted-id",
    isConnected: () => true,
  } as unknown as DiscordGateway;
}

function message(over: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: "msg-1",
    userId: ALICE,
    channelId: CHAN,
    guildId: "g",
    content: "hey",
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

test("turn stamp carries the speaker's user id, display name, and the message id", async () => {
  tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = ALICE;
  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway() });
  await c.onMessage(message({ userId: ALICE, authorDisplayName: "alice", messageId: "m9" }));
  expect(stamp(asks[0]!)).toBe(`[channel:${CHAN}] [user:${ALICE} display:"alice" role:owner msg:m9]\nhey`);
});

test("a stored preferred_address is honored on later turns", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = ALICE;
  upsertIdentity(join(dir, "identities.json"), ALICE, { preferred_address: "Sam" });
  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway() });
  await c.onMessage(message({ userId: ALICE, authorDisplayName: "alice" }));
  // address:"Sam" wins; the differing live display name is still surfaced.
  expect(stamp(asks[0]!)).toContain(`user:${ALICE} address:"Sam" display:"alice"`);
});

test("the env owner id is tagged role:owner; a different id in the same channel is not", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  writeFileSync(join(dir, "access.txt"), `${BOB}\n`, "utf8");
  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway() });

  await c.onMessage(message({ userId: OWNER, authorDisplayName: "jase", messageId: "m1" }));
  await c.onMessage(message({ userId: BOB, authorDisplayName: "bob", messageId: "m2" }));

  expect(stamp(asks[0]!)).toContain(`user:${OWNER}`);
  expect(stamp(asks[0]!)).toContain("role:owner");
  // Same channel, different id → different person, and NOT the owner.
  expect(stamp(asks[1]!)).toContain(`user:${BOB}`);
  expect(stamp(asks[1]!)).not.toContain("role:owner");
});
