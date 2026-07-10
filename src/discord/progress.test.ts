/**
 * Coverage for the progress-thread hub (`src/discord/progress.ts`) — the bridge from a ticket's
 * raw WorkerEvent firehose to a Discord thread anchored under its ack. The load-bearing behaviors
 * pinned here are the ones a live run would only expose flakily: events that arrive BEFORE the
 * thread exists get buffered and drained on open, chatty streams COALESCE instead of one-post-each,
 * terminal events flush at once, a `plan` DAG's N tickets share ONE thread (tagged per ticket), the
 * backlog is bounded (drop-oldest), and a failed open RETRIES rather than losing the thread.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressHub, formatEvent, type ThreadCapableGateway, type ProgressContext } from "./progress.ts";
import type { WorkerEvent } from "../types.ts";

const CHAN = "chan-1";
const ACK = "ack-msg-1";
const IMPL: ProgressContext = { stage: "implement", workerId: "wk_1" };

/** Silent logger so tests don't spew NDJSON. */
const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

interface Recorded {
  threads: { channelId: string; anchorMessageId: string; name: string; id: string }[];
  standaloneThreads: { channelId: string; name: string; id: string }[];
  posts: { channelId: string; content: string }[];
}

/** A fake gateway that records thread opens + posts. `failOpens` makes the first N opens reject. */
function fakeGateway(opts: { failOpens?: number } = {}): {
  gateway: ThreadCapableGateway;
  rec: Recorded;
} {
  const rec: Recorded = { threads: [], standaloneThreads: [], posts: [] };
  let opens = 0;
  let toFail = opts.failOpens ?? 0;
  const gateway: ThreadCapableGateway = {
    async startThread(channelId, anchorMessageId, name) {
      if (toFail > 0) {
        toFail--;
        throw new Error("gateway mid-reconnect");
      }
      const id = `thread-${++opens}`;
      rec.threads.push({ channelId, anchorMessageId, name, id });
      return id;
    },
    async startStandaloneThread(channelId, name) {
      const id = `workspace-${rec.standaloneThreads.length + 1}`;
      rec.standaloneThreads.push({ channelId, name, id });
      return id;
    },
    async post(channelId, content) {
      rec.posts.push({ channelId, content });
      return `post-${rec.posts.length}`;
    },
  };
  return { gateway, rec };
}

/** Let queued microtasks + a bounded set of timers settle. */
async function settle(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function toolCall(tool: string, input: unknown): WorkerEvent {
  return { kind: "tool_call", tool, input, toolId: `t-${tool}`, ts: 0 };
}

function finished(status: "success" | "error", summary: string): WorkerEvent {
  return {
    kind: "finished",
    status,
    subtype: "",
    structuredOutput: summary ? { summary } : null,
    usage: {} as never,
    ts: 0,
  };
}

// ── formatEvent (pure) ──────────────────────────────────────────────────────────────────────

test("formatEvent surfaces the play-by-play and drops noise", () => {
  const f = (e: WorkerEvent) => formatEvent(e, IMPL, new Map());
  expect(f({ kind: "session_started", sessionId: "s", model: "sonnet", ts: 0 })).toContain("implement worker started");
  expect(f(toolCall("Bash", { command: "curl -s https://target" }))).toContain("curl -s https://target");
  expect(f({ kind: "file_change", paths: [{ path: "src/a.ts", kind: "update" }], ts: 0 })).toContain("src/a.ts");
  expect(f({ kind: "hook_decision", decision: "deny", reason: "outside scope", ts: 0 })).toContain("deny");
  expect(f(finished("success", "all four criteria met"))).toContain("all four criteria met");
  // Noise: streaming text, per-turn ticks, echoes, successful tool results → dropped.
  expect(f({ kind: "assistant_text", text: "thinking", partial: true, ts: 0 })).toBeNull();
  expect(f({ kind: "turn_completed", usage: {} as never, ts: 0 })).toBeNull();
  expect(f({ kind: "tool_result", toolId: "t-Bash", isError: false, ts: 0 })).toBeNull();
});

test("formatEvent names the tool that errored via the toolNames map", () => {
  const names = new Map<string, string>();
  formatEvent(toolCall("Bash", { command: "false" }), IMPL, names); // records t-Bash → Bash
  const line = formatEvent({ kind: "tool_result", toolId: "t-Bash", isError: true, ts: 0 }, IMPL, names);
  expect(line).toContain("Bash errored");
});

// ── buffering + open ordering ────────────────────────────────────────────────────────────────

test("events that arrive before the thread is open are buffered, then flushed on open", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });

  // Worker events land BEFORE the ack/thread exists (the real race).
  hub.event("OPS-1", toolCall("Bash", { command: "nmap -sV target" }), IMPL);
  hub.event("OPS-1", toolCall("Read", { file_path: "/etc/nginx/nginx.conf" }), IMPL);
  expect(rec.threads).toHaveLength(0); // nothing opened yet

  // The ack lands → open the activity + workspace pair; buffered lines drain into activity.
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · scan" });
  await settle();

  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe(ACK);
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("nmap -sV target");
  expect(body).toContain("/etc/nginx/nginx.conf");
  // Posts go to the THREAD id, never the parent channel.
  const activityPosts = rec.posts.filter((p) => p.content.includes("nmap") || p.content.includes("nginx"));
  expect(activityPosts.every((p) => p.channelId === rec.threads[0]!.id)).toBe(true);
  expect(rec.threads[0]!.name).toBe("OPS-1 · activity");
  expect(rec.standaloneThreads[0]!.name).toBe("OPS-1 · with Beckett");
  hub.dispose();
});

