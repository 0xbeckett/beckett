/**
 * Coverage for the closed agent loop's routing + dedup (Concierge.notify / frameUpdate). This is
 * the brittle judgment — which Plane events become a Discord ping, on which channel, exactly once —
 * so it's pinned here against an injected fake session rather than left to a live run.
 */

import { expect, test } from "bun:test";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config } from "../types.ts";
import type { PlaneComment, PollEvent, Ticket } from "../plane/types.ts";

const CHAN = "1097283746520174592";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

/** A Concierge wired to a fake session that just records the turns notify() feeds it. */
function harness() {
  const asks: string[] = [];
  const session = {
    ask: (m: string) => {
      asks.push(m);
      return Promise.resolve(""); // concierge "replies" via the CLI, so the return is unused
    },
  } as unknown as ConciergeSession;
  const gateway = {} as never; // notify never touches the gateway
  const concierge = new Concierge({ config, session, gateway });
  return { concierge, asks };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "id-1",
    identifier: "BEC-1",
    title: "Add healthz",
    description: "",
    body: "",
    state: "in_progress",
    assignees: [],
    casting: {},
    criteria: [],
    projectId: "p",
    url: "http://x",
    updatedAt: "now",
    originChannel: CHAN,
    ...overrides,
  };
}

function comment(body: string): PlaneComment {
  return { id: "c1", ticketId: "id-1", author: "beckett", body, createdAt: "now" };
}

const dispatcherComment = (text: string) => comment(`<!-- beckett:dispatcher -->\n${text}`);

test("relays a dispatcher milestone comment as one turn carrying the right --channel", async () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment("Implementation complete → **in_review**."),
  });
  await Promise.resolve();
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  expect(asks[0]).toContain("in_review");
  expect(asks[0]).not.toContain("beckett:dispatcher"); // marker stripped before the concierge sees it
});

test("ignores human/worker comments — only Beckett's own narration is echoed", () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: comment("hey can you also add request logging while you're in there"),
  });
  expect(asks.length).toBe(0);
});

test("surfaces `done` from the state transition (the comment feed misses terminal tickets)", () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" });
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`--channel ${CHAN}`);
  expect(asks[0]?.toLowerCase()).toContain("shipped");
});

test("does not double-surface non-terminal state changes (covered by the comment)", () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "in_progress", to: "in_review" });
  concierge.notify({ kind: "created", ticket: ticket() });
  expect(asks.length).toBe(0);
});

test("drops (does not surface) an update for a ticket with no origin channel", () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket({ originChannel: undefined }),
    comment: dispatcherComment("Implementation complete → in_review."),
  });
  expect(asks.length).toBe(0);
});

test("a full lifecycle batch yields exactly one ping per real milestone", async () => {
  const { concierge, asks } = harness();
  const t = ticket();
  const events: PollEvent[] = [
    { kind: "created", ticket: t },
    { kind: "state_changed", ticket: t, from: null, to: "in_progress" },
    { kind: "comment_added", ticket: t, comment: dispatcherComment("Implementation complete → **in_review**.") },
    { kind: "comment_added", ticket: t, comment: comment("looks good, ship it") }, // human — skip
    { kind: "comment_added", ticket: t, comment: dispatcherComment("Review found issues → back to **in_progress**.") },
    { kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" },
  ];
  concierge.notify(events);
  await Promise.resolve();
  // in_review milestone + rework milestone + done = 3 pings; created/in_progress/human all skipped.
  expect(asks.length).toBe(3);
  expect(asks.every((a) => a.includes(`--channel ${CHAN}`))).toBe(true);
});
