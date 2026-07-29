/**
 * Reaction-driven actions and react-as-ack (#103). Beckett can now be triggered by a single
 * reaction, and can acknowledge with one. Two independent guarantees are pinned here:
 *   - React to ACT: a ✅ on one of Beckett's OWN task cards runs merge, an ❌ runs cancel, routed
 *     through the SAME authorization + handler registry a button click uses (73.1) — never a copy.
 *     An unauthorized reactor causes NO side effect; an unrelated emoji or a react on someone
 *     else's message is dropped silently.
 *   - React as ACK: `discord.react` adds a reaction, and `discord.ack --emoji` acknowledges by
 *     reacting to the requester's own message instead of posting a separate "on it" line.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Concierge,
  reactionActionFor,
  reactionBranchTarget,
  type ConciergeSession,
} from "./index.ts";
import type { Config, DiscordGateway, IncomingReaction } from "../types.ts";

const CHAN = "1097283746520174592";
const BOT = "900000000000000000"; // Beckett's own bot user id
const OWNER = "222222222222222222";
const STRANGER = "111111111111111111";
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

/** A Concierge over a fake gateway; the fake records addReaction calls so acks/no-ops are provable. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-reactions-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  const reacted: Array<[string, string, string]> = [];
  const gateway = {
    onMessage() {},
    onReaction() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() { return "mid-1"; },
    botUserId: () => BOT,
    async addReaction(channelId: string, messageId: string, emoji: string) {
      reacted.push([channelId, messageId, emoji]);
    },
  } as unknown as DiscordGateway;
  const session = { async start() {}, async stop() {}, ask: async () => "" } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });
  // Replace the two branch verbs with recorders: the point is to prove ROUTING + authorization,
  // not to re-test merge/cancel mechanics (those are covered against the real registry elsewhere).
  const runs: Array<{ action: string; target: string; access: string }> = [];
  (concierge as unknown as { componentRouter: { register: (a: string, h: (c: any) => string) => unknown } }).componentRouter
    .register("merge", (ctx: any) => { runs.push({ action: "merge", target: ctx.target, access: ctx.access }); return "merged"; });
  (concierge as unknown as { componentRouter: { register: (a: string, h: (c: any) => string) => unknown } }).componentRouter
    .register("cancel", (ctx: any) => { runs.push({ action: "cancel", target: ctx.target, access: ctx.access }); return "cancelled"; });
  return { concierge, runs, reacted };
}

/** Beckett-authored task card carrying the merge/cancel controls for branch #12.1. */
function reaction(over: Partial<IncomingReaction> = {}): IncomingReaction {
  return {
    messageId: "card-1",
    channelId: CHAN,
    guildId: "guild-1",
    userId: OWNER,
    emoji: "✅",
    messageAuthorId: BOT,
    messageComponentIds: ["beckett:v1:merge:12.1", "beckett:v1:cancel:12.1", "beckett:v1:attach:12"],
    ...over,
  };
}

const fire = (concierge: Concierge, r: IncomingReaction) =>
  (concierge as unknown as { onReactionAdded: (r: IncomingReaction) => Promise<void> }).onReactionAdded(r);

// ── the emoji → action + target helpers ────────────────────────────────────────────────────────

test("reactionActionFor maps only the checkmark/cross family, tolerating the variation selector", () => {
  expect(reactionActionFor("✅")).toBe("merge");
  expect(reactionActionFor("✔️")).toBe("merge");
  expect(reactionActionFor("❌")).toBe("cancel");
  expect(reactionActionFor("✖️")).toBe("cancel");
  for (const other of ["👍", "🎉", "🤔", "", null]) expect(reactionActionFor(other)).toBeNull();
});

test("reactionBranchTarget reads the branch ref off the card's own merge/cancel controls", () => {
  expect(reactionBranchTarget(["beckett:v1:merge:12.1", "beckett:v1:attach:12"])).toBe("12.1");
  expect(reactionBranchTarget(["beckett:v1:cancel:9.2"])).toBe("9.2");
  expect(reactionBranchTarget(["beckett:v1:attach:12"])).toBeNull(); // attach carries a task #, not a branch ref
  expect(reactionBranchTarget([])).toBeNull();
});

// ── react to ACT ─────────────────────────────────────────────────────────────────────────────

test("a ✅ from the owner runs merge; an ❌ runs cancel — both through the shared registry", async () => {
  const { concierge, runs } = harness();
  await fire(concierge, reaction({ emoji: "✅" }));
  await fire(concierge, reaction({ emoji: "❌" }));
  expect(runs).toEqual([
    { action: "merge", target: "12.1", access: "owner" },
    { action: "cancel", target: "12.1", access: "owner" },
  ]);
});

test("a reaction from an unauthorized user performs NO side effect", async () => {
  const { concierge, runs } = harness();
  await fire(concierge, reaction({ userId: STRANGER }));
  expect(runs).toEqual([]); // the outsider refusal happens in the shared core before any handler
});

test("an unrelated emoji is ignored silently (no action)", async () => {
  const { concierge, runs } = harness();
  await fire(concierge, reaction({ emoji: "👍" }));
  expect(runs).toEqual([]);
});

test("a checkmark on a message Beckett did NOT author is ignored (only own task cards act)", async () => {
  const { concierge, runs } = harness();
  await fire(concierge, reaction({ messageAuthorId: STRANGER }));
  expect(runs).toEqual([]);
});

test("a checkmark on a Beckett message that is not a task card (no branch controls) is ignored", async () => {
  const { concierge, runs } = harness();
  await fire(concierge, reaction({ messageComponentIds: ["beckett:v1:attach:12"] }));
  expect(runs).toEqual([]);
});

// ── react as ACK ─────────────────────────────────────────────────────────────────────────────

test("discord.react adds one reaction to the target message", async () => {
  const { concierge, reacted } = harness();
  const res = await concierge.onBusRequest({
    cmd: "discord.react",
    args: { channelId: CHAN, messageId: "msg-1", emoji: "✅" },
  });
  expect(res.ok).toBe(true);
  expect(reacted).toEqual([[CHAN, "msg-1", "✅"]]);
});

test("discord.react rejects a call missing channel, message, or emoji before touching the gateway", async () => {
  const { concierge, reacted } = harness();
  const res = await concierge.onBusRequest({ cmd: "discord.react", args: { channelId: CHAN, emoji: "✅" } });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("needs channelId, messageId, and emoji");
  expect(reacted).toEqual([]);
});

test("discord.ack --emoji reacts to the requester's own message instead of posting an 'on it' line", async () => {
  const { concierge, reacted } = harness();
  // Stand in for the live turn this ack is answering — a directed (non-ambient) mention.
  (concierge as unknown as { issuerMention: () => unknown }).issuerMention = () => ({
    channelId: CHAN,
    messageId: "asker-msg",
    userId: OWNER,
    isOwner: true,
    repliedViaCli: false,
    ackMessageId: null,
    ambient: false,
  });
  const res = await concierge.onBusRequest({
    cmd: "discord.ack",
    args: { channelId: CHAN, emoji: "👀" },
  });
  expect(res.ok).toBe(true);
  expect(reacted).toEqual([[CHAN, "asker-msg", "👀"]]); // reacted, did NOT post
});

test("an emoji-only ack with no message to react to is rejected (nothing to react to, no text)", async () => {
  const { concierge, reacted } = harness();
  const res = await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, emoji: "👀" } });
  expect(res.ok).toBe(false);
  expect(reacted).toEqual([]);
});
