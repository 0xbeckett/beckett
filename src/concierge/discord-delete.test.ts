/**
 * `beckett discord delete` control-bus command (issue #35). Beckett can post and edit but had no
 * way to delete a message it posted, so debugging litter had to be cleaned up by hand. This is a
 * thin bus surface over the gateway's already-proven `deleteMessage`. The ONE guardrail that
 * matters: only ever delete a message Beckett itself authored — a verb that could delete anyone's
 * message is a moderation tool, which this is not. These pin that contract at the bus handler:
 *   - happy path: a Beckett-authored message is deleted and a one-line confirmation comes back;
 *   - refusal: a message someone else wrote is NEVER deletable — refused loudly, nothing deleted;
 *   - a message that is already gone fails clearly, and neither failure throws.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const BOT = "900000000000000000"; // Beckett's own bot user id
const SOMEONE_ELSE = "111111111111111111";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A Concierge over a fake gateway whose messages carry an author id (or are absent → "gone"). The
 * fake records every deleteMessage call so a refusal can be proven to have deleted NOTHING.
 */
function harness(authors: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-discord-delete-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const deleted: Array<[string, string]> = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    botUserId: () => BOT,
    async fetchMessageAuthorId(_channelId: string, messageId: string) {
      return authors[messageId] ?? null; // absent id → message no longer exists
    },
    async deleteMessage(channelId: string, messageId: string) {
      deleted.push([channelId, messageId]);
    },
  } as unknown as DiscordGateway;
  const session = { async start() {}, async stop() {}, ask: async () => "" } as unknown as ConciergeSession;
  return { concierge: new Concierge({ config, session, gateway }), deleted };
}

test("happy path: a Beckett-authored message is deleted with a one-line confirmation", async () => {
  const { concierge, deleted } = harness({ "msg-mine": BOT });
  const res = await concierge.onBusRequest({ cmd: "discord.delete", args: { channelId: CHAN, messageId: "msg-mine" } });
  expect(res.ok).toBe(true);
  expect(res.data).toBe(`deleted message msg-mine in channel ${CHAN}`);
  expect(typeof res.data).toBe("string"); // a single confirmation line, not a blob
  expect(deleted).toEqual([[CHAN, "msg-mine"]]);
});

test("refusal: a message someone else wrote is refused loudly and NOT deleted", async () => {
  const { concierge, deleted } = harness({ "msg-theirs": SOMEONE_ELSE });
  const res = await concierge.onBusRequest({ cmd: "discord.delete", args: { channelId: CHAN, messageId: "msg-theirs" } });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("not authored by Beckett");
  expect(deleted).toEqual([]); // the refusal is the feature: nothing was deleted
});

test("a message that is already gone fails clearly, without deleting or throwing", async () => {
  const { concierge, deleted } = harness({});
  const res = await concierge.onBusRequest({ cmd: "discord.delete", args: { channelId: CHAN, messageId: "ghost" } });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("not found");
  expect(deleted).toEqual([]);
});

test("missing channelId or messageId is rejected before any gateway call", async () => {
  const { concierge, deleted } = harness({ "msg-mine": BOT });
  const res = await concierge.onBusRequest({ cmd: "discord.delete", args: { messageId: "msg-mine" } });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("needs channelId and messageId");
  expect(deleted).toEqual([]);
});