test("openThread is idempotent across both ack paths (no duplicate thread)", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });
  const req = { channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · x" };
  hub.openThread(req);
  hub.openThread(req); // both the auto-post AND cli-reply ack paths can fire
  hub.event("OPS-1", finished("success", "done"), IMPL);
  await settle();
  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  hub.dispose();
});

test("a re-anchor with a DIFFERENT ack keeps the first thread (OPS-76 triple-thread bug)", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });
  // The Concierge acks ("filing it now"), the ticket files and anchors to that ack…
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-76", title: "OPS-76 · x" });
  // …then replies AGAIN in the same turn ("on it, i'll ping you") — a new ack message id.
  hub.openThread({ channelId: CHAN, anchorMessageId: "ack-msg-2", ticketIdent: "OPS-76", title: "OPS-76 · x" });
  hub.event("OPS-76", toolCall("Bash", { command: "bun test" }), IMPL);
  hub.event("OPS-76", finished("success", "done"), IMPL);
  await settle();

  // ONE thread, anchored to the FIRST ack, receiving the whole log stream.
  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe(ACK);
  expect(rec.posts.filter((p) => p.content.includes("bun test")).every((p) => p.channelId === rec.threads[0]!.id)).toBe(true);
  expect(rec.posts.map((p) => p.content).join("\n")).toContain("bun test");
  hub.dispose();
});

// ── coalescing + terminal flush ───────────────────────────────────────────────────────────────

test("a chatty stream coalesces into few posts, not one-per-event", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 30 });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "t" });
  await settle(5); // let the thread open
  for (let i = 0; i < 20; i++) hub.event("OPS-1", toolCall("Bash", { command: `probe ${i}` }), IMPL);
  await settle(60);
  // 20 events must not become 20 posts — they batch into a digest (well under the event count).
  expect(rec.posts.length).toBeLessThan(20);
  expect(rec.posts.length).toBeGreaterThan(0);
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("probe 0");
  expect(body).toContain("probe 19");
  hub.dispose();
});

test("a terminal event flushes immediately without waiting for the coalesce window", async () => {
  const { gateway, rec } = fakeGateway();
  // Long interval: a timer-driven flush would NOT fire within the test window.
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 100_000 });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "t" });
  await settle(5);
  hub.event("OPS-1", finished("success", "shipped it"), IMPL);
  await settle();
  expect(rec.posts.map((p) => p.content).join("")).toContain("shipped it");
  hub.dispose();
});

// ── plan DAG: many tickets, one thread ────────────────────────────────────────────────────────

test("a plan DAG maps N tickets onto ONE activity/workspace pair, tagged by identifier", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });
  // Both tickets filed under the SAME ack (the plan's single reply).
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · enum" });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-2", title: "OPS-2 · secrets" });
  hub.event("OPS-1", finished("success", "enum done"), IMPL);
  hub.event("OPS-2", finished("success", "secrets done"), IMPL);
  await settle();

  expect(rec.threads).toHaveLength(1); // one shared thread
  expect(rec.standaloneThreads).toHaveLength(1); // one shared human workspace
  expect(hub.workspaceContext(rec.standaloneThreads[0]!.id)).toEqual({
    parentChannelId: CHAN,
    ticketIdents: ["OPS-1", "OPS-2"],
  });
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("[OPS-1]");
  expect(body).toContain("[OPS-2]");
  hub.dispose();
});

test("a plan ticket filed after the workspace opened is added to its routing and conversation", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "first" });
  await settle();

  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-2", title: "second" });
  await settle();

  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(1);
  expect(hub.workspaceContext("workspace-1")?.ticketIdents).toEqual(["OPS-1", "OPS-2"]);
  expect(
    rec.posts.some((p) => p.channelId === "workspace-1" && p.content.includes("Also tracking OPS-2")),
  ).toBe(true);
  hub.dispose();
});

// ── backpressure + open retry ─────────────────────────────────────────────────────────────────

