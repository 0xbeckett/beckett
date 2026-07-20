import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackerPoller } from "./poll.ts";
import type { TrackerClient } from "./client.ts";
import type { TicketComment, Ticket } from "./types.ts";

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: over.id ?? "t1",
    identifier: over.identifier ?? "OPS-1",
    title: over.title ?? "Do it",
    description: "",
    body: "",
    state: over.state ?? "in_progress",
    assignees: [],
    casting: {},
    criteria: [],
    blockedBy: [],
    projectId: "p",
    url: "http://x",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function comment(ticketId: string, over: Partial<TicketComment> = {}): TicketComment {
  return {
    id: over.id ?? `c-${ticketId}`,
    ticketId,
    author: "jawrooo",
    body: "nudge",
    createdAt: over.createdAt ?? "2026-01-01T00:00:10.000Z",
    ...over,
  };
}

class FakeTrackerClient {
  tickets: Ticket[] = [];
  comments = new Map<string, TicketComment[]>();
  commentCalls: { ticketId: string; since?: string }[] = [];
  /** Full-hydration fetches the poller paid — the polling diet (issue #33) asserts on this. */
  getIssueCalls: string[] = [];

  async listIssues(): Promise<Ticket[]> {
    return this.tickets;
  }

  /** The slim id+updated_at sweep the poller diffs before paying any hydration (issue #33). */
  async listIssueHeads(): Promise<Array<{ id: string; updatedAt: string }>> {
    return this.tickets.map((t) => ({ id: t.id, updatedAt: t.updatedAt }));
  }

  async getIssue(id: string): Promise<Ticket | null> {
    this.getIssueCalls.push(id);
    return this.tickets.find((t) => t.id === id) ?? null;
  }

  async listComments(ticketId: string, since?: string): Promise<TicketComment[]> {
    this.commentCalls.push({ ticketId, since });
    return (this.comments.get(ticketId) ?? []).filter((c) => !since || c.createdAt > since);
  }
}

