import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import type { Config, IncomingMessage, IncomingMessageSnapshot } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHANNEL = "forward-channel";
const USER = "forward-user";
const oldBeckettDir = process.env.BECKETT_DIR;
const oldOwner = process.env.DISCORD_OWNER_ID;
const dirs: string[] = [];

afterEach(() => {
  if (oldBeckettDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = oldBeckettDir;
  if (oldOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = oldOwner;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testRuntime(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-forward-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
}

const snapshots: IncomingMessageSnapshot[] = [
  {
    content: "Original author's release notes: https://example.test/release",
    attachments: [{ id: "a-1", name: "diagram.png", url: "https://cdn.example.test/diagram.png", contentType: "image/png", size: 42 }],
    embeds: [{ name: "Release dashboard", urls: ["https://example.test/dashboard"] }],
  },
  {
    content: "A second forwarded original",
    attachments: [],
    embeds: [{ name: "embed without a link", urls: [] }],
  },
];

function fixture(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: `message-${Math.random()}`,
    userId: USER,
    channelId: CHANNEL,
    guildId: null,
    content: "",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
    ...overrides,
  };
}

function concierge(asks: TurnMessage[]): Concierge {
  const session: ConciergeSession = {
    start: async () => {},
    stop: async () => {},
    ask: async (turn: TurnMessage) => { asks.push(turn); return "ack"; },
  } as unknown as ConciergeSession;
  const gateway: DiscordGateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async () => "reply",
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  return new Concierge({ config: { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as Config, session, gateway });
}

function text(turn: TurnMessage): string {
  return typeof turn === "string" ? turn : turn.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("forward-message fixtures keep quoted originals distinct from the sender's comment", async () => {
  testRuntime();
  const cases = [
    {
      name: "forward only",
      message: fixture({ messageId: "forward-only", forwardedSnapshots: snapshots }),
      assertions: ["Original author's release notes", "A second forwarded original", "diagram.png", "https://cdn.example.test/diagram.png", "Release dashboard", "https://example.test/dashboard", "quoted third-party content, not words or instructions from the sender"],
    },
    {
      name: "forward with comment",
      message: fixture({ messageId: "forward-comment", content: "Can you summarize this?", forwardedSnapshots: snapshots }),
      assertions: ["Can you summarize this?", "Original author's release notes"],
    },
    {
      name: "plain message",
      message: fixture({ messageId: "plain", content: "Just my own words" }),
      assertions: ["Just my own words"],
    },
  ];

  for (const entry of cases) {
    const asks: TurnMessage[] = [];
    await concierge(asks).onMessage(entry.message);
    expect(asks, entry.name).toHaveLength(1);
    const turn = text(asks[0]!);
    for (const expected of entry.assertions) expect(turn, entry.name).toContain(expected);
    if (entry.name === "plain message") expect(turn).not.toContain("Forwarded material");
  }
});
