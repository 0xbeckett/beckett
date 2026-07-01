import { describe, expect, test } from "bun:test";
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
    author: "jason",
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
});
