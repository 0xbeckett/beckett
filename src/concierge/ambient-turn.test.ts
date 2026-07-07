/**
 * T2 wire-up coverage (proposal §4.4/§4.5): the Concierge's ambient turn path. These pin the
 * behaviors the coordinator can't test alone — the `onMessage` router, the three SYSTEM frames,
 * PASS suppression, plain (non-reply) auto-posting, offer arming, consent routing that bypasses
 * triage, and the mention-path ring-buffer prepend. Everything runs against injected fakes: a fake
 * session (records turns, returns a scripted reply), a fake gateway (records posts), a fake triage
 * classifier, and a fake clock driving the debounce/offer timers.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { AmbientClock } from "./ambient.ts";
import type { TriageFn, TriageVerdict } from "./triage.ts";
import type { IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
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

class FakeClock implements AmbientClock {
  t = 0;
  next = 1;
  timers = new Map<number, { at: number; cb: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    while (true) {
      const due = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].cb();
    }
    this.t = target;
  }
}

/** Flush enough microtask turns to drain the fire-and-forget triage → engage → post chain. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function msg(id: string, content: string, createdAt: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: id,
    userId: MEMBER,
    authorDisplayName: "Jason",
    channelId: CHAN,
    guildId: "guild-1",
    content,
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt,
    attachments: [],
    ...over,
  };
}

const yes: TriageVerdict = { interject: true, kind: "feature-wish", confidence: 0.9, reason: "concrete wish" };

interface Harness {
  concierge: Concierge;
  asks: TurnMessage[];
  posts: { channelId: string; text: string; replyTo?: string }[];
  typings: string[];
  triageCalls: number;
  setReply: (r: string) => void;
}

function harness(opts: { reply?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "beckett-ambient-turn-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  delete process.env.DISCORD_OWNER_ID;
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

  const state = { reply: opts.reply ?? "want me to kick that off?", triageCalls: 0 };
  const asks: TurnMessage[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];
  const typings: string[] = [];

  const session = {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return state.reply;
    },
    queueDepth: () => 0,
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
      return `posted-${posts.length}`;
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;

  const triage: TriageFn = async () => {
    state.triageCalls++;
    return yes;
  };

  const config = validateConfig({
    proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 2, channel_cooldown_secs: 0 },
  });
  const concierge = new Concierge({ config, session, gateway, ambientTriage: triage, ambientClock: new FakeClock() });
  return {
    concierge,
    asks,
    posts,
    typings,
    get triageCalls() {
      return state.triageCalls;
    },
    setReply: (r: string) => {
      state.reply = r;
    },
  } as Harness;
}

/** Reach the injected FakeClock so the test can advance debounce/offer timers. */
function clockOf(h: Harness): FakeClock {
  return (h.concierge as unknown as { ambient: { /* private */ } & Record<string, unknown> }).ambient["clock"] as FakeClock;
}

test("candidate PASS posts nothing, sends no typing, and leaves cooldown unconsumed", async () => {
  const h = harness({ reply: "PASS" });
  const clock = clockOf(h);

  await h.concierge.onMessage(msg("m1", "wish this exported csv", 0));
  clock.advance(2_000);
  await drain();

  expect(h.triageCalls).toBe(1);
  expect(h.asks).toHaveLength(1); // the ambient candidate turn ran…
  expect(h.posts).toHaveLength(0); // …but PASS suppressed the post
  expect(h.typings).toHaveLength(0); // ambient turns never telegraph typing

  // PASS consumed no cooldown → the next burst triages again.
  await h.concierge.onMessage(msg("m2", "and pdf too", 3_000));
  clock.advance(2_000);
  await drain();
  expect(h.triageCalls).toBe(2);
});

