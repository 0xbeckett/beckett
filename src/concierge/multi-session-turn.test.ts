/**
 * OPS-80 §9.3 — per-channel concierge sessions, exercised through {@link Concierge.onMessage} and
 * the control bus. Pins the properties the pool exists for: two channels' turns run CONCURRENTLY
 * (no cross-channel queueing), each channel gets its own persistent session (DMs included — the
 * structural fix for model-side DM bleed), reply-claim correlation stays channel-true when several
 * turns are live at once, ticket updates route to their origin channel's session, and each
 * channel's shared-context watermark keys to ITS session's id.
 * Harness conventions copied from shared-context-turn.test.ts (tmpdir BECKETT_DIR, access.txt,
 * fake gateway, validateConfig) with a per-scope session FACTORY instead of one fixed session.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { Ticket } from "../plane/types.ts";

const CHAN_A = "1097283746520174592";
const CHAN_B = "1097283746520174599";
const OWNER = "999888777666555444";
const MEMBER = "333333333333333333";

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

function msg(id: string, content: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: id,
    userId: MEMBER,
    authorDisplayName: "Jason",
    channelId: CHAN_A,
    guildId: "guild-1",
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: Date.now(),
    attachments: [],
    ...over,
  };
}

/** A per-scope scripted session: every ask records, and resolves only when the test says so. */
interface ScriptedSession {
  scope: string;
  asks: { message: TurnMessage; meta: unknown }[];
  meta: unknown;
  finish: (reply: string) => void;
  sessionId: string;
}

function harness(opts: { deferAsks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-multisession-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

  const sessions: ScriptedSession[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];

  const sessionFactory = (scope: string): ConciergeSession => {
    let resolveTurn: ((reply: string) => void) | null = null;
    const scripted: ScriptedSession = {
      scope,
      asks: [],
      meta: null,
      sessionId: `sid-${scope}`,
      finish: (reply: string) => {
        const r = resolveTurn;
        resolveTurn = null;
        scripted.meta = null;
        r?.(reply);
      },
    };
    sessions.push(scripted);
    const fake = {
      start: async () => {},
      stop: async () => {},
      ask: (message: TurnMessage, meta?: unknown) => {
        scripted.asks.push({ message, meta });
        if (!opts.deferAsks) return Promise.resolve(`reply-from-${scope}`);
        scripted.meta = meta ?? null;
        return new Promise<string>((resolve) => {
          resolveTurn = resolve;
        });
      },
      queueDepth: () => 0,
      currentSessionId: () => scripted.sessionId,
      getCurrentMeta: () => scripted.meta,
      stats: () => ({ scope }),
      requestReload: () => {},
      recycle: () => {},
      idleMs: () => 0,
      hasLiveChild: () => true,
    };
    return fake as unknown as ConciergeSession;
  };

  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (channelId: string, text: string, o?: { replyToMessageId?: string }) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `posted-${posts.length}`;
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;

  const config = validateConfig({});
  const concierge = new Concierge({ config, sessionFactory, gateway });
  const sessionFor = (scope: string) => sessions.find((s) => s.scope === scope);
  return { concierge, sessions, posts, sessionFor, dir };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("mentions in two channels run concurrently on their own sessions and reply to their own channels", async () => {
  const h = harness({ deferAsks: true });
  const turnA = h.concierge.onMessage(msg("m-a", "how goes channel a?", { channelId: CHAN_A }));
  const turnB = h.concierge.onMessage(msg("m-b", "and channel b?", { channelId: CHAN_B }));
  await tick();

  // BOTH turns are in flight at once — the single-session era would have queued B behind A.
  const a = h.sessionFor(CHAN_A)!;
  const b = h.sessionFor(CHAN_B)!;
  expect(a.asks).toHaveLength(1);
  expect(b.asks).toHaveLength(1);

  // Resolve B FIRST: its reply posts while A is still thinking — no head-of-line blocking.
  b.finish("b is great");
  await turnB;
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]).toEqual({ channelId: CHAN_B, text: "b is great", replyTo: "m-b" });

  a.finish("a is fine too");
  await turnA;
  expect(h.posts[1]).toEqual({ channelId: CHAN_A, text: "a is fine too", replyTo: "m-a" });
});

test("a DM gets its own session, separate from any guild channel's", async () => {
  const h = harness();
  await h.concierge.onMessage(msg("m-dm", "psst, just us", { channelId: "3097", guildId: null }));
  await h.concierge.onMessage(msg("m-g", "public question", { channelId: CHAN_A }));
  expect(h.sessionFor("3097")!.asks).toHaveLength(1);
  expect(h.sessionFor(CHAN_A)!.asks).toHaveLength(1);
  expect(h.sessions).toHaveLength(2);
});

