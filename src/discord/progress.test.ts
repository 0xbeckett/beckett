/**
 * Coverage for the progress-thread hub (`src/discord/progress.ts`) — the bridge from a ticket's
 * raw WorkerEvent firehose to a Discord thread anchored under its ack. The load-bearing behaviors
 * pinned here are the ones a live run would only expose flakily: events that arrive BEFORE the
 * thread exists get buffered and drained on open, chatty streams COALESCE instead of one-post-each,
 * terminal events flush at once, a `plan` DAG's N tickets share ONE thread (tagged per ticket), the
 * backlog is bounded (drop-oldest), and a failed open RETRIES rather than losing the thread.
 */

import { expect, test } from "bun:test";
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
  posts: { channelId: string; content: string }[];
}

/** A fake gateway that records thread opens + posts. `failOpens` makes the first N opens reject. */
function fakeGateway(opts: { failOpens?: number } = {}): {
  gateway: ThreadCapableGateway;
  rec: Recorded;
} {
  const rec: Recorded = { threads: [], posts: [] };
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

  // The ack lands → open the thread; buffered lines drain into it.
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · scan" });
  await settle();

  expect(rec.threads).toHaveLength(1);
  expect(rec.threads[0]!.anchorMessageId).toBe(ACK);
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("nmap -sV target");
  expect(body).toContain("/etc/nginx/nginx.conf");
  // Posts go to the THREAD id, never the parent channel.
  expect(rec.posts.every((p) => p.channelId === rec.threads[0]!.id)).toBe(true);
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

test("a plan DAG maps N tickets onto ONE thread, tagged by identifier", async () => {
  const { gateway, rec } = fakeGateway();
  const hub = new ProgressHub(gateway, quietLog, { flushIntervalMs: 5 });
  // Both tickets filed under the SAME ack (the plan's single reply).
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-1", title: "OPS-1 · enum" });
  hub.openThread({ channelId: CHAN, anchorMessageId: ACK, ticketIdent: "OPS-2", title: "OPS-2 · secrets" });
  hub.event("OPS-1", finished("success", "enum done"), IMPL);
  hub.event("OPS-2", finished("success", "secrets done"), IMPL);
  await settle();

  expect(rec.threads).toHaveLength(1); // one shared thread
  const body = rec.posts.map((p) => p.content).join("\n");
  expect(body).toContain("[OPS-1]");
  expect(body).toContain("[OPS-2]");
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
