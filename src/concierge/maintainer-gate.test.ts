/**
 * Live Concierge maintainer gate (OPS-144). The pure library has its own tests
 * (src/discord/maintainers.test.ts); these pin the Discord turn path:
 *   - a maintainer passes the invite-only gate and their turn is stamped `role:maintainer`
 *     (the code-checked signal the doctrine trusts for push/merge/deploy/restart),
 *   - a plain member is NOT stamped and an outsider is denied,
 *   - the `approve <code>` intercept applies a maintainer grant for the owner only — a
 *     maintainer echoing the code is refused and elevates nobody.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import { loadMaintainers, requestMaintainerGrant } from "../discord/maintainers.ts";

const CHAN = "1097283746520174592";
const OWNER = "444444444444444444";
const MAINTAINER = "666666666666666666";
const MEMBER = "333333333333333333";
const OUTSIDER = "222222222222222222";
const CANDIDATE = "555555555555555555";
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

/** A BECKETT_DIR with MAINTAINER in the runtime maintainers.txt and MEMBER in access.txt. */
function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-maintainer-gate-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  process.env.DISCORD_OWNER_ID = OWNER;
  writeFileSync(join(d, "maintainers.txt"), `${MAINTAINER}\n`, "utf8");
  writeFileSync(join(d, "access.txt"), `${MEMBER}\n`, "utf8");
  return d;
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "msg-1",
    userId: MAINTAINER,
    channelId: CHAN,
    guildId: "guild-1",
    content: "@beckett merge that PR",
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
  return { concierge: new Concierge({ config, session, gateway }), asks, posts };
}

/** The first stamp line of a framed turn. */
function stamp(turn: TurnMessage): string {
  const text = typeof turn === "string" ? turn : turn.map((b) => ("text" in b ? b.text : "")).join("\n");
  return text.split("\n").find((l) => l.includes("[channel:")) ?? "";
}

test("a maintainer's turn reaches the session stamped role:maintainer", async () => {
  tmpBeckettDir();
  const { concierge, asks } = harness();

  await concierge.onMessage(message());

  expect(asks).toHaveLength(1);
  expect(stamp(asks[0]!)).toContain(`user:${MAINTAINER}`);
  expect(stamp(asks[0]!)).toContain("role:maintainer");
  expect(stamp(asks[0]!)).not.toContain("role:owner");
});

test("a plain member is not stamped role:maintainer; the owner stays role:owner", async () => {
  tmpBeckettDir();
  const { concierge, asks } = harness();

  await concierge.onMessage(message({ userId: MEMBER, messageId: "m-member" }));
  await concierge.onMessage(message({ userId: OWNER, messageId: "m-owner" }));

  expect(asks).toHaveLength(2);
  expect(stamp(asks[0]!)).not.toContain("role:maintainer");
  expect(stamp(asks[1]!)).toContain("role:owner");
  expect(stamp(asks[1]!)).not.toContain("role:maintainer");
});

test("a non-maintainer outsider is denied before any session turn", async () => {
  tmpBeckettDir();
  const { concierge, asks, posts } = harness();

  await concierge.onMessage(message({ userId: OUTSIDER }));

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toContain("invite-only");
});

test("a maintainer echoing a maintainer-grant code is refused; only the owner lands it", async () => {
  const dir = tmpBeckettDir();
  const pendingFile = join(dir, "maintainers-pending.json");
  const runtimeFile = join(dir, "maintainers.txt");
  const code = requestMaintainerGrant(pendingFile, runtimeFile, CANDIDATE, OWNER).code!;
  const { concierge, asks, posts } = harness();

  // An existing maintainer trying to add a peer: flat refusal, nobody elevated, code intact.
  await concierge.onMessage(message({ content: `approve ${code}` }));
  expect(asks).toHaveLength(0);
  expect(posts[0]!.text).toContain("owner-only");
  expect(loadMaintainers(runtimeFile).has(CANDIDATE)).toBe(false);

  // The surviving code works for the real owner, and the reply names the maintainer role.
  await concierge.onMessage(message({ userId: OWNER, messageId: "msg-2", content: `approve ${code}` }));
  expect(asks).toHaveLength(0);
  expect(posts[1]!.text).toContain("maintainer");
  expect(loadMaintainers(runtimeFile).has(CANDIDATE)).toBe(true);
});
