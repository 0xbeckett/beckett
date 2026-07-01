/**
 * Coverage for the two OPS-27 additions to the Concierge:
 *   1. Image / attachment ingestion — a Discord message carrying files (including an image-only
 *      message with no caption) is no longer dropped; its attachments are downloaded and surfaced
 *      to the session as a Read-able manifest (the session's Read tool renders images as vision).
 *   2. The startup banner — on boot the Concierge posts the live git commit to the ops channel.
 *
 * Everything is pinned against injected fakes (no real Discord, no real `claude` session).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, currentGitCommit, type ConciergeSession } from "./index.ts";
import type { Config, IncomingAttachment, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const MSG = "msg-77";

const realFetch = globalThis.fetch;
const savedBeckettDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedBeckettDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedBeckettDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Fresh throwaway runtime dir wired via `BECKETT_DIR` — `buildPaths` then derives every child
 * (attachments, control socket, …) under it, so downloads + the control bus land in the temp dir.
 */
function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-concierge-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  return d;
}

/** A minimal Config; paths come from the `BECKETT_DIR` env override in {@link tmpBeckettDir}. */
function config(_beckettDir: string): Config {
  return {
    concierge: { model: "m", rotate_at_tokens: 190_000 },
    paths: {},
  } as unknown as Config;
}

/** Fake session that records the exact turn string it's asked and replies with a fixed line. */
function fakeSession(reply: string, asks: string[]): ConciergeSession {
  return {
    start: async () => {},
    stop: async () => {},
    ask: async (m: string) => {
      asks.push(m);
      return reply;
    },
  } as unknown as ConciergeSession;
}

/** Fake gateway that records every post; start/onMessage/sendTyping/stop are inert. */
function fakeGateway(posts: Array<{ channelId: string; text: string }>): DiscordGateway {
  return {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (channelId: string, text: string) => {
      posts.push({ channelId, text });
      return "posted-id";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
}

function att(over: Partial<IncomingAttachment> = {}): IncomingAttachment {
  return { id: "a1", name: "shot.png", url: "https://cdn.test/shot.png", contentType: "image/png", size: 4, ...over };
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: MSG,
    userId: "u1",
    channelId: CHAN,
    guildId: null,
    content: "",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

// ── image / attachment ingestion ───────────────────────────────────────────────

test("image-only message (no caption) is NOT dropped — its attachment reaches the session as a Read-able path", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })) as unknown as typeof fetch;
  const asks: string[] = [];
  const posts: Array<{ channelId: string; text: string }> = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("that's a screenshot of a login page", asks),
    gateway: fakeGateway(posts),
  });

  await concierge.onMessage(message({ content: "", attachments: [att()] }));

  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain(`[channel:${CHAN}]`);
  expect(asks[0]).toContain("Read:"); // the manifest hands the session a local path to open
  expect(asks[0]).toContain("shot.png");
  // and the model's answer is posted back as the reply
  expect(posts).toEqual([{ channelId: CHAN, text: "that's a screenshot of a login page" }]);
});

test("text + image message carries BOTH the caption and the attachment manifest", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
  const asks: string[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("looks solid", asks),
    gateway: fakeGateway([]),
  });

  await concierge.onMessage(message({ content: "how would you approach this?", attachments: [att()] }));

  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("how would you approach this?");
  expect(asks[0]).toContain("Read:");
});

test("plain text message (no attachments) is unchanged — just the framed text, no download", async () => {
  // fetch is left as the real impl; if buildTurn tried to download anything this would be flaky.
  const asks: string[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("yo", asks),
    gateway: fakeGateway([]),
  });

  await concierge.onMessage(message({ content: "@beckett you up", attachments: [] }));

  expect(asks).toHaveLength(1);
  expect(asks[0]).toBe(`[channel:${CHAN}]\n@beckett you up`);
  expect(asks[0]).not.toContain("Read:");
});

test("a non-mention with an attachment is still ignored (routing unchanged)", async () => {
  const asks: string[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("x", asks),
    gateway: fakeGateway([]),
  });
  await concierge.onMessage(message({ mentionsBot: false, attachments: [att()] }));
  expect(asks).toHaveLength(0);
});

// ── startup banner ─────────────────────────────────────────────────────────────

test("currentGitCommit reports the running repo's short hash + subject", async () => {
  const { short, subject } = await currentGitCommit(join(import.meta.dir, "..", ".."));
  expect(short).toMatch(/^[0-9a-f]{7,}$/); // a real abbreviated hash, not the "unknown" fallback
  expect(subject.length).toBeGreaterThan(0);
});

test("currentGitCommit degrades to 'unknown' outside a git repo instead of throwing", async () => {
  const { short, subject } = await currentGitCommit(tmpBeckettDir());
  expect(short).toBe("unknown");
  expect(subject).toBe("");
});

test("start() posts a one-time startup banner with the live commit to the ops channel", async () => {
  const prev = process.env.BECKETT_STARTUP_CHANNEL_ID;
  process.env.BECKETT_STARTUP_CHANNEL_ID = "ops-chan-test";
  const posts: Array<{ channelId: string; text: string }> = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("", []),
    gateway: fakeGateway(posts),
  });
  try {
    await concierge.start();
    // announceStartup is fire-and-forget; give it a couple of microtask/IO ticks to land.
    for (let i = 0; i < 50 && !posts.some((p) => p.channelId === "ops-chan-test"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const banner = posts.find((p) => p.channelId === "ops-chan-test");
    expect(banner).toBeDefined();
    expect(banner!.text.toLowerCase()).toContain("restarted");
    expect(banner!.text).toMatch(/`[0-9a-f]{7,}`/); // the short hash in backticks
  } finally {
    await concierge.stop();
    if (prev === undefined) delete process.env.BECKETT_STARTUP_CHANNEL_ID;
    else process.env.BECKETT_STARTUP_CHANNEL_ID = prev;
  }
});
