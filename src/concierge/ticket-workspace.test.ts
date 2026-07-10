/**
 * Coverage for the Concierge half of the Coworker-as-a-Service thread model: a thread a USER
 * opens becomes a ticket workspace (directed turns with no @mention), Beckett spawns no threads
 * of its own, the worker firehose lands in the private journal instead of Discord, and the
 * code-level access gate still bounces outsiders inside a workspace. Uses injected fakes
 * (no live Discord / no claude), matching `notify.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config, IncomingMessage, WorkerEvent } from "../types.ts";

const CHAN = "chan-42";
const USER = "111111111111111111";
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

function authorize(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-workspace-turn-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  return dir;
}

interface Recorded {
  posts: { channelId: string; content: string; replyTo?: string }[];
}

/** Fake gateway recording posts; posts return sequential message ids. NO thread-creation surface
 *  at all — these tests prove the Concierge runs without ever spawning a Discord thread. */
function fakeGateway(rec: Recorded) {
  return {
    async start() {},
    async stop() {},
    async sendTyping() {},
    onMessage() {},
    onThreadCreate() {},
    isConnected() { return true; },
    lastEventAgeMs() { return 0; },
    async post(channelId: string, content: string, o?: { replyToMessageId?: string }) {
      rec.posts.push({ channelId, content, replyTo: o?.replyToMessageId });
      return `mid-${rec.posts.length}`;
    },
  } as never;
}

function mention(content: string): IncomingMessage {
  return {
    messageId: "user-msg-1",
    userId: USER,
    channelId: CHAN,
    guildId: "g1",
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
  };
}

test("a ticket filed mid-turn spawns NO Discord threads — just the ack", async () => {
  authorize();
  const rec: Recorded = { posts: [] };
  const gateway = fakeGateway(rec);
  // The fake turn: claude files a ticket mid-turn (bus), then the concierge auto-posts the ack text.
  const session = {
    ask: async () => {
      await (concierge as unknown as { onBusRequest: Function }).onBusRequest({
        cmd: "ticket.filed",
        args: { identifier: "OPS-35", channelId: CHAN, title: "scan my site" },
      });
      return "bet, filing it now. OPS-35, it's cooking.";
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  await concierge.onMessage(mention("@beckett scan my site for vulns"));

  // Exactly one post, in the parent channel. The fake gateway has no thread-creation surface at
  // all, so anything beyond the ack would have thrown — bot thread-spawning is structurally gone.
  expect(rec.posts).toHaveLength(1);
  expect(rec.posts[0]!.channelId).toBe(CHAN);
});

test("worker events land in the private journal, not on Discord", async () => {
  const dir = authorize();
  const rec: Recorded = { posts: [] };
  const session = { ask: async () => "ok" } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway: fakeGateway(rec) });

  const sink = concierge.progressSink();
  const finished: WorkerEvent = {
    kind: "finished",
    status: "success",
    subtype: "",
    structuredOutput: { summary: "all criteria met" },
    usage: {} as never,
    ts: 0,
  };
  sink.event("OPS-35", { kind: "tool_call", tool: "Bash", input: { command: "bun test" }, toolId: "t1", ts: 0 }, {
    stage: "implement",
    workerId: "w1",
  });
  sink.event("OPS-35", finished, { stage: "implement", workerId: "w1" });

  const journal = readFileSync(join(dir, "journal", "OPS-35.log"), "utf8");
  expect(journal).toContain("bun test");
  expect(journal).toContain("✓ implement success: all criteria met");
  expect(rec.posts).toHaveLength(0); // nothing user-facing
});