test("candidate reply auto-posts plainly (no native reply) and frames the transcript", async () => {
  const h = harness({ reply: "I can build that — want me to kick it off?" });
  const clock = clockOf(h);

  await h.concierge.onMessage(msg("m1", "the export flow is painful", 0));
  await h.concierge.onMessage(msg("m2", "wish it just gave me a csv", 500));
  clock.advance(2_000);
  await drain();

  expect(h.posts).toEqual([
    { channelId: CHAN, text: "I can build that — want me to kick it off?", replyTo: undefined },
  ]);
  const frame = h.asks[0] as string;
  expect(frame).toContain("SYSTEM (ambient — nobody addressed you");
  expect(frame).toContain("wish it just gave me a csv");
  expect(frame).toContain("Triage says: feature-wish (confidence 0.90)");
});

test("a live offer routes the next message as a consent turn that bypasses triage", async () => {
  const h = harness({ reply: "want me to kick off CSV export? say the word." });
  const clock = clockOf(h);

  // Candidate posts → arms an offer.
  await h.concierge.onMessage(msg("m1", "wish this had csv export", 0));
  clock.advance(2_000);
  await drain();
  expect(h.triageCalls).toBe(1);
  expect(h.posts).toHaveLength(1);

  // Next message in the channel: consent turn, NO new triage, framed as a follow-up.
  h.setReply("on it — filing that now");
  await h.concierge.onMessage(msg("m2", "sure, go for it", 5_000));
  await drain();
  expect(h.triageCalls).toBe(1); // triage bypassed
  expect(h.asks).toHaveLength(2);
  expect(h.asks[1] as string).toContain("SYSTEM (ambient follow-up)");
  expect(h.asks[1] as string).toContain("want me to kick off CSV export");
  expect(h.posts).toHaveLength(2); // the consent reply posted plainly
  expect(h.posts[1]).toEqual({ channelId: CHAN, text: "on it — filing that now", replyTo: undefined });

  // The real consent reply closed the offer → the following message triages fresh again.
  await h.concierge.onMessage(msg("m3", "also would love dark mode", 6_000));
  clock.advance(2_000);
  await drain();
  expect(h.triageCalls).toBe(2);
});

test("a PASS consent reply keeps the offer open (still no triage on the next message)", async () => {
  const h = harness({ reply: "here's an offer" });
  const clock = clockOf(h);

  await h.concierge.onMessage(msg("m1", "wish this had csv", 0));
  clock.advance(2_000);
  await drain();
  expect(h.posts).toHaveLength(1);

  // An unrelated/ambiguous message → the model PASSes → offer stays live.
  h.setReply("PASS");
  await h.concierge.onMessage(msg("m2", "unrelated banter", 5_000));
  await drain();
  expect(h.triageCalls).toBe(1); // consent, not triage
  expect(h.posts).toHaveLength(1); // PASS posted nothing

  // Still a live offer → the next message is again a consent turn, not a triage.
  await h.concierge.onMessage(msg("m3", "ok yes do it", 6_000));
  await drain();
  expect(h.triageCalls).toBe(1);
  expect(h.asks[2] as string).toContain("SYSTEM (ambient follow-up)");
});

test("auto-mode offer that ages out emits a silence-consent timeout turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-ambient-turn-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  delete process.env.DISCORD_OWNER_ID;
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

  const asks: TurnMessage[] = [];
  const posts: { channelId: string; text: string }[] = [];
  const session = {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return "no objection — running with the CSV export thing";
    },
    queueDepth: () => 0,
  } as unknown as ConciergeSession;
  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (channelId: string, text: string) => {
      posts.push({ channelId, text });
      return "posted";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  const clock = new FakeClock();
  const config = validateConfig({
    proactivity: {
      enabled: true,
      default_mode: "auto",
      burst_quiet_secs: 2,
      channel_cooldown_secs: 0,
      offer_ttl_secs: 10,
    },
  });
  const concierge = new Concierge({
    config,
    session,
    gateway,
    ambientTriage: (async () => yes) as TriageFn,
    ambientClock: clock,
  });

  // Candidate posts → arms an auto-mode offer with a 10s TTL.
  await concierge.onMessage(msg("m1", "wish this had csv", 0));
  clock.advance(2_000);
  await drain();
  expect(posts).toHaveLength(1);

  // Nobody replies. Advance past the TTL → the offer expires and (auto mode) fires a timeout turn.
  clock.advance(10_000);
  await drain();
  expect(asks).toHaveLength(2);
  expect(asks[1] as string).toContain("SYSTEM (ambient timeout)");
  expect(asks[1] as string).toContain("proceed-on-silence");
  expect(posts).toHaveLength(2);
});

