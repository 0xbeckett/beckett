/**
 * Coverage for the closed agent loop's routing + dedup (Concierge.notify / frameUpdate). This is
 * the brittle judgment — which tracker events become a Discord ping, on which channel, exactly once —
 * so it's pinned here against an injected fake session rather than left to a live run.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { createMemory } from "../memory/index.ts";
import { openLoop, settleLoop } from "../memory/loops.ts";
import type { AmbientClock } from "./ambient.ts";
import type { Config } from "../types.ts";
import type { TicketComment, PollEvent, Ticket } from "../tracker/types.ts";

const CHAN = "1097283746520174592";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

/** A hand-cranked clock so a test can walk past the milestone dedupe window deliberately. */
class FakeClock implements AmbientClock {
  t = Date.parse("2026-07-23T12:00:00Z");
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTimeout(): unknown {
    return 0;
  }
  clearTimeout(): void {}
}

/** A Concierge wired to a fake session that just records the turns notify() feeds it. */
function harness(clock?: AmbientClock) {
  const asks: string[] = [];
  const session = {
    ask: (m: string) => {
      asks.push(m);
      return Promise.resolve(""); // concierge "replies" via the CLI, so the return is unused
    },
  } as unknown as ConciergeSession;
  const gateway = {} as never; // notify never touches the gateway
  const concierge = new Concierge({ config, session, gateway, ...(clock ? { ambientClock: clock } : {}) });
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
    blockedBy: [],
    projectId: "p",
    url: "http://x",
    updatedAt: "now",
    originChannel: CHAN,
    ...overrides,
  };
}

function comment(body: string): TicketComment {
  return { id: "c1", ticketId: "id-1", author: "beckett", body, createdAt: "now" };
}

const dispatcherComment = (text: string) => comment(`<!-- beckett:dispatcher -->\n${text}`);

test("relays a dispatcher milestone comment as one turn carrying the right --channel", async () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment("Review found issues → back to **in_progress** for re-work."),
  });
  await new Promise((r) => setTimeout(r, 0)); // notify frames + batches on a microtask (issue #25)
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  expect(asks[0]).toContain("in_progress");
  expect(asks[0]).not.toContain("beckett:dispatcher"); // marker stripped before the concierge sees it
});

test("incoming email is delivered through the automated-update turn queue with readable fields", async () => {
  const { concierge, asks } = harness();
  await concierge.notifyIncomingEmail({
    from: "sender@example.com",
    subject: "Please review",
    snippet: "The short body preview.",
    messageId: "agentmail-message-1",
  });
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("SYSTEM (incoming email");
  expect(asks[0]).toContain("sender@example.com");
  expect(asks[0]).toContain("Please review");
  expect(asks[0]).toContain("The short body preview.");
  expect(asks[0]).toContain("agentmail-message-1");
  expect(asks[0]).toContain("beckett mail read");
});

test("incoming email sees a same-subject loop closed minutes earlier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-mail-loop-"));
  try {
    const memory = createMemory({
      memoryDir: dir,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      git: false,
    });
    await openLoop(memory, {
      name: "github-2fa-enrollment",
      kind: "commitment",
      due: "2026-07-27",
      source: "browser-agent",
      description: "Authorize GitHub 2FA enrollment",
    });
    // Settlement uses today's date; an email moments later must still receive this context.
    await settleLoop(memory, "github-2fa-enrollment", "done", "Enrollment completed");

    const asks: string[] = [];
    const session = { ask: (message: string) => (asks.push(message), Promise.resolve("")) } as unknown as ConciergeSession;
    const concierge = new Concierge({ config, session, gateway: {} as never, memory });
    await concierge.notifyIncomingEmail({
      from: "github@example.com",
      subject: "Authorize GitHub 2FA enrollment",
      snippet: "Approve your enrollment.",
      messageId: "github-2fa-mail",
    });

    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("<open-loops>");
    expect(asks[0]).toContain("CLOSED");
    expect(asks[0]).toContain("Authorize GitHub 2FA enrollment");
    expect(asks[0]).toContain("external, untrusted content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routine.self frames a SYSTEM self-directed-sweep turn on the same askUpdate lane (issue #26)", async () => {
  const { concierge, asks } = harness();
  const res = await concierge.onBusRequest({
    cmd: "routine.self",
    args: { routineId: "morning-sweep", prompt: "look over the board and nudge anything stalled", channelId: CHAN },
  });
  expect(res.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 0)); // askUpdate is fire-and-forget onto the system session
  expect(asks.length).toBe(1);
  // Framed as SYSTEM, a scheduled self-directed sweep, and explicitly NOT a user message.
  expect(asks[0]).toContain("SYSTEM (scheduled self-directed sweep");
  expect(asks[0]).toContain("NOT a message from a user");
  // Carries the routine id, the origin channel, and its own prompt.
  expect(asks[0]).toContain("morning-sweep");
  expect(asks[0]).toContain("look over the board and nudge anything stalled");
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  // Permission to stay silent if there's nothing worth saying.
  expect(asks[0]).toContain("do nothing");
});

test("routine.self refuses without routineId/prompt/channelId (no half-formed self turn)", async () => {
  const { concierge, asks } = harness();
  const res = await concierge.onBusRequest({ cmd: "routine.self", args: { prompt: "x", channelId: CHAN } });
  expect(res.ok).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(0);
});

test("does NOT ping for the intermediate `→ in_review` advance (avoids the double-message)", () => {
  const { concierge, asks } = harness();
  // The person already has an ack; the `done` ping lands after review. This intermediate advance is
  // exactly the "okay, I did the thing" half of the back-to-back pair — it must stay silent.
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment("Implementation complete → **in_review**."),
  });
  expect(asks.length).toBe(0);
});

