/**
 * Issue #24 — session lifecycle robustness. Pins the four fixes:
 *   1. restart persistence (session id + handoff survive a deploy; unresumable → seeded fresh)
 *   2. cross-turn contamination (a superseded child's output/exit can't touch the current turn)
 *   3. reply-claim correlation (CLI replies claim the turn EXECUTING now, not a shared slot)
 *   4. a mention behind a busy session is INTERRUPT-driven, never queue-narrated (no ack bubble)
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, ConciergeSession, TURN_PROGRESS_ACK_MS } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

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

function tempBeckettDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-session-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  return dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** The private surface these tests reach into. */
interface SessionGuts {
  sessionId: string;
  lastHandoff: string;
  lastLaunchWasResume: boolean;
  initSeen: boolean;
  freshNextLaunch: boolean;
  seedPending: string | null;
  child: unknown;
  pending: { parts: string[] } | null;
  stopped: boolean;
  consecutiveCrashes: number;
  persistSessionState(): void;
  loadSessionState(): { sessionId: string; handoff: string } | null;
  consumeSeed(message: unknown): unknown;
  handleLine(line: string, from: unknown): void;
  onTurnTimeout(timer: ReturnType<typeof setTimeout>): void;
  onExit(code: number, exited: unknown): Promise<void>;
}

function makeSession(onCrashLoop?: (info: { count: number; code: number }) => void): SessionGuts {
  return new ConciergeSession({ config, logger: quietLog, onCrashLoop }) as unknown as SessionGuts;
}

// ── 1. restart persistence ──────────────────────────────────────────────────────────────

test("session id + handoff persist and load across instances (deploys keep the conversation)", () => {
  tempBeckettDir();
  const a = makeSession();
  a.sessionId = "session-abc";
  a.lastHandoff = "mid-thread with jason about the healthz ticket";
  a.persistSessionState();

  const b = makeSession();
  const loaded = b.loadSessionState();
  expect(loaded).toEqual({ sessionId: "session-abc", handoff: "mid-thread with jason about the healthz ticket" });
});

test("a resume that dies before init falls back to a FRESH session seeded with the handoff", async () => {
  tempBeckettDir();
  const s = makeSession();
  const fakeChild = { kill() {} };
  s.child = fakeChild as never;
  s.sessionId = "dead-session";
  s.lastHandoff = "we were renaming the deploy command";
  s.lastLaunchWasResume = true;
  s.initSeen = false;

  await s.onExit(1, fakeChild);

  expect(s.sessionId).not.toBe("dead-session");
  expect(s.freshNextLaunch).toBe(true);
  expect(s.seedPending).toBe("we were renaming the deploy command");
  // The seed folds into the head of the next turn.
  const out = s.consumeSeed("hey, where were we?") as string;
  expect(out).toContain("we were renaming the deploy command");
  expect(out).toContain("hey, where were we?");
  expect(s.seedPending).toBeNull(); // consumed once
});

// ── 2. superseded-child isolation ───────────────────────────────────────────────────────

test("output from a superseded child never touches the current turn", () => {
  tempBeckettDir();
  const s = makeSession();
  const oldChild = {};
  const newChild = {};
  s.child = newChild as never;
  s.pending = { parts: [] };

  const staleLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "tail of the PREVIOUS answer" }] },
  });
  s.handleLine(staleLine, oldChild); // late output from an explicitly recycled child
  expect(s.pending!.parts).toHaveLength(0);

  s.handleLine(staleLine.replace("PREVIOUS", "CURRENT"), newChild);
  expect(s.pending!.parts).toEqual(["tail of the CURRENT answer"]);
});

