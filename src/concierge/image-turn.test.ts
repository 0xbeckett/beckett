/**
 * Coverage for the Concierge's image / attachment path and the startup banner:
 *   1. Image ingestion (OPS-31) — a Discord message carrying an image is downloaded and reaches the
 *      model turn as a real base64 **image content block**, not merely as a text path in a manifest.
 *      OPS-27 shipped only the manifest, so images never actually reached the model turn; these tests
 *      pin the round trip so that regression can't recur. Image-only messages (no caption) still
 *      engage, non-image files still degrade to a Read-able manifest, and text-only turns are
 *      byte-for-byte unchanged (a plain string, no content-block array).
 *   2. The startup banner — on boot the Concierge posts the live git commit to the ops channel.
 *
 * Everything is pinned against injected fakes (no real Discord, no real `claude` session).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Concierge,
  currentGitCommit,
  type ConciergeSession,
  type TurnMessage,
} from "./index.ts";
import type { Config, IncomingAttachment, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { ImageContentBlock } from "../discord/attachments.ts";

/** Pull the base64 image blocks out of a recorded turn (empty array for a plain-string turn). */
function imageBlocks(turn: TurnMessage): ImageContentBlock[] {
  if (typeof turn === "string") return [];
  return turn.filter((b): b is ImageContentBlock => b.type === "image");
}

/** The framed text a turn carries — the string itself, or its single text block. */
function turnText(turn: TurnMessage): string {
  if (typeof turn === "string") return turn;
  return turn
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

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

/** Fake session that records the exact turn it's asked (string or content-block array) and replies. */
function fakeSession(reply: string, asks: TurnMessage[]): ConciergeSession {
  return {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
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

/** A 1x1 PNG (real signature + IHDR) so base64 encoding produces a plausible image block. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

test("image-only message (no caption) reaches the model turn as a real base64 image content block", async () => {
  globalThis.fetch = (async () =>
    new Response(PNG_BYTES, { status: 200 })) as unknown as typeof fetch;
  const asks: TurnMessage[] = [];
  const posts: Array<{ channelId: string; text: string }> = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("that's a screenshot of a login page", asks),
    gateway: fakeGateway(posts),
  });

  await concierge.onMessage(message({ content: "", attachments: [att({ size: PNG_BYTES.length })] }));

  expect(asks).toHaveLength(1);
  // The turn is a content-block array (NOT a bare string) carrying an actual base64 image block —
  // this is what OPS-27 missed and OPS-31 fixes: the image bytes reach the model turn as vision.
  const imgs = imageBlocks(asks[0]!);
  expect(imgs).toHaveLength(1);
  expect(imgs[0]!.source.type).toBe("base64");
  expect(imgs[0]!.source.media_type).toBe("image/png");
  expect(imgs[0]!.source.data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
  // The channel is still stamped on the text block (ticket routing survives).
  expect(turnText(asks[0]!)).toContain(`[channel:${CHAN}]`);
  // and the model's answer is posted back as the reply
  expect(posts).toEqual([{ channelId: CHAN, text: "that's a screenshot of a login page" }]);
});

test("text + image message carries BOTH the caption text and the image content block", async () => {
  globalThis.fetch = (async () =>
    new Response(PNG_BYTES, { status: 200 })) as unknown as typeof fetch;
  const asks: TurnMessage[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("looks solid", asks),
    gateway: fakeGateway([]),
  });

  await concierge.onMessage(
    message({ content: "how would you approach this?", attachments: [att({ size: PNG_BYTES.length })] }),
  );

  expect(asks).toHaveLength(1);
  expect(turnText(asks[0]!)).toContain("how would you approach this?");
  expect(imageBlocks(asks[0]!)).toHaveLength(1);
});

test("a non-image attachment degrades to a Read-able manifest, not an image block", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
  const asks: TurnMessage[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("got it", asks),
    gateway: fakeGateway([]),
  });

  await concierge.onMessage(
    message({
      content: "check this",
      attachments: [att({ name: "notes.pdf", contentType: "application/pdf", size: 4 })],
    }),
  );

  expect(asks).toHaveLength(1);
  // A PDF can't be inlined as an image block — it stays a plain-string turn with a Read manifest.
  expect(imageBlocks(asks[0]!)).toHaveLength(0);
  expect(turnText(asks[0]!)).toContain("Read:");
  expect(turnText(asks[0]!)).toContain("notes.pdf");
});

test("plain text message (no attachments) is unchanged — a bare framed string, no download", async () => {
  // fetch is left as the real impl; if buildTurn tried to download anything this would be flaky.
  const asks: TurnMessage[] = [];
  const concierge = new Concierge({
    config: config(tmpBeckettDir()),
    session: fakeSession("yo", asks),
    gateway: fakeGateway([]),
  });

  await concierge.onMessage(message({ content: "@beckett you up", attachments: [] }));

  expect(asks).toHaveLength(1);
  // still a plain string, not an array — now carrying the speaker stamp (OPS-42)
  expect(asks[0]).toBe(`[channel:${CHAN}] [user:u1 msg:${MSG}]\n@beckett you up`);
  expect(imageBlocks(asks[0]!)).toHaveLength(0);
});

test("a non-mention with an attachment is still ignored (routing unchanged)", async () => {
  const asks: TurnMessage[] = [];
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
