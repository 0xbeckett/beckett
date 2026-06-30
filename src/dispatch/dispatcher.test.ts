/**
 * Dispatcher state-machine tests (`src/dispatch/dispatcher.ts`).
 * We mock the spawn helper (`./spawn.ts`) and the worktree git ops (`../worker/worktree.ts`)
 * so the full state machine — spawn-on-state, advance-on-finish, steering, cancel, review
 * pass/fail, and the concurrency cap — is exercised deterministically with no real workers.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { Config } from "../types.ts";
import type { Ticket, TicketState, PollEvent, HarnessSpec, PlaneComment } from "../plane/types.ts";

// ── controllable fake worker handle + spawn mock ────────────────────────────────────────────
let spawnCalls: { ticketId: string; stage: string; harness: HarnessSpec }[] = [];
let created: any[] = [];
let counter = 0;
/**
 * When set, every {@link fakeSpawn} suspends on this gate AFTER recording the call but BEFORE
 * returning a handle — i.e. it simulates the real `spawnWorker`'s slow worktree-alloc + harness
 * launch. This holds workers in the "admitted, handle not yet registered" window so tests can
 * fire duplicate/competing events into that window and prove the dedup + cap reservation holds.
 */
let spawnGate: Promise<void> | null = null;

function makeHandle(ticket: Ticket, stage: string) {
  const doneCbs = new Set<(s: "success" | "error", sum: string) => void>();
  let result: any = null;
  let state = "running";
  const h: any = {
    id: `wk_${++counter}`,
    workerId: `wk_${counter}`,
    ticketId: ticket.id,
    stage,
    workspace: `/tmp/fake-wt/${counter}`,
    branch: `beckett/wk_${counter}/${ticket.identifier}`,
    get state() {
      return state;
    },
    get result() {
      return result;
    },
    nudges: [] as string[],
    aborted: false,
    reaped: false,
    async nudge(t: string) {
      h.nudges.push(t);
    },
    async abort() {
      h.aborted = true;
      state = "aborted";
    },
    onDone(cb: (s: "success" | "error", sum: string) => void) {
      if (result) cb(result.status, result.summary);
      else doneCbs.add(cb);
    },
    onFinished(cb: (s: "success" | "error", sum: string) => void) {
      h.onDone(cb);
    },
    async reap() {
      h.reaped = true;
    },
    // test trigger: complete the worker with a status + optional structured done-signal
    finish(status: "success" | "error", summary: string, structured: unknown = null) {
      result = { status, summary, structured };
      state = status === "success" ? "review" : "failed";
      for (const cb of doneCbs) cb(status, summary);
    },
  };
  return h;
}

const fakeSpawn = async (args: any) => {
  spawnCalls.push({ ticketId: args.ticket.id, stage: args.stage, harness: args.harness });
  if (spawnGate) await spawnGate; // simulate slow worktree alloc + harness launch
  const h = makeHandle(args.ticket, args.stage);
  created.push(h);
  return h;
};

let provisioned: string[] = [];
mock.module("./spawn.ts", () => ({ spawnWorker: fakeSpawn, spawnTicketWorker: fakeSpawn }));
mock.module("../worker/worktree.ts", () => ({
  commitWorktree: async () => ({ committed: false, sha: null }),
  headSha: async () => "base000", // v3.1 per-ticket diff base (fake repo has no real HEAD)
  currentBranch: async () => "main",
  ensureProjectRepo: async (repoRoot: string, slug: string) => {
    provisioned.push(slug);
  },
}));

const { Dispatcher, BECKETT_COMMENT_MARKER } = await import("./dispatcher.ts");