const quiet = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() {
    return quiet;
  },
} as never;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TrackerPoller comment hot path", () => {
  test("does not fetch comments for unchanged active tickets", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    await poller.poll(); // first sight seeds the cursor without replaying history
    client.commentCalls = [];

    await poller.poll();
    expect(client.commentCalls).toHaveLength(0);
  });

  test("fetches comments when issue updatedAt advances", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    await poller.poll();
    const updated = ticket({ updatedAt: "2026-01-01T00:00:05.000Z" });
    client.tickets = [updated];
    client.comments.set("t1", [comment("t1")]);

    const events = await poller.poll();
    expect(client.commentCalls).toHaveLength(1);
    expect(events).toEqual([{ kind: "comment_added", ticket: updated, comment: comment("t1") }]);
  });

  test("fetches changed tickets' comments in parallel while preserving ticket order", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [
      ticket({ id: "a", identifier: "OPS-A" }),
      ticket({ id: "b", identifier: "OPS-B" }),
    ];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });
    await poller.poll();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    client.listComments = async (ticketId: string, since?: string) => {
      started.push(ticketId);
      if (started.length === 2) release();
      await gate;
      client.commentCalls.push({ ticketId, since });
      return [comment(ticketId, { id: `c-${ticketId}` })];
    };
    client.tickets = [
      ticket({ id: "a", identifier: "OPS-A", updatedAt: "2026-01-01T00:00:05.000Z" }),
      ticket({ id: "b", identifier: "OPS-B", updatedAt: "2026-01-01T00:00:05.000Z" }),
    ];

    const eventsPromise = poller.poll();
    await tick();
    expect(started).toEqual(["a", "b"]);

    const events = await eventsPromise;
    expect(events.map((e) => e.kind === "comment_added" ? e.comment.ticketId : "")).toEqual(["a", "b"]);
  });

  test("prime emits comments posted while the daemon was down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-comment-cursor-"));
    try {
      const cursorPath = join(dir, "cursors.json");
      const client = new FakeTrackerClient();
      const active = ticket({ updatedAt: "2026-01-01T00:10:00.000Z" });
      client.tickets = [active];
      client.comments.set("t1", [
        comment("t1", { id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
        comment("t1", { id: "during-down", createdAt: "2026-01-01T00:05:00.000Z" }),
      ]);
      await Bun.write(
        cursorPath,
        JSON.stringify({
          t1: { lastCommentAt: "2026-01-01T00:00:00.000Z", lastCommentIds: ["old"] },
        }),
      );

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => Date.parse("2026-01-01T00:10:00.000Z"),
        commentCursorPath: cursorPath,
      });

      const events = await poller.prime();
      expect(events).toEqual([
        { kind: "state_changed", ticket: active, from: null, to: "in_progress" },
        { kind: "comment_added", ticket: active, comment: comment("t1", { id: "during-down", createdAt: "2026-01-01T00:05:00.000Z" }) },
      ]);
      expect(readFileSync(cursorPath, "utf8")).toContain("during-down");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prime re-staffs live INT Design but leaves Review (Design) parked", async () => {
    const client = new FakeTrackerClient();
    const design = ticket({ id: "int-design", identifier: "INT-1", state: "design" });
    const gate = ticket({ id: "int-gate", identifier: "INT-2", state: "design_review" });
    client.tickets = [design, gate];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    const events = await poller.prime();
    expect(events.filter((e) => e.kind === "state_changed")).toEqual([
      { kind: "state_changed", ticket: design, from: null, to: "design" },
    ]);
  });

  test("prime re-staffs tickets already in review", async () => {
    const client = new FakeTrackerClient();
    const reviewing = ticket({ state: "in_review" });
    client.tickets = [reviewing];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    const events = await poller.prime();
    expect(events).toEqual([{ kind: "state_changed", ticket: reviewing, from: null, to: "in_review" }]);
  });

  test("prime does NOT re-staff cancelled or done tickets on boot (#65)", async () => {
    const client = new FakeTrackerClient();
    // A ticket cancelled/finished before the last daemon exit must not be resurrected on boot — the
    // dispatcher would otherwise spawn a worker against work nobody wants. Only the active in_progress
    // ticket gets a recovery event.
    const cancelled = ticket({ id: "c1", identifier: "OPS-C", state: "cancelled" });
    const finished = ticket({ id: "d1", identifier: "OPS-D", state: "done" });
    const active = ticket({ id: "a1", identifier: "OPS-A", state: "in_progress" });
    client.tickets = [cancelled, finished, active];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    const events = await poller.prime();
    expect(events.filter((e) => e.kind === "state_changed")).toEqual([
      { kind: "state_changed", ticket: active, from: null, to: "in_progress" },
    ]);
  });

  test("warm restart re-staffs a previously-seen active ticket silently (no from:null ping, no created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json");
      const client = new FakeTrackerClient();
      const active = ticket({ state: "in_progress" });
      client.tickets = [active];
      // The prior daemon persisted this ticket in the same state before the restart.
      await Bun.write(
        snapshotPath,
        JSON.stringify({ t1: { state: "in_progress", updatedAt: "2026-01-01T00:00:00.000Z" } }),
      );

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      const events = await poller.prime();
      // Dispatcher still re-staffs (to === "in_progress") but the concierge never sees `from: null`,
      // so no restart ping fires — and no phantom `created`.
      expect(events.filter((e) => e.kind !== "comment_added")).toEqual([
        { kind: "state_changed", ticket: active, from: "in_progress", to: "in_progress" },
      ]);
      expect(events.some((e) => e.kind === "created")).toBe(false);
      expect(events.some((e) => e.kind === "state_changed" && e.from === null)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cold start (no snapshot file) still announces genuinely-new active tickets with from:null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json"); // file does not exist yet
      const client = new FakeTrackerClient();
      const active = ticket({ state: "in_review" });
      client.tickets = [active];

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      const events = await poller.prime();
      expect(events).toEqual([{ kind: "state_changed", ticket: active, from: null, to: "in_review" }]);
      // And it persisted the snapshot atomically for the next restart.
      expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual({
        t1: { state: "in_review", updatedAt: "2026-01-01T00:00:00.000Z" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a ticket that CHANGED state while the daemon was down re-announces (from:null), not silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json");
      const client = new FakeTrackerClient();
      const nowReviewing = ticket({ state: "in_review" });
      client.tickets = [nowReviewing];
      // Persisted as in_progress; it advanced to in_review while offline — a real transition.
      await Bun.write(
        snapshotPath,
        JSON.stringify({ t1: { state: "in_progress", updatedAt: "2026-01-01T00:00:00.000Z" } }),
      );

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      const events = await poller.prime();
      expect(events).toEqual([{ kind: "state_changed", ticket: nowReviewing, from: null, to: "in_review" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt snapshot file degrades to cold-start behavior without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json");
      await Bun.write(snapshotPath, "{ this is not valid json");
      const client = new FakeTrackerClient();
      const active = ticket({ state: "in_progress" });
      client.tickets = [active];

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      const events = await poller.prime();
      expect(events).toEqual([{ kind: "state_changed", ticket: active, from: null, to: "in_progress" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("poll() first-sight also honors a warm snapshot when prime() never ran (or failed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json");
      const client = new FakeTrackerClient();
      const active = ticket({ state: "in_progress" });
      client.tickets = [active];
      await Bun.write(
        snapshotPath,
        JSON.stringify({ t1: { state: "in_progress", updatedAt: "2026-01-01T00:00:00.000Z" } }),
      );

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      // Skip prime() entirely — poll() sees the ticket for the first time but must not treat a
      // known active ticket as fresh.
      const events = await poller.poll();
      expect(events).toEqual([{ kind: "state_changed", ticket: active, from: "in_progress", to: "in_progress" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("poll() first-sight announces a genuinely-new ticket absent from the warm snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-poll-snapshot-"));
    try {
      const snapshotPath = join(dir, "poll-snapshot.json");
      const client = new FakeTrackerClient();
      const known = ticket({ id: "t1", state: "in_progress" });
      const fresh = ticket({ id: "t2", identifier: "OPS-2", state: "in_progress" });
      client.tickets = [known, fresh];
      await Bun.write(
        snapshotPath,
        JSON.stringify({ t1: { state: "in_progress", updatedAt: "2026-01-01T00:00:00.000Z" } }),
      );

      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => 0,
        snapshotPath,
      });

      const events = await poller.poll();
      expect(events).toContainEqual({ kind: "created", ticket: fresh });
      expect(events).toContainEqual({ kind: "state_changed", ticket: fresh, from: null, to: "in_progress" });
      // The known ticket is silent (same-state seed), never a fresh created/from:null.
      expect(events).toContainEqual({ kind: "state_changed", ticket: known, from: "in_progress", to: "in_progress" });
      expect(events.some((e) => e.kind === "created" && e.ticket.id === "t1")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same-timestamp comments are deduped by id instead of dropped", async () => {
    class InclusiveFakeTrackerClient extends FakeTrackerClient {
      override async listComments(
        ticketId: string,
        since?: string,
        opts: { inclusive?: boolean } = {},
      ): Promise<TicketComment[]> {
        this.commentCalls.push({ ticketId, since });
        return (this.comments.get(ticketId) ?? []).filter((c) =>
          !since ? true : opts.inclusive ? c.createdAt >= since : c.createdAt > since,
        );
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "beckett-comment-tie-"));
    try {
      const cursorPath = join(dir, "cursors.json");
      const client = new InclusiveFakeTrackerClient();
      client.tickets = [ticket()];
      await Bun.write(
        cursorPath,
        JSON.stringify({
          t1: { lastCommentAt: "2026-01-01T00:00:10.000Z", lastCommentIds: ["c1"] },
        }),
      );
      const poller = new TrackerPoller({
        client: client as unknown as TrackerClient,
        logger: quiet,
        now: () => Date.parse("2026-01-01T00:01:00.000Z"),
        commentCursorPath: cursorPath,
      });
      await poller.prime();
      client.commentCalls = [];
      const updated = ticket({ updatedAt: "2026-01-01T00:01:00.000Z" });
      client.tickets = [updated];
      client.comments.set("t1", [
        comment("t1", { id: "c1", createdAt: "2026-01-01T00:00:10.000Z" }),
        comment("t1", { id: "c2", createdAt: "2026-01-01T00:00:10.000Z" }),
      ]);

      const events = await poller.poll();
      expect(client.commentCalls).toEqual([{ ticketId: "t1", since: "2026-01-01T00:00:10.000Z" }]);
      expect(events).toEqual([
        { kind: "comment_added", ticket: updated, comment: comment("t1", { id: "c2", createdAt: "2026-01-01T00:00:10.000Z" }) },
      ]);
      expect(readFileSync(cursorPath, "utf8")).toContain("c2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scheduled ticks deliver empty batches so downstream maintenance still runs", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });
    await poller.poll();

    const seen: number[] = [];
    await (
      poller as unknown as {
        tickOnce(onEvents: (events: unknown[]) => void | Promise<void>): Promise<void>;
      }
    ).tickOnce((events) => {
      seen.push(events.length);
    });

    expect(seen).toEqual([0]);
  });
});

describe("TrackerPoller stats (issue #30)", () => {
  test("successful polls stamp lastPollAt and keep failures at zero", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    let clock = 1_000;
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => clock });

    expect(poller.stats()).toEqual({ lastPollAt: null, lastPollAgeMs: null, consecutiveFailures: 0 });
    await poller.poll();
    clock = 4_000;
    expect(poller.stats()).toEqual({ lastPollAt: 1_000, lastPollAgeMs: 3_000, consecutiveFailures: 0 });
  });

  test("failed polls count consecutively and a success resets", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    let boom = true;
    const listIssueHeads = client.listIssueHeads.bind(client);
    client.listIssueHeads = async () => {
      if (boom) throw new Error("tracker down");
      return listIssueHeads();
    };
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    await poller.poll();
    await poller.poll();
    expect(poller.stats().consecutiveFailures).toBe(2);
    expect(poller.stats().lastPollAt).toBeNull();

    boom = false;
    await poller.poll();
    expect(poller.stats().consecutiveFailures).toBe(0);
    expect(poller.stats().lastPollAt).toBe(0);
  });
});

describe("polling diet + instant paths (issue #33)", () => {
  test("an unchanged board costs zero hydrations after first sight", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [ticket()];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });

    await poller.poll(); // first sight hydrates once
    expect(client.getIssueCalls).toEqual(["t1"]);
    await poller.poll();
    await poller.poll();
    expect(client.getIssueCalls).toEqual(["t1"]); // slim head sweep only — no re-hydration
  });

  test("only the ticket whose updated_at moved is hydrated", async () => {
    const client = new FakeTrackerClient();
    client.tickets = [
      ticket({ id: "a", identifier: "OPS-A" }),
      ticket({ id: "b", identifier: "OPS-B" }),
    ];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });
    await poller.poll();
    client.getIssueCalls = [];

    client.tickets = [
      ticket({ id: "a", identifier: "OPS-A" }),
      ticket({ id: "b", identifier: "OPS-B", updatedAt: "2026-01-01T00:00:05.000Z" }),
    ];
    await poller.poll();
    expect(client.getIssueCalls).toEqual(["b"]);
  });

  test("observe() suppresses the duplicate of a dispatcher-written advance", async () => {
    const client = new FakeTrackerClient();
    const t = ticket();
    client.tickets = [t];
    const poller = new TrackerPoller({ client: client as unknown as TrackerClient, logger: quiet, now: () => 0 });
    await poller.poll();

    // The dispatcher advanced the ticket to done and already notified the concierge directly.
    const done = ticket({ state: "done", updatedAt: "2026-01-01T00:00:09.000Z" });
    poller.observe({ kind: "state_changed", ticket: done, from: t.state, to: "done" });
    client.tickets = [done];

    const events = await poller.poll();
    expect(events.filter((e) => e.kind === "state_changed")).toEqual([]);
  });

  test("poke() runs an immediate tick instead of waiting out the poll interval", async () => {
    const client = new FakeTrackerClient();
    const batches: unknown[][] = [];
    const poller = new TrackerPoller({
      client: client as unknown as TrackerClient,
      logger: quiet,
      pollSecs: 3_600, // the interval alone would never fire inside this test
      now: () => 0,
    });
    await poller.start((events) => {
      batches.push(events);
    });

    client.tickets = [ticket()];
    poller.poke();
    await tick();
    await tick();
    poller.stop();

    const kinds = batches.flat().map((e) => (e as { kind: string }).kind);
    expect(kinds).toContain("created");
  });
});