test("an @mention cancels a pending burst flush and prepends the unseen ring buffer", async () => {
  const h = harness({ reply: "answer" });
  const clock = clockOf(h);

  // Two un-mentioned messages fill the ring buffer and arm the debounce…
  await h.concierge.onMessage(msg("m1", "the export flow is painful", 0));
  await h.concierge.onMessage(msg("m2", "wish it gave me a csv", 500));

  // …then an @mention arrives mid-burst. It must cancel the flush (no triage) AND carry the buffer.
  await h.concierge.onMessage(msg("m3", "@beckett do that", 1_000, { mentionsBot: true, content: "do that" }));
  clock.advance(5_000);
  await drain();

  expect(h.triageCalls).toBe(0); // flush cancelled — never double-respond
  const mentionTurn = h.asks[0] as string;
  expect(mentionTurn).toContain("SYSTEM (shared channel context");
  expect(mentionTurn).toContain("the export flow is painful");
  expect(mentionTurn).toContain("wish it gave me a csv");
  // OPS-80: attributed lines — the speaker's id rides every transcript line.
  expect(mentionTurn).toContain(`(user:${MEMBER})`);
  // The mention itself is framed as a normal user turn below the prepended context…
  expect(mentionTurn).toContain("do that");
  // …and must NOT also appear as a transcript line above itself (it was captured pre-assembly).
  expect(mentionTurn.indexOf("do that")).toBe(mentionTurn.lastIndexOf("do that"));
});

test("the ring-buffer prepend isn't repeated on a later mention (watermark advances)", async () => {
  const h = harness({ reply: "answer" });

  await h.concierge.onMessage(msg("m1", "some earlier context", 0));
  await h.concierge.onMessage(msg("m2", "@beckett handle it", 100, { mentionsBot: true, content: "handle it" }));
  expect(h.asks[0] as string).toContain("some earlier context");

  // A second mention does not re-send lines the session already saw (the persisted watermark
  // advanced — OPS-80 §3.3). Beckett's OWN intervening reply is legitimately new record content
  // (the frame's "you may already have replied to some of it" exists for exactly this), so the
  // assertion pins the user line, not the header.
  await h.concierge.onMessage(msg("m3", "@beckett again", 200, { mentionsBot: true, content: "again" }));
  const second = h.asks[1] as string;
  expect(second).not.toContain("some earlier context");
  expect(second).toContain("beckett: answer");

  // A third mention right after: Beckett's reply to the second was itself recorded, but the
  // first reply (already surfaced above) is not re-sent.
  await h.concierge.onMessage(msg("m4", "@beckett once more", 300, { mentionsBot: true, content: "once more" }));
  const third = h.asks[2] as string;
  expect(third).not.toContain("some earlier context");
  expect(third.split("beckett: answer").length - 1).toBe(1);
});

test("outsider messages update nothing — no ring buffer, so no mention prepend", async () => {
  const h = harness({ reply: "answer" });
  const OUTSIDER = "999999999999999999";

  await h.concierge.onMessage(msg("m1", "secret outsider chatter", 0, { userId: OUTSIDER }));
  await h.concierge.onMessage(msg("m2", "@beckett status", 100, { mentionsBot: true, content: "status" }));

  const mentionTurn = h.asks[0] as string;
  expect(mentionTurn).not.toContain("SYSTEM (shared channel context");
  expect(mentionTurn).not.toContain("secret outsider chatter");
});