// ── fake Plane client ─────────────────────────────────────────────────────────────────────
class FakeClient {
  setStateCalls: { id: string; state: TicketState }[] = [];
  comments: { ticketId: string; body: string }[] = [];
  /** Board the dispatcher reads for dependency promotion; tests seed it. setState mutates it too. */
  board: Ticket[] = [];
  async setState(id: string, state: TicketState) {
    this.setStateCalls.push({ id, state });
    const t = this.board.find((b) => b.id === id);
    if (t) t.state = state;
  }
  async addComment(ticketId: string, body: string): Promise<PlaneComment> {
    this.comments.push({ ticketId, body });
    return { id: `c${this.comments.length}`, ticketId, author: "beckett", body, createdAt: "now" };
  }
  async listIssues(): Promise<Ticket[]> {
    return this.board;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: over.id ?? "tkt-1",
    identifier: over.identifier ?? "OPS-1",
    title: over.title ?? "Do a thing",
    description: "",
    body: over.body ?? "the body",
    state: over.state ?? "in_progress",
    assignees: [],
    casting: over.casting ?? {},
    criteria: over.criteria ?? ["it works"],
    blockedBy: over.blockedBy ?? [],
    ...(over.project ? { project: over.project } : {}),
    projectId: "proj-1",
    url: "http://x",
    updatedAt: "now",
  };
}

function cfg(max_workers = 2): Config {
  return {
    concurrency: { max_workers },
    models: { reviewer: "claude-opus-4-8" },
  } as unknown as Config;
}

function stateChanged(ticket: Ticket, to: TicketState, from: TicketState | null = null): PollEvent {
  return { kind: "state_changed", ticket, from, to };
}

function newDispatcher(max_workers = 2) {
  const client = new FakeClient();
  const d = new Dispatcher({ client, config: cfg(max_workers), resolveRepoRoot: () => "/tmp/repo" });
  return { d, client };
}

beforeEach(() => {
  spawnCalls = [];
  created = [];
  counter = 0;
  spawnGate = null;
  provisioned = [];
});

// ── tests ─────────────────────────────────────────────────────────────────────────────────
describe("spawn on state change", () => {
  test("in_progress spawns an implement worker with the cast harness", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket({ casting: { implement: { harness: "codex" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ stage: "implement", harness: { harness: "codex" } });
  });

  test("implement defaults to claude when uncast", async () => {
    const { d } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    expect(spawnCalls[0]!.harness.harness).toBe("claude");
  });

  test("in_review spawns a reviewer defaulting to claude/opus", async () => {
    const { d } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    expect(spawnCalls[0]).toMatchObject({ stage: "review", harness: { harness: "claude", model: "claude-opus-4-8" } });
  });

  test("does not double-staff a ticket that already has a live worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("advance on finish", () => {
  test("implement success → setState(in_review) + a marked summary comment", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    created[0].finish("success", "did it");
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_review" }]);
    expect(client.comments[0]!.body.startsWith(BECKETT_COMMENT_MARKER)).toBe(true);
  });

  test("implement error → no state change, left for a human", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    created[0].finish("error", "blew up");
    await tick();
    expect(client.setStateCalls).toHaveLength(0);
  });

  test("v3.1: self-review tier (low effort) → done in one pass, no in_review relay", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "shipped it");
    await tick();
    // straight to done — never routed through in_review, so only one spawn ever happened
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    expect(spawnCalls).toHaveLength(1);
    expect(client.comments[0]!.body).toContain("one pass");
  });

  test("v3.1: publishes the project repo to GitHub on done and links the URL in the comment", async () => {
    const client = new FakeClient();
    const calls: { slug: string; repoRoot: string; description: string }[] = [];
    const d = new Dispatcher({
      client,
      config: cfg(),
      resolveRepoRoot: () => "/home/beckett/Projects/balloons-game",
      publishRepo: async (a) => {
        calls.push(a);
        return { url: "https://github.com/0xbeckett/balloons-game" };
      },
    });
    const ticket = makeTicket({
      project: "Balloons Game!",
      title: "Build balloons",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "shipped it");
    await tick();
    // Published deterministically with the slugified project + its repo root, and the real URL
    // (not a guess) is woven into the done comment so the Concierge can hand it out.
    expect(calls).toEqual([
      { slug: "balloons-game", repoRoot: "/home/beckett/Projects/balloons-game", description: "Build balloons" },
    ]);
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    expect(client.comments.at(-1)!.body).toContain("https://github.com/0xbeckett/balloons-game");
  });

  test("v3.1: a GitHub publish failure still lets the ticket reach done (best-effort)", async () => {
    const client = new FakeClient();
    const d = new Dispatcher({
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/repo",
      publishRepo: async () => {
        throw new Error("gh down");
      },
    });
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "shipped it");
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    expect(client.comments.some((c) => c.body.includes("Couldn't push to GitHub"))).toBe(true);
  });

  test("v3.1: explicit reviewTier 'fresh' forces in_review even at low effort", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({
      casting: { implement: { harness: "claude", effort: "low", reviewTier: "fresh" } },
    });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "did it");
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_review" }]);
  });

  test("review verdict complete → done", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    created[0].finish("success", "looks good", { status: "complete" });
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
  });

  test("review verdict blocked → back to in_progress for re-work", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    created[0].finish("success", "missing tests", { status: "blocked" });
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_progress" }]);
  });
});

