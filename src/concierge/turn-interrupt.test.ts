/**
 * Issue #117 — in-flight turn interrupt / steer / amend. A same-channel message arriving while a
 * turn is still generating must cancel that (now stale) turn and be answered as the next turn,
 * instead of the stale reply posting and the correction running as a separate full turn minutes
 * later. Pins the three layers of the cancel-and-restart path:
 *   1. ConciergeSession.cancelLiveTurn  — clean cancel of the live child + silent-pass resolve
 *   2. SessionPool.cancelLiveTurn       — channel-scoped guard (never cancels another channel)
 *   3. Concierge.onMessage              — supersede-and-answer wiring end to end
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, ConciergeSession } from "./index.ts";
import { SessionPool, type PoolSession } from "./session-pool.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { DiscordTurnOutput } from "./output.ts";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {}, harness: { claude: { bin: "claude", extra_flags: [] } } } as unknown as Config;

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

function tempBeckettDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-interrupt-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

// ── 1. ConciergeSession.cancelLiveTurn ────────────────────────────────────────────────────

interface SessionGuts {
  child: unknown;
  pending: {
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
    timedOut: boolean;
    resolve: (output: unknown) => void;
    reject: (error: Error) => void;
  } | null;
  cancelLiveTurn(reason: string): boolean;
}

function makeSession(): SessionGuts {
  return new ConciergeSession({ config, logger: quietLog }) as unknown as SessionGuts;
}

test("cancelLiveTurn stops the live child and resolves the in-flight ask as a silent pass", () => {
  tempBeckettDir();
  const s = makeSession();
  let killed = false;
  const child = { kill() { killed = true; } };
  let delivered: unknown;
  s.child = child;
  s.pending = {
    parts: ["half of a now-stale answer"],
    timer: setTimeout(() => undefined, 60_000),
    timedOut: false,
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  const cancelled = s.cancelLiveTurn("superseded by same-channel message");

  expect(cancelled).toBe(true);
  expect(killed).toBe(true); // the doomed generation is stopped, not left to finish minutes later
  expect(s.child).toBeNull(); // child recycled; the session id survives so the next ask() --resumes
  expect(s.pending).toBeNull();
  // A silent pass — never the stale half-answer, never an error bubble.
  expect(delivered).toEqual({ decision: "pass", message: null });
});

test("cancelLiveTurn is a no-op when no turn is live (normal path untouched)", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = null;
  let killed = false;
  s.child = { kill() { killed = true; } };
  expect(s.cancelLiveTurn("nothing to cancel")).toBe(false);
  expect(killed).toBe(false); // an idle session's child is not touched
  expect(s.child).not.toBeNull();
});

// ── 2. SessionPool.cancelLiveTurn — channel-scoped guard ──────────────────────────────────

interface FakePoolSession extends PoolSession {
  cancels: string[];
  meta: unknown;
}

function fakePoolSession(scope: string): FakePoolSession {
  const s: FakePoolSession = {
    cancels: [],
    meta: null,
    start: async () => {},
    stop: async () => {},
    ask: () => Promise.resolve(`reply:${scope}`),
    getCurrentMeta: () => s.meta,
    hasLiveChild: () => true,
    cancelLiveTurn: (reason: string) => {
      s.cancels.push(reason);
      return true;
    },
  };
  return s;
}

function poolWith(made: FakePoolSession[]): SessionPool {
  return new SessionPool({
    scope: "channel",
    maxLiveSessions: 6,
    idleRecycleMs: 0,
    makeSession: (scope) => {
      const s = fakePoolSession(scope);
      made.push(s);
      return s;
    },
  });
}

test("pool cancelLiveTurn cancels a live directed turn for the matching channel", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi"); // creates + starts chan-a's session
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-1" }; // a directed turn is live on chan-a

  expect(p.cancelLiveTurn("chan-a", "superseded")).toBe(true);
  expect(chanA.cancels).toEqual(["superseded"]);
});

test("pool cancelLiveTurn never cancels a turn belonging to another channel or a system turn", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;

  // A system/update turn (no channel meta) is never superseded.
  chanA.meta = null;
  expect(p.cancelLiveTurn("chan-a", "x")).toBe(false);

  // Belt-and-suspenders for collapsed modes: a live turn for a different channel is left alone.
  chanA.meta = { channelId: "chan-OTHER", messageId: "m-9" };
  expect(p.cancelLiveTurn("chan-a", "x")).toBe(false);

  // An unknown channel (no session) is a clean no-op.
  expect(p.cancelLiveTurn("chan-none", "x")).toBe(false);
  expect(chanA.cancels).toEqual([]);
});

// ── 3. Concierge.onMessage — supersede-and-answer end to end ──────────────────────────────

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

function conciergeHarness(session: Partial<ConciergeSession> & Record<string, unknown>) {
  tempBeckettDir();
  process.env.DISCORD_OWNER_ID = "111111111111111111";
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
  const concierge = new Concierge({ config, gateway, session: session as unknown as ConciergeSession });
  return { concierge, posts };
}

function msg(channelId: string, messageId: string): IncomingMessage {
  return {
    channelId,
    messageId,
    userId: "111111111111111111",
    displayName: "jason",
    content: "wait, actually — do it the other way",
    mentionsBot: true,
    guildId: null,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("a same-channel message mid-turn cancels the stale turn and answers the correction (issue #117)", async () => {
  // A stateful fake session: the first turn hangs as "still generating" until cancelLiveTurn
  // fires (resolving it as a silent pass); the amending turn answers normally.
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (live ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    cancelLiveTurn(_reason: string) {
      if (!live) return false;
      const l = live;
      live = null;
      l.resolve({ decision: "pass", message: null }); // silent pass — the stale reply never posts
      return true;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => { live = { resolve, meta }; });
      }
      return Promise.resolve({ decision: "send", message: "amended answer" });
    },
  };
  const { concierge, posts } = conciergeHarness(session);

  const first = concierge.onMessage(msg("chan-1", "m-1"));
  await new Promise((r) => setTimeout(r, 20)); // let the first turn reach ask() and go live
  expect(live).not.toBeNull();

  await concierge.onMessage(msg("chan-1", "m-2")); // the correction supersedes the stale turn
  await first;

  // Exactly one post — the correction's answer. The stale first turn posted nothing.
  expect(posts.map((p) => p.text)).toEqual(["amended answer"]);
  expect(posts[0]!.replyTo).toBe("m-2");
  expect(asks).toBe(2);
});

test("a lone mention on an idle channel is answered normally (no interruption path)", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null, // nothing live → cancelLiveTurn is a no-op
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  expect(posts.map((p) => p.text)).toEqual(["the answer"]);
  expect(posts[0]!.replyTo).toBe("m-1");
});
