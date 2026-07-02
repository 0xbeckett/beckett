/**
 * OPS-59 — work-thread lifecycle driven by Plane poll events (Concierge.notify):
 *   - ticket → in_progress: a Discord thread is opened under the origin channel + registered,
 *     with a kickoff post so the person knows they can steer there
 *   - ticket → done/cancelled: the thread is cooled (stops auto-triggering)
 *   - once a thread exists, ticket-update pings route INTO the thread, not the parent channel
 *   - no origin channel / a gateway that can't create threads ⇒ no thread, no throw (stays gated)
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { ThreadRegistry } from "../discord/threads.ts";
import type { Config } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { PlaneComment, Ticket } from "../plane/types.ts";

const PARENT = "parent-chan";
const NEW_THREAD = "T-created";

let dir: string;
let savedDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-tl-"));
  savedDir = process.env.BECKETT_DIR;
  process.env.BECKETT_DIR = dir;
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

function harness(opts: { canCreateThreads?: boolean } = {}) {
  const asks: string[] = [];
  const posts: Array<{ channelId: string; text: string }> = [];
  const created: Array<{ parent: string; name: string }> = [];
  const session = {
    ask: (m: string) => {
      asks.push(m);
      return Promise.resolve("");
    },
  } as unknown as ConciergeSession;
  const base: Record<string, unknown> = {
    async post(channelId: string, text: string) {
      posts.push({ channelId, text });
      return `mid-${posts.length}`;
    },
  };
  if (opts.canCreateThreads !== false) {
    base.createThread = async (parent: string, name: string) => {
      created.push({ parent, name });
      return NEW_THREAD;
    };
  }
  const gateway = base as unknown as DiscordGateway;
  const threads = new ThreadRegistry(join(dir, "threads.json"));
  const concierge = new Concierge({ config, session, gateway, threads });
  return { concierge, asks, posts, created, threads };
}

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "uuid-1",
    identifier: "OPS-59",
    title: "Thread steering",
    description: "",
    body: "",
    state: "in_progress",
    assignees: [],
    casting: {},
    criteria: [],
    blockedBy: [],
    projectId: "p",
    url: "http://x",
    updatedAt: "now",
    originChannel: PARENT,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test("ticket → in_progress opens + registers a work thread and posts a kickoff", async () => {
  const { concierge, created, posts, threads } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "todo", to: "in_progress" });
  await flush();
  expect(created).toEqual([{ parent: PARENT, name: "OPS-59: Thread steering" }]);
  expect(threads.isActive(NEW_THREAD)).toBe(true);
  expect(threads.getByTicket("uuid-1")?.threadId).toBe(NEW_THREAD);
  // kickoff landed in the new thread
  expect(posts.some((p) => p.channelId === NEW_THREAD)).toBe(true);
});

test("thread creation is idempotent — a second in_progress doesn't open another", async () => {
  const { concierge, created } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "todo", to: "in_progress" });
  await flush();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "in_review", to: "in_progress" });
  await flush();
  expect(created).toHaveLength(1);
});

test("ticket → done cools the thread (goes cold)", async () => {
  const { concierge, threads } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "todo", to: "in_progress" });
  await flush();
  expect(threads.isActive(NEW_THREAD)).toBe(true);
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" });
  await flush();
  expect(threads.isActive(NEW_THREAD)).toBe(false);
});

test("cancelled cools the thread too", async () => {
  const { concierge, threads } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "todo", to: "in_progress" });
  await flush();
  concierge.notify({ kind: "cancelled", ticket: ticket({ state: "cancelled" }) });
  await flush();
  expect(threads.isActive(NEW_THREAD)).toBe(false);
});

test("once a thread exists, update pings route INTO the thread (not the parent)", async () => {
  const { concierge, asks, threads } = harness();
  threads.register({ threadId: NEW_THREAD, ticketId: "uuid-1", ticketIdentifier: "OPS-59", parentChannelId: PARENT });
  const comment: PlaneComment = {
    id: "c1",
    ticketId: "uuid-1",
    author: "beckett",
    body: "<!-- beckett:dispatcher -->\nImplementation complete → **in_review**.",
    createdAt: "now",
  };
  concierge.notify({ kind: "comment_added", ticket: ticket(), comment });
  await flush();
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain(`--channel ${NEW_THREAD}`);
  expect(asks[0]).not.toContain(`--channel ${PARENT}`);
});

test("no origin channel ⇒ no thread created, no throw", async () => {
  const { concierge, created } = harness();
  concierge.notify({
    kind: "state_changed",
    ticket: ticket({ originChannel: undefined }),
    from: "todo",
    to: "in_progress",
  });
  await flush();
  expect(created).toHaveLength(0);
});

test("a gateway that can't create threads ⇒ no thread, no throw (stays mention-gated)", async () => {
  const { concierge, threads } = harness({ canCreateThreads: false });
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "todo", to: "in_progress" });
  await flush();
  expect(threads.getByTicket("uuid-1")).toBeUndefined();
});