describe("v3.1 project-repo provisioning", () => {
  test("a ticket's own project repo is provisioned before the worker spawns", async () => {
    const { d } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ identifier: "OPS-7" }), "in_progress"));
    await tick();
    expect(provisioned).toContain("ops-7"); // slug of the (unnamed) ticket → its own sandbox repo
    expect(spawnCalls).toHaveLength(1);
  });

  test("an explicit project slug routes the worker to that repo", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket({ project: "Balloons Game!" });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    expect(provisioned).toContain("balloons-game"); // sanitized slug
  });
});

describe("steering + cancel", () => {
  test("a human comment on a live ticket nudges the worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const comment: PlaneComment = { id: "c1", ticketId: ticket.id, author: "jason", body: "cap it at 10s", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });
    expect(created[0].nudges).toEqual(["cap it at 10s"]);
  });

  test("Beckett's own marked comment never self-nudges", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const own: PlaneComment = { id: "c1", ticketId: ticket.id, author: "beckett", body: `${BECKETT_COMMENT_MARKER}\nadvanced`, createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment: own });
    expect(created[0].nudges).toHaveLength(0);
  });

  test("cancelled aborts and reaps the live worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    await d.handle({ kind: "cancelled", ticket });
    expect(created[0].aborted).toBe(true);
    expect(created[0].reaped).toBe(true);
    expect(d.live()).toHaveLength(0);
  });
});

describe("rework cap", () => {
  test("repeated review failures stop auto-rework after MAX_REWORK_CYCLES", async () => {
    const { d, client } = newDispatcher(5);
    const ticket = makeTicket({ state: "in_review" });
    for (let i = 0; i < 3; i++) {
      await d.handle(stateChanged(ticket, "in_review"));
      await tick();
      created[created.length - 1].finish("success", "still broken", { status: "blocked" });
      await tick();
    }
    const backToProgress = client.setStateCalls.filter((c) => c.state === "in_progress");
    expect(backToProgress).toHaveLength(2); // cycles 1 & 2 rework; cycle 3 stops, awaiting a human
    expect(client.comments.some((c) => c.body.includes("stopping"))).toBe(true);
  });
});