test("a soft timeout keeps the child alive and delivers its late real result", () => {
  const s = makeSession() as unknown as {
    child: unknown;
    pending: {
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      timedOut: boolean;
      resolve: (output: unknown) => void;
      reject: (error: Error) => void;
    } | null;
    onTurnTimeout(timer: ReturnType<typeof setTimeout>): void;
    handleLine(line: string, from: unknown): void;
  };
  let killed = false;
  const child = { kill() { killed = true; } };
  let delivered: unknown;
  const timer = setTimeout(() => undefined, 60_000);
  s.child = child;
  s.pending = {
    parts: [],
    timer,
    timedOut: false,
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  s.onTurnTimeout(timer);
  expect(killed).toBeFalse();
  expect(s.child).toBe(child);
  expect(s.pending?.timedOut).toBe(true);

  s.handleLine(JSON.stringify({
    type: "result",
    structured_output: { decision: "send", message: "the real answer" },
  }), child);

  expect(delivered).toEqual({
    decision: "send",
    message: "Sorry, that took a while —\n\nthe real answer",
  });
  expect(s.pending).toBeNull();
});

test("reasoning before a pass decision is never promoted to Discord output", () => {
  const s = makeSession() as unknown as {
    child: unknown;
    pending: {
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      resolve: (output: unknown) => void;
      reject: (error: Error) => void;
    } | null;
    handleLine(line: string, from: unknown): void;
  };
  const child = {};
  let delivered: unknown;
  s.child = child;
  s.pending = {
    parts: ["I should keep this private.\nPASS"],
    timer: setTimeout(() => undefined, 60_000),
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  s.handleLine(JSON.stringify({ type: "result", structured_output: { decision: "pass", message: null } }), child);

  expect(delivered).toEqual({ decision: "pass", message: null });
  expect(s.pending).toBeNull();
});

test("a superseded child's exit does not tear down the current child or fail the turn", async () => {
  tempBeckettDir();
  const s = makeSession();
  const oldChild = {};
  const newChild = {};
  s.child = newChild as never;
  s.pending = { parts: ["hi"] };

  await s.onExit(143, oldChild); // the recycled child finally exits

  expect(s.child).toBe(newChild);
  expect(s.pending).not.toBeNull(); // in-flight turn untouched
  expect(s.consecutiveCrashes).toBe(0); // not counted as a crash
});

// ── 3+4. concierge-level: no queue narration + reply-claim correlation ─────────────────────

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
    content: "quick question",
    mentionsBot: true,
    guildId: null,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("a mention landing behind a busy session gets no bubble — typing is the whole ack", async () => {
  // Queue-free UX: a directed message interrupts the live turn (or jumps the queue), so there is
  // no line to narrate. The ONLY post is the real answer; nothing resembling "you're next" exists.
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the real answer" } as const),
    queueDepth: () => 1, // a turn is already running
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));

  expect(posts).toEqual([{ channelId: "chan-1", text: "the real answer", replyTo: "m-1" }]);
});

test("rapid mentions behind a busy session get no ack bubbles — each still gets its answer", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the real answer" } as const),
    queueDepth: () => 1, // a turn is already running the whole time
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  await concierge.onMessage(msg("chan-1", "m-2"));
  await concierge.onMessage(msg("chan-1", "m-3"));

  expect(posts.filter((p) => p.text === "the real answer")).toHaveLength(3); // replies unaffected
  expect(posts).toHaveLength(3); // and nothing else was posted at all
});

