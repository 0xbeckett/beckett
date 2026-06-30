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
  const h = makeHandle(args.ticket, args.stage);
  created.push(h);
  return h;
};

mock.module("./spawn.ts", () => ({ spawnWorker: fakeSpawn, spawnTicketWorker: fakeSpawn }));
mock.module("../worker/worktree.ts", () => ({
  commitWorktree: async () => ({ committed: false, sha: null }),
}));

const { Dispatcher, BECKETT_COMMENT_MARKER } = await import("./dispatcher.ts");

// ── fake Plane client ─────────────────────────────────────────────────────────────────────
class FakeClient {
  setStateCalls: { id: string; state: TicketState }[] = [];
  comments: { ticketId: string; body: string }[] = [];
  async setState(id: string, state: TicketState) {
    this.setStateCalls.push({ id, state });
  }
  async addComment(ticketId: string, body: string): Promise<PlaneComment> {
    this.comments.push({ ticketId, body });
    return { id: `c${this.comments.length}`, ticketId, author: "beckett", body, createdAt: "now" };
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
});
