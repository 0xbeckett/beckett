import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanePoller } from "./poll.ts";
import type { PlaneClient } from "./client.ts";
import type { PlaneComment, Ticket } from "./types.ts";

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

function comment(ticketId: string, over: Partial<PlaneComment> = {}): PlaneComment {
  return {
    id: over.id ?? `c-${ticketId}`,
    ticketId,
    author: "jawrooo",
    body: "nudge",
    createdAt: over.createdAt ?? "2026-01-01T00:00:10.000Z",
    ...over,
  };
}

class FakePlaneClient {
  tickets: Ticket[] = [];
  comments = new Map<string, PlaneComment[]>();
  commentCalls: { ticketId: string; since?: string }[] = [];

  async listIssues(): Promise<Ticket[]> {
    return this.tickets;
  }

  async listComments(ticketId: string, since?: string): Promise<PlaneComment[]> {
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

describe("PlanePoller comment hot path", () => {
  test("does not fetch comments for unchanged active tickets", async () => {
    const client = new FakePlaneClient();
    client.tickets = [ticket()];
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });

    await poller.poll(); // first sight seeds the cursor without replaying history
    client.commentCalls = [];

    await poller.poll();
    expect(client.commentCalls).toHaveLength(0);
  });

  test("fetches comments when issue updatedAt advances", async () => {
    const client = new FakePlaneClient();
    client.tickets = [ticket()];
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });

    await poller.poll();
    const updated = ticket({ updatedAt: "2026-01-01T00:00:05.000Z" });
    client.tickets = [updated];
    client.comments.set("t1", [comment("t1")]);

    const events = await poller.poll();
    expect(client.commentCalls).toHaveLength(1);
    expect(events).toEqual([{ kind: "comment_added", ticket: updated, comment: comment("t1") }]);
  });

  test("fetches changed tickets' comments in parallel while preserving ticket order", async () => {
    const client = new FakePlaneClient();
    client.tickets = [
      ticket({ id: "a", identifier: "OPS-A" }),
      ticket({ id: "b", identifier: "OPS-B" }),
    ];
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });
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
      const client = new FakePlaneClient();
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

      const poller = new PlanePoller({
        client: client as unknown as PlaneClient,
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

  test("prime re-staffs tickets already in review", async () => {
    const client = new FakePlaneClient();
    const reviewing = ticket({ state: "in_review" });
    client.tickets = [reviewing];
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });

    const events = await poller.prime();
    expect(events).toEqual([{ kind: "state_changed", ticket: reviewing, from: null, to: "in_review" }]);
  });

  test("same-timestamp comments are deduped by id instead of dropped", async () => {
    class InclusiveFakePlaneClient extends FakePlaneClient {
      override async listComments(
        ticketId: string,
        since?: string,
        opts: { inclusive?: boolean } = {},
      ): Promise<PlaneComment[]> {
        this.commentCalls.push({ ticketId, since });
        return (this.comments.get(ticketId) ?? []).filter((c) =>
          !since ? true : opts.inclusive ? c.createdAt >= since : c.createdAt > since,
        );
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "beckett-comment-tie-"));
    try {
      const cursorPath = join(dir, "cursors.json");
      const client = new InclusiveFakePlaneClient();
      client.tickets = [ticket()];
      await Bun.write(
        cursorPath,
        JSON.stringify({
          t1: { lastCommentAt: "2026-01-01T00:00:10.000Z", lastCommentIds: ["c1"] },
        }),
      );
      const poller = new PlanePoller({
        client: client as unknown as PlaneClient,
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
    const client = new FakePlaneClient();
    client.tickets = [ticket()];
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });
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

describe("PlanePoller stats (issue #30)", () => {
  test("successful polls stamp lastPollAt and keep failures at zero", async () => {
    const client = new FakePlaneClient();
    client.tickets = [ticket()];
    let clock = 1_000;
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => clock });

    expect(poller.stats()).toEqual({ lastPollAt: null, lastPollAgeMs: null, consecutiveFailures: 0 });
    await poller.poll();
    clock = 4_000;
    expect(poller.stats()).toEqual({ lastPollAt: 1_000, lastPollAgeMs: 3_000, consecutiveFailures: 0 });
  });

  test("failed polls count consecutively and a success resets", async () => {
    const client = new FakePlaneClient();
    client.tickets = [ticket()];
    let boom = true;
    const listIssues = client.listIssues.bind(client);
    client.listIssues = async () => {
      if (boom) throw new Error("plane down");
      return listIssues();
    };
    const poller = new PlanePoller({ client: client as unknown as PlaneClient, logger: quiet, now: () => 0 });

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