test("an unmentioned message in a user-opened thread is a ticket-grounded directed turn", async () => {
  authorize();
  const rec: Recorded = { posts: [] };
  const gateway = fakeGateway(rec);
  const turns: string[] = [];
  const session = {
    ask: async (turn: string) => {
      turns.push(turn);
      return "yeah, i'll pass that constraint to the worker.";
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  // A person opens a thread named after the ticket → the gateway's thread-create event registers it.
  concierge.onThreadCreated({
    threadId: "user-thread-1",
    parentChannelId: CHAN,
    name: "OPS-40 auth refresh",
    creatorId: USER,
  });
  await concierge.onMessage({
    ...mention("also preserve the old refresh tokens"),
    messageId: "workspace-msg-1",
    channelId: "user-thread-1",
    channelName: "OPS-40 auth refresh",
    content: "also preserve the old refresh tokens",
    mentionsBot: false,
  });

  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain("SYSTEM (ticket workspace");
  expect(turns[0]).toContain('Plane ticket(s): "OPS-40"');
  expect(turns[0]).toContain("directed to you even without an @mention");
  expect(turns[0]).toContain("beckett journal"); // the frame points at the private detail pull
  const reply = rec.posts.find((p) => p.content.includes("pass that constraint"));
  expect(reply).toMatchObject({ channelId: "user-thread-1", replyTo: "workspace-msg-1" });

  // The access gate is NOT bypassed by workspace routing: an outsider gets declined, no turn runs.
  await concierge.onMessage({
    ...mention("let me steer this too"),
    messageId: "outsider-workspace-msg",
    userId: "222222222222222222",
    channelId: "user-thread-1",
    content: "let me steer this too",
    mentionsBot: false,
  });
  expect(turns).toHaveLength(1); // workspace routing does not bypass the code-level access gate
  expect(rec.posts.some((p) => p.replyTo === "outsider-workspace-msg")).toBe(true);
});

test("a ticket filed from inside a workspace grounds that workspace", async () => {
  authorize();
  const rec: Recorded = { posts: [] };
  const gateway = fakeGateway(rec);
  const turns: string[] = [];
  let calls = 0;
  const session = {
    ask: async (turn: string) => {
      turns.push(turn);
      calls++;
      if (calls === 1) {
        // The turn runs INSIDE the workspace thread and files a ticket for it.
        await (concierge as unknown as { onBusRequest: Function }).onBusRequest({
          cmd: "ticket.filed",
          args: { identifier: "OPS-41", channelId: "user-thread-2", title: "csv export" },
        });
        return "filed OPS-41, it's cooking.";
      }
      return "still moving — worker is mid-implementation.";
    },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });

  concierge.onThreadCreated({
    threadId: "user-thread-2",
    parentChannelId: CHAN,
    name: "csv export corner",
    creatorId: USER,
  });
  // First workspace message: no ticket bound yet — frame says so.
  await concierge.onMessage({
    ...mention("can you get me a csv export?"),
    messageId: "ws2-msg-1",
    channelId: "user-thread-2",
    content: "can you get me a csv export?",
    mentionsBot: false,
  });
  expect(turns[0]).toContain("No ticket is bound to it yet");

  // Second workspace message: the filed ticket now grounds the frame.
  await concierge.onMessage({
    ...mention("how's it coming?"),
    messageId: "ws2-msg-2",
    channelId: "user-thread-2",
    content: "how's it coming?",
    mentionsBot: false,
  });
  expect(turns[1]).toContain('Plane ticket(s): "OPS-41"');
});

test("workspace routing survives a Concierge restart", async () => {
  authorize();
  const rec: Recorded = { posts: [] };
  const turns: string[] = [];
  const session = {
    ask: async (turn: string) => {
      turns.push(turn);
      return "picking it right back up.";
    },
  } as unknown as ConciergeSession;

  const first = new Concierge({ config, session, gateway: fakeGateway(rec) });
  first.onThreadCreated({
    threadId: "user-thread-3",
    parentChannelId: CHAN,
    name: "OPS-50 perf work",
    creatorId: USER,
  });

  // A fresh Concierge (same BECKETT_DIR) rehydrates the registry from workspaces.json.
  const second = new Concierge({ config, session, gateway: fakeGateway(rec) });
  await second.onMessage({
    ...mention("did the daemon restart lose us?"),
    messageId: "ws3-msg-1",
    channelId: "user-thread-3",
    content: "did the daemon restart lose us?",
    mentionsBot: false,
  });

  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain('Plane ticket(s): "OPS-50"');
});

test("no legacy migration fabricates threads: old progress-threads.json is simply ignored", async () => {
  const dir = authorize();
  // A leftover state file from the retired progress-thread era.
  writeFileSync(
    join(dir, "progress-threads.json"),
    JSON.stringify({ "OPS-9": { channelId: CHAN, threadId: "legacy-activity", name: "OPS-9 · old" } }),
    "utf8",
  );
  const rec: Recorded = { posts: [] };
  const session = { ask: async () => "ok" } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway: fakeGateway(rec) });

  // Events for the legacy ticket go to the journal; nothing is posted, no thread is "upgraded".
  concierge.progressSink().event(
    "OPS-9",
    { kind: "finished", status: "success", subtype: "", structuredOutput: null, usage: {} as never, ts: 0 },
    { stage: "implement", workerId: "w1" },
  );
  expect(rec.posts).toHaveLength(0);
  expect(existsSync(join(dir, "journal", "OPS-9.log"))).toBe(true);
});