test("discord.reply claims the turn in ITS channel even with two turns live", async () => {
  const h = harness({ deferAsks: true });
  const turnA = h.concierge.onMessage(msg("m-a", "channel a asks", { channelId: CHAN_A }));
  const turnB = h.concierge.onMessage(msg("m-b", "channel b asks", { channelId: CHAN_B }));
  await tick();

  // The model answering channel B replies via the CLI while A's turn is ALSO live.
  const res = await h.concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN_B, text: "cli reply for b" },
  });
  expect(res.ok).toBeTrue();
  expect(h.posts).toHaveLength(1);
  // Claimed B's turn: posted as a native reply to B's message, not A's.
  expect(h.posts[0]!.channelId).toBe(CHAN_B);
  expect(h.posts[0]!.replyTo).toBe("m-b");

  // B's turn text is suppressed (already replied via CLI); A's auto-post still fires.
  h.sessionFor(CHAN_B)!.finish("unused draft");
  await turnB;
  expect(h.posts).toHaveLength(1);
  h.sessionFor(CHAN_A)!.finish("a's answer");
  await turnA;
  expect(h.posts[2] ?? h.posts[1]).toEqual({ channelId: CHAN_A, text: "a's answer", replyTo: "m-a" });
});

test("proactivity set auto stays owner-gated when several turns are live (no channel match → denied)", async () => {
  const h = harness({ deferAsks: true });
  void h.concierge.onMessage(msg("m-a", "owner here", { channelId: CHAN_A, userId: OWNER }));
  void h.concierge.onMessage(msg("m-b", "member here", { channelId: CHAN_B }));
  await tick();

  // Two live turns, target channel has no live turn → ambiguous → denied (never guesses).
  const denied = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "7777", mode: "auto" },
  });
  expect(denied.ok).toBeFalse();
  expect(denied.error).toContain("owner-only");

  // Owner's own live channel as the target → the claimant is the owner's turn → allowed.
  const allowed = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: CHAN_A, mode: "auto" },
  });
  expect(allowed.ok).toBeTrue();
  h.sessionFor(CHAN_A)!.finish("");
  h.sessionFor(CHAN_B)!.finish("");
});

test("ticket updates route to their origin channel's session, grouped per channel", async () => {
  const h = harness();
  const ticket = (id: string, channel: string): Ticket =>
    ({
      id,
      identifier: id,
      title: `work ${id}`,
      description: "",
      body: "",
      casting: {},
      criteria: [],
      state: "in_progress",
      url: "",
      originChannel: channel,
    }) as unknown as Ticket;

  h.concierge.notify([
    { kind: "cancelled", ticket: ticket("OPS-1", CHAN_A) },
    { kind: "cancelled", ticket: ticket("OPS-2", CHAN_A) },
    { kind: "cancelled", ticket: ticket("OPS-3", CHAN_B) },
  ]);
  await tick();
  await tick();

  const a = h.sessionFor(CHAN_A)!;
  const b = h.sessionFor(CHAN_B)!;
  // A's two updates folded into ONE turn on A's session; B's went to B's session.
  expect(a.asks).toHaveLength(1);
  expect(String(a.asks[0]!.message)).toContain("OPS-1");
  expect(String(a.asks[0]!.message)).toContain("OPS-2");
  expect(b.asks).toHaveLength(1);
  expect(String(b.asks[0]!.message)).toContain("OPS-3");
});

test("each channel's shared-context watermark keys to that channel's own sessionId", async () => {
  const h = harness();
  // Ambient lines land in both channels' stored windows.
  await h.concierge.onMessage(msg("amb-a", "background chatter a", { channelId: CHAN_A, mentionsBot: false }));
  await h.concierge.onMessage(msg("amb-b", "background chatter b", { channelId: CHAN_B, mentionsBot: false }));
  // A mention in A consumes A's unseen window (keyed to sid-A); B's stays unconsumed.
  await h.concierge.onMessage(msg("m-a", "so?", { channelId: CHAN_A }));
  const turnA = String(h.sessionFor(CHAN_A)!.asks[0]!.message);
  expect(turnA).toContain("background chatter a");
  expect(turnA).not.toContain("background chatter b");
  // B's first mention still sees B's backlog — untouched by A's consumption.
  await h.concierge.onMessage(msg("m-b", "and here?", { channelId: CHAN_B }));
  const turnB = String(h.sessionFor(CHAN_B)!.asks[0]!.message);
  expect(turnB).toContain("background chatter b");
  expect(turnB).not.toContain("background chatter a");
});