test("still surfaces a human-handoff that mentions in_review (no `→` arrow — keep it)", async () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment(
      "Review found issues, and this is rework cycle 3/3 — stopping automatic rework and leaving " +
        "this in **in_review** for a human to take over.",
    ),
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("human");
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

test("surfaces `done` from the state transition (the comment feed misses terminal tickets)", async () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" });
  await new Promise((r) => setTimeout(r, 0)); // done pings frame async (artifact-link fetch)
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`--channel ${CHAN}`);
  expect(asks[0]?.toLowerCase()).toContain("done");
});

test("the done ping carries the artifact link from the dispatcher's done comment (issue #21)", async () => {
  const asks: string[] = [];
  const session = {
    ask: (m: string) => {
      asks.push(m);
      return Promise.resolve("");
    },
  } as unknown as ConciergeSession;
  const tracker = {
    listComments: async () => [
      comment("<!-- beckett:dispatcher -->\nSelf-reviewed → **done** (one pass).\n\nShipped: https://github.com/0xbeckett/healthz"),
    ],
  };
  const concierge = new Concierge({ config, session, gateway: {} as never, tracker });
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("https://github.com/0xbeckett/healthz");
});

test("boot recovery (from: null) tells the user the ticket is being re-staffed (issue #21)", async () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: null, to: "in_progress" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("restarted");
});

test("warm-restart silent re-staff (from === to) does NOT ping the user (issue #60)", async () => {
  // The poller re-staffs a previously-seen active ticket by seeding a same-state transition so the
  // Dispatcher picks it up WITHOUT the `from: null` restart ping. The concierge must stay silent —
  // this is the phantom-ping-storm fix's user-facing guarantee.
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket(), from: "in_progress", to: "in_progress" });
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "in_review" }), from: "in_review", to: "in_review" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(0);
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
    comment: dispatcherComment("Review found issues → back to **in_progress** for re-work."),
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
  await new Promise((r) => setTimeout(r, 0));
  // ONE combined turn for the whole batch (issue #25): recovery + rework + done fold together;
  // created/human chatter AND the `→ in_review` advance are all skipped.
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("Review found issues");
  expect(asks[0]!.toLowerCase()).toContain("done");
  expect(asks[0]).toContain(`--channel ${CHAN}`);
});

test("routine noise (blockers-cleared start, retry heartbeat) never costs a turn (issue #25)", async () => {
  const { concierge, asks } = harness();
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment("All blockers done (OPS-7) → starting now."),
  });
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: dispatcherComment(
      "The worker stopped without finishing. I committed its work-in-progress and am retrying (attempt 2/3), continuing from the committed work.",
    ),
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(0);
});

// ── notify re-fire idempotency (the done-update loop) ──────────────────────────────────────
// A `done` event can be re-delivered to notify() — the instant-milestone path racing the ≤5s poll
// re-emit, an outbox replay, or an ambiguous `beckett discord reply` ack that upstream retries
// mistake for "not delivered". The dispatch dedupes per (ticket, milestone) so one milestone is one
// turn even when it arrives repeatedly; a real, distinct milestone still fires.

test("a re-delivered done event notifies at most once (ambiguous-ack re-fire loop)", async () => {
  const { concierge, asks } = harness();
  const done: PollEvent = { kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" };
  // Four back-to-back deliveries of the SAME done milestone — exactly the observed 4x re-fire.
  concierge.notify(done);
  concierge.notify(done);
  concierge.notify(done);
  concierge.notify(done);
  await new Promise((r) => setTimeout(r, 0)); // done pings frame async (artifact-link fetch)
  expect(asks.length).toBe(1);
  expect(asks[0]?.toLowerCase()).toContain("done");
});

test("dedupe is per-ticket — two different tickets reaching done each fire once", async () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket({ id: "id-A", state: "done" }), from: "in_review", to: "done" });
  concierge.notify({ kind: "state_changed", ticket: ticket({ id: "id-A", state: "done" }), from: "in_review", to: "done" });
  concierge.notify({ kind: "state_changed", ticket: ticket({ id: "id-B", state: "done" }), from: "in_review", to: "done" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2); // one per distinct ticket, re-delivery of A suppressed
});

test("a genuinely-new milestone (a distinct dispatcher comment) still fires after a done ping", async () => {
  const { concierge, asks } = harness();
  concierge.notify({ kind: "state_changed", ticket: ticket({ state: "done" }), from: "in_review", to: "done" });
  await new Promise((r) => setTimeout(r, 0));
  // A different milestone on the same ticket — distinct comment id, so it is NOT the same key.
  concierge.notify({
    kind: "comment_added",
    ticket: ticket(),
    comment: { id: "c-later", ticketId: "id-1", author: "beckett", body: "<!-- beckett:dispatcher -->\nReview found issues → back to **in_progress** for re-work.", createdAt: "later" },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2);
});

test("outside the dedupe window a re-entry fires again (design re-review after human feedback)", async () => {
  const clock = new FakeClock();
  const { concierge, asks } = harness(clock);
  const gate: PollEvent = { kind: "state_changed", ticket: ticket({ state: "design_review" }), from: "design", to: "design_review" };
  concierge.notify(gate);
  await new Promise((r) => setTimeout(r, 0));
  concierge.notify(gate); // immediate re-delivery — suppressed
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  clock.advance(6 * 60_000); // past the 5-minute window: a real second parked-for-review is legitimate
  concierge.notify(gate);
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2);
});