describe("concurrency cap", () => {
  test("over-cap spawns queue and pump when a slot frees", async () => {
    const { d } = newDispatcher(1);
    const a = makeTicket({ id: "a", identifier: "OPS-A" });
    const b = makeTicket({ id: "b", identifier: "OPS-B" });
    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1); // b queued behind the cap of 1

    created[0].finish("success", "a done"); // frees the slot → pump spawns b
    await tick();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.ticketId).toBe("b");
  });

  // ── regression: the runaway fan-out (cap=2 but 18 workers in prod) ──────────────────────────
  // Root cause: a worker's handle only lands in `workers` AFTER the slow async spawn, so duplicate
  // events for the same ticket arriving during that gap each passed `workers.has()` and launched
  // another worker; the second `workers.set` overwrote (orphaning the first) and `atCap()`
  // undercounted, so the cap never tripped. The fix reserves the ticket SYNCHRONOUSLY in
  // `staffing` the instant a spawn is admitted. These tests fire events INTO the spawn gap.

  test("duplicate in_progress events during the spawn gap spawn exactly one worker", async () => {
    const { d } = newDispatcher(5); // cap high enough that only per-ticket dedup can stop dups
    const ticket = makeTicket();
    let release!: () => void;
    spawnGate = new Promise<void>((r) => (release = r));

    // Fire 5 identical events with NO await between them: all land while the first spawn is still
    // mid-flight (handle not yet in `workers`). Pre-fix, each would launch its own worker.
    const inflight = Array.from({ length: 5 }, () => d.handle(stateChanged(ticket, "in_progress")));
    release();
    await Promise.all(inflight);
    await tick();

    expect(spawnCalls).toHaveLength(1);
    expect(d.live()).toHaveLength(1);
  });

  test("global cap is never bypassed by a burst of distinct-ticket events", async () => {
    const { d } = newDispatcher(2);
    let release!: () => void;
    spawnGate = new Promise<void>((r) => (release = r));

    // 5 different tickets all enter in_progress at once; with the spawn gated, all 5 events land
    // before any handle registers. Only 2 (the cap) may be admitted; the rest queue.
    const tickets = Array.from({ length: 5 }, (_, i) => makeTicket({ id: `t${i}`, identifier: `OPS-${i}` }));
    await Promise.all(tickets.map((t) => d.handle(stateChanged(t, "in_progress"))));
    expect(spawnCalls).toHaveLength(2); // cap respected even though no handle has registered yet

    release();
    await tick();
    expect(d.live()).toHaveLength(2); // still exactly the cap; the other 3 are queued
    expect(spawnCalls).toHaveLength(2);
  });
});

describe("dependency promotion (beckett plan DAG)", () => {
  test("a held dependent is promoted to in_progress when its only blocker finishes", async () => {
    const { d, client } = newDispatcher();
    const blocker = makeTicket({ id: "a", identifier: "OPS-A", state: "done" });
    const dependent = makeTicket({ id: "b", identifier: "OPS-B", state: "backlog", blockedBy: ["OPS-A"] });
    client.board = [blocker, dependent];

    await d.handle(stateChanged(blocker, "done", "in_review"));
    await tick();

    expect(client.setStateCalls).toContainEqual({ id: "b", state: "in_progress" });
    expect(client.comments.some((c) => c.ticketId === "b" && c.body.includes("All blockers done"))).toBe(true);
  });

  test("a dependent with a still-unfinished second blocker stays held", async () => {
    const { d, client } = newDispatcher();
    const a = makeTicket({ id: "a", identifier: "OPS-A", state: "done" });
    const b = makeTicket({ id: "b", identifier: "OPS-B", state: "in_progress" }); // not done yet
    const c = makeTicket({ id: "c", identifier: "OPS-C", state: "backlog", blockedBy: ["OPS-A", "OPS-B"] });
    client.board = [a, b, c];

    await d.handle(stateChanged(a, "done", "in_review"));
    await tick();

    expect(client.setStateCalls.some((s) => s.id === "c")).toBe(false); // still waiting on OPS-B
  });

  test("independent (no-dep) tickets are never touched by promotion", async () => {
    const { d, client } = newDispatcher();
    const a = makeTicket({ id: "a", identifier: "OPS-A", state: "done" });
    const indep = makeTicket({ id: "z", identifier: "OPS-Z", state: "backlog", blockedBy: [] });
    client.board = [a, indep];

    await d.handle(stateChanged(a, "done", "in_review"));
    await tick();

    expect(client.setStateCalls.some((s) => s.id === "z")).toBe(false);
  });
});