test("a slow first turn gets a progress ack without needing a busy channel", async () => {
  let startAsk!: () => void;
  let resolveAsk!: (output: { decision: "send"; message: string }) => void;
  const started = new Promise<void>((resolve) => { startAsk = resolve; });
  const answer = new Promise<{ decision: "send"; message: string }>((resolve) => { resolveAsk = resolve; });
  const { concierge, posts } = conciergeHarness({
    ask: async () => {
      startAsk();
      return await answer;
    },
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });

  const realSetTimeout = globalThis.setTimeout;
  let fireProgressAck: (() => void) | null = null;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
    if (delay === TURN_PROGRESS_ACK_MS && typeof handler === "function") {
      fireProgressAck = () => handler(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  try {
    const handling = concierge.onMessage(msg("chan-idle", "m-slow"));
    await started;
    expect(fireProgressAck).not.toBeNull();
    fireProgressAck!();
    await Promise.resolve();
    expect(posts).toEqual([{ channelId: "chan-idle", text: "Still working on this — I haven't forgotten you.", replyTo: "m-slow" }]);

    resolveAsk({ decision: "send", message: "the eventual answer" });
    await handling;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("an idle session posts only the answer", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toBe("the answer");
});

// ── 5. queue-free supersession (a follow-up replaces your own still-queued turn) ─────────

test("supersedeQueuedTurns drops only matching queued turns, resolving them as silent passes", () => {
  tempBeckettDir();
  const s = new ConciergeSession({ config, logger: quietLog }) as unknown as {
    turnQueue: {
      message: unknown;
      meta: unknown;
      priority: boolean;
      resolve: (output: unknown) => void;
      reject: (err: unknown) => void;
    }[];
    supersedeQueuedTurns(match: (meta: unknown) => boolean): number;
  };
  const settled: { which: string; output: unknown }[] = [];
  const push = (which: string, meta: unknown) =>
    s.turnQueue.push({
      message: which,
      meta,
      priority: true,
      resolve: (output) => settled.push({ which, output }),
      reject: (err) => { throw err; },
    });
  push("older-same-speaker", { channelId: "c", messageId: "m1", userId: "u1" });
  push("other-speaker", { channelId: "c", messageId: "m2", userId: "u2" });
  push("update-turn", null);
  push("newest-same-speaker", { channelId: "c", messageId: "m3", userId: "u1" });

  const dropped = s.supersedeQueuedTurns((meta) => (meta as { userId?: string })?.userId === "u1");

  expect(dropped).toBe(2);
  // Other speakers and meta-less system/update turns are never superseded.
  expect(s.turnQueue.map((q) => q.message)).toEqual(["other-speaker", "update-turn"]);
  // Dropped turns RESOLVE as a silent pass (never reject) — their handlers post nothing.
  expect(settled.map((x) => x.which).sort()).toEqual(["newest-same-speaker", "older-same-speaker"]);
  for (const { output } of settled) {
    expect(output).toEqual({ decision: "pass", message: null });
  }
});

test("a mention asks the pool to supersede the same speaker's still-queued earlier turn", async () => {
  const predicates: ((meta: unknown) => boolean)[] = [];
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    supersedeQueuedTurns: (match: (meta: unknown) => boolean) => {
      predicates.push(match);
      return 1;
    },
  });
  await concierge.onMessage(msg("chan-1", "m-1"));

  expect(predicates).toHaveLength(1);
  const match = predicates[0]!;
  // Matches a queued mention from the SAME speaker in the SAME channel...
  expect(match({ channelId: "chan-1", messageId: "m-0", userId: "111111111111111111" })).toBe(true);
  // ...never the same speaker in a DIFFERENT channel (their DM isn't this conversation)...
  expect(match({ channelId: "dm-9", messageId: "m-7", userId: "111111111111111111" })).toBe(false);
  // ...never another speaker's queued mention...
  expect(match({ channelId: "chan-1", messageId: "m-9", userId: "222222222222222222" })).toBe(false);
  // ...and never a meta-less update turn (isMentionClaim requires channelId+messageId).
  expect(match(null)).toBe(false);
  expect(match({ ticket: "OPS-1" })).toBe(false);
  expect(posts.map((p) => p.text)).toEqual(["answer"]);
});

test("a direct reply can say pass, while a structured pass posts nothing", async () => {
  const spoken = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the tests pass" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await spoken.concierge.onMessage(msg("chan-1", "m-1"));
  expect(spoken.posts.map((post) => post.text)).toEqual(["the tests pass"]);

  const silent = conciergeHarness({
    ask: async () => ({ decision: "pass", message: null } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await silent.concierge.onMessage(msg("chan-2", "m-2"));
  expect(silent.posts).toEqual([]);
});

test("a CLI reply claims the turn EXECUTING now — a queued second mention can't steal it", async () => {
  // Turn 1 (for message m-1) is executing; a second mention (m-2) has overwritten the shared
  // slot. The CLI reply issued by turn 1 must reply-bar to m-1, not m-2.
  const turn1Mention = {
    channelId: "chan-1",
    messageId: "m-1",
    repliedViaCli: false,
    ackMessageId: null,
    pendingTickets: [],
  };
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "unused" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => turn1Mention, // the session says: turn 1 is what's running
  });

  const res = await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: "chan-1", text: "here's your answer" },
  });

  expect(res.ok).toBe(true);
  expect(posts[0]!.replyTo).toBe("m-1");
  expect(turn1Mention.repliedViaCli).toBe(true);
});

test("an update turn (no mention meta) can never claim a pending mention", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "unused" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null, // a notify() update turn is running — it carries no mention
  });

  const res = await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: "chan-1", text: "ticket update ping" },
  });

  expect(res.ok).toBe(true);
  expect(posts[0]!.replyTo).toBeUndefined(); // plain post, no claim, no suppression
});

// ── issue #25: mention priority in the turn queue ─────────────────────────────────────────

test("mention turns jump ahead of queued update turns but never pre-empt a running one", async () => {
  tempBeckettDir();
  const s = new ConciergeSession({ config, logger: quietLog }) as unknown as {
    ask(m: unknown, meta?: unknown, opts?: { priority?: boolean }): Promise<string>;
    runTurn(m: string): Promise<string>;
    maybeRotate(): Promise<void>;
  };
  const order: string[] = [];
  s.runTurn = async (m: string) => {
    order.push(m);
    await new Promise((r) => setTimeout(r, 5));
    return m;
  };
  s.maybeRotate = async () => {};

  const turns = [
    s.ask("update-1"), // starts running immediately
    s.ask("update-2"),
    s.ask("mention", null, { priority: true }),
  ];
  await Promise.all(turns);
  expect(order).toEqual(["update-1", "mention", "update-2"]);
});