test("the backlog is bounded (drop-oldest) and reports the elision", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 100_000 });
  // Flood BEFORE opening so it all queues in one buffer (no flush drains it).
  for (let i = 0; i < 500; i++) hub.event("OPS-1", toolCall("Bash", { command: `x${i}` }), IMPL);
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "t" });
  hub.event("OPS-1", finished("error", "gave up"), IMPL); // terminal → flush
  await settle();
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("elided"); // oldest were dropped and the drop is surfaced
  expect(body).not.toContain("x0"); // the very oldest is gone
  hub.dispose();
});

test("a failed thread-open retries and eventually posts", async () => {
  const { gateway, rec } = fakeGateway({ failOpens: 1 }); // first open throws, second succeeds
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5, openRetryMs: 10 });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "t" });
  hub.event("OPS-1", finished("success", "recovered"), IMPL);
  await settle(60); // let the retry timer fire
  expect(rec.threads.length).toBeGreaterThanOrEqual(1);
  expect(rec.posts.map((p) => p.content).join("")).toContain("recovered");
  hub.dispose();
});

test("a failed human workspace does not disturb the activity feed", async () => {
  const { gateway, rec } = fakeGateway();
  gateway.startStandaloneThread = async () => {
    throw new Error("missing CREATE_PUBLIC_THREADS permission");
  };
  const hub = new ProgressHub(gateway, quietLog, {
    flushIntervalMs: 5,
    openRetryMs: 5,
    openMaxAttempts: 1,
  });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "t" });
  hub.event("OPS-1", finished("success", "activity survived"), IMPL);
  await settle(30);

  expect(rec.threads).toHaveLength(1);
  expect(rec.standaloneThreads).toHaveLength(0);
  const activity = rec.posts.filter((p) => p.channelId === rec.threads[0]!.id).map((p) => p.content).join("\n");
  expect(activity).toContain("activity survived");
  expect(activity).toContain("Human workspace unavailable");
  hub.dispose();
});

test("a permanently unthreadable channel degrades to parent-channel digests", async () => {
  const { gateway, rec } = fakeGateway();
  gateway.startThread = async () => {
    throw new Error("discord channel dm-1 cannot host a thread");
  };
  gateway.startStandaloneThread = async () => {
    throw new Error("discord channel dm-1 cannot host a thread");
  };
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5, openRetryMs: 10 });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · dm" });
  hub.event("OPS-1", finished("success", "done from dm"), IMPL);
  await settle();

  expect(rec.threads).toHaveLength(0);
  expect(rec.posts.some((p) => p.channelId === CHAN && p.content.includes("done from dm"))).toBe(true);
  expect(rec.posts.some((p) => p.content.includes("Progress thread unavailable"))).toBe(true);
  hub.dispose();
});

test("thread mapping persists across a hub restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-progress-state-"));
  try {
    const stateFile = join(dir, "progress-threads.json");
    const first = fakeGateway();
    const hub1 = new ProgressHub(first.gateway, quietLog, { flushIntervalMs: 5, stateFile });
    hub1.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · scan" });
    await settle();
    expect(first.rec.threads).toHaveLength(1);
    expect(first.rec.standaloneThreads).toHaveLength(1);
    hub1.dispose();

    const second = fakeGateway();
    const hub2 = new ProgressHub(second.gateway, quietLog, { flushIntervalMs: 5, stateFile });
    expect(hub2.workspaceContext("workspace-1")).toEqual({
      parentChannelId: CHAN,
      ticketIdents: ["OPS-1"],
    });
    hub2.event("OPS-1", finished("success", "after restart"), IMPL);
    await settle();

    expect(second.rec.threads).toHaveLength(0);
    expect(second.rec.standaloneThreads).toHaveLength(0);
    expect(second.rec.posts).toEqual([{ channelId: "thread-1", content: "✓ implement success: after restart" }]);
    hub2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy one-thread state is upgraded by creating the missing human workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-progress-legacy-"));
  try {
    const stateFile = join(dir, "progress-threads.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        "OPS-9": { channelId: CHAN, threadId: "legacy-activity", name: "OPS-9 · old title" },
      }),
    );
    const { gateway, rec } = fakeGateway();
    const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5, stateFile });

    hub.event("OPS-9", finished("success", "migrated"), IMPL);
    await settle();

    expect(rec.threads).toHaveLength(0); // the existing activity thread is reused
    expect(rec.standaloneThreads).toHaveLength(1);
    expect(hub.workspaceContext("workspace-1")).toEqual({
      parentChannelId: CHAN,
      ticketIdents: ["OPS-9"],
    });
    expect(rec.posts.some((p) => p.channelId === "legacy-activity" && p.content.includes("migrated"))).toBe(true);
    expect(rec.posts.some((p) => p.channelId === "workspace-1" && p.content.includes("without an @mention"))).toBe(true);
    hub.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
