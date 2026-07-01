/**
 * Dispatcher state-machine tests (`src/dispatch/dispatcher.ts`).
 * We mock the spawn helper (`./spawn.ts`) and the worktree git ops (`../worker/worktree.ts`)
 * so the full state machine — spawn-on-state, advance-on-finish, steering, cancel, review
 * pass/fail, and the concurrency cap — is exercised deterministically with no real workers.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types.ts";
import type { Ticket, TicketState, PollEvent, HarnessSpec, PlaneComment } from "../plane/types.ts";

// ── controllable fake worker handle + spawn mock ────────────────────────────────────────────
let spawnCalls: {
  ticketId: string;
  stage: string;
  harness: HarnessSpec;
  baseRef: string;
  resumeSessionId?: string;
}[] = [];
let created: any[] = [];
let counter = 0;
/**
 * When set, every {@link fakeSpawn} suspends on this gate AFTER recording the call but BEFORE
 * returning a handle — i.e. it simulates the real `spawnWorker`'s slow worktree-alloc + harness
 * launch. This holds workers in the "admitted, handle not yet registered" window so tests can
 * fire duplicate/competing events into that window and prove the dedup + cap reservation holds.
 */
let spawnGate: Promise<void> | null = null;

function makeHandle(ticket: Ticket, stage: string, harness = "claude") {
  const doneCbs = new Set<(s: "success" | "error", sum: string) => void>();
  let result: any = null;
  let state = "running";
  const h: any = {
    id: `wk_${++counter}`,
    workerId: `wk_${counter}`,
    ticketId: ticket.id,
    stage,
    harness,
    workspace: `/tmp/fake-wt/${counter}`,
    branch: `beckett/wk_${counter}/${ticket.identifier}`,
    sessionId: `sess-${counter}`,
    pid: 1000 + counter,
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
    // test trigger: complete the worker with a status + optional structured done-signal.
    // `timedOut` simulates the driver's backstop wall-clock finish (subtype error_wall_clock_cap).
    finish(
      status: "success" | "error",
      summary: string,
      structured: unknown = null,
      timedOut = false,
      errorClass?: string,
    ) {
      result = { status, summary, structured, timedOut, errorClass };
      state = status === "success" ? "review" : "failed";
      for (const cb of doneCbs) cb(status, summary);
    },
  };
  return h;
}

let failNextResumeSpawn = false;
const fakeSpawn = async (args: any) => {
  spawnCalls.push({
    ticketId: args.ticket.id,
    stage: args.stage,
    harness: args.harness,
    baseRef: args.baseRef,
    resumeSessionId: args.resumeSessionId,
  });
  if (args.resumeSessionId && failNextResumeSpawn) {
    failNextResumeSpawn = false;
    throw new Error("stale session — cannot resume");
  }
  if (spawnGate) await spawnGate; // simulate slow worktree alloc + harness launch
  const h = makeHandle(args.ticket, args.stage, args.harness.harness);
  created.push(h);
  return h;
};

let provisioned: string[] = [];
let commitResult: { committed: boolean; sha: string | null } = { committed: true, sha: "commit000" };
let commitCalls: { workspace: string; message: string }[] = [];
let diffSince = true;
mock.module("./spawn.ts", () => ({ spawnWorker: fakeSpawn, spawnTicketWorker: fakeSpawn }));
mock.module("../worker/worktree.ts", () => ({
  commitWorktree: async (workspace: string, message: string) => {
    commitCalls.push({ workspace, message });
    return commitResult;
  },
  headSha: async () => "base000", // v3.1 per-ticket diff base (fake repo has no real HEAD)
  hasDiffSince: async () => diffSince,
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
  failSetState = 0;
  failAddComment = 0;
  /** Board the dispatcher reads for dependency promotion; tests seed it. setState mutates it too. */
  board: Ticket[] = [];
  async getIssue(id: string): Promise<Ticket | null> {
    return this.board.find((b) => b.id === id) ?? null;
  }
  async setState(id: string, state: TicketState) {
    if (this.failSetState > 0) {
      this.failSetState--;
      throw new Error("Plane state write failed");
    }
    this.setStateCalls.push({ id, state });
    const t = this.board.find((b) => b.id === id);
    if (t) t.state = state;
  }
  async addComment(ticketId: string, body: string): Promise<PlaneComment> {
    if (this.failAddComment > 0) {
      this.failAddComment--;
      throw new Error("Plane comment write failed");
    }
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
    harness: {
      claude: { enabled: true },
      codex: { enabled: true },
      pi: { enabled: true },
    },
  } as unknown as Config;
}

function stateChanged(ticket: Ticket, to: TicketState, from: TicketState | null = null): PollEvent {
  return { kind: "state_changed", ticket, from, to };
}

function doneSignal(
  status: "complete" | "blocked" | "partial",
  over: Partial<{ summary: string; filesChanged: string[]; checksRun: string[] | null; blockedReason: string | null }> = {},
) {
  return {
    status,
    summary: over.summary ?? (status === "complete" ? "complete" : "not complete"),
    filesChanged: over.filesChanged ?? ["src/app.ts"],
    checksRun: over.checksRun ?? ["bun test"],
    blockedReason: over.blockedReason ?? (status === "complete" ? null : "needs more work"),
  };
}

function newDispatcher(
  max_workers = 2,
  opts: {
    advanceOutboxPath?: string;
    runtimeStatePath?: string;
    preflight?: (harness: string) => Promise<{ ok: boolean; problems: string[] }>;
  } = {},
) {
  const client = new FakeClient();
  const d = new Dispatcher({
    client,
    config: cfg(max_workers),
    resolveRepoRoot: (ticket) => `/tmp/repo/${ticket.project ?? ticket.identifier}`,
    ...opts,
  });
  return { d, client };
}

beforeEach(() => {
  spawnCalls = [];
  created = [];
  counter = 0;
  spawnGate = null;
  provisioned = [];
  commitResult = { committed: true, sha: "commit000" };
  commitCalls = [];
  diffSince = true;
  failNextResumeSpawn = false;
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

  test("a cast naming a disabled harness falls back to claude, keeping the effort", async () => {
    const client = new FakeClient();
    const config = cfg();
    (config.harness as unknown as { codex: { enabled: boolean } }).codex.enabled = false;
    const d = new Dispatcher({
      client,
      config,
      resolveRepoRoot: (ticket) => `/tmp/repo/${ticket.project ?? ticket.identifier}`,
    });
    const ticket = makeTicket({ casting: { implement: { harness: "codex", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ harness: { harness: "claude", effort: "low" } });
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

  test("Plane write failure after finish is queued and replayed from the advance outbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-advance-outbox-"));
    try {
      const outbox = join(dir, "advance.jsonl");
      const { d, client } = newDispatcher(2, { advanceOutboxPath: outbox });
      const ticket = makeTicket();
      client.board = [ticket];
      client.failSetState = 1;

      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "did it");
      await tick();

      expect(client.setStateCalls).toEqual([]);
      expect(readFileSync(outbox, "utf8")).toContain("\"state\":\"in_review\"");

      await d.replayAdvances();
      expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_review" }]);
      expect(client.comments[0]!.body).toContain("Implementation complete");
      expect(readFileSync(outbox, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("queued advance never reopens a ticket a human moved to cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-advance-cancel-"));
    try {
      const outbox = join(dir, "advance.jsonl");
      const { d, client } = newDispatcher(2, { advanceOutboxPath: outbox });
      const ticket = makeTicket();
      client.board = [ticket];
      client.failSetState = 1;

      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "did it");
      await tick();
      ticket.state = "cancelled";

      await d.replayAdvances();
      expect(client.setStateCalls).toEqual([]);
      expect(client.comments).toEqual([]);
      expect(readFileSync(outbox, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const settle = async () => {
    for (let i = 0; i < 8; i++) await tick();
  };

  test("implement incomplete (error) → commits WIP, comments, retries in place (no state change)", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    created[0].finish("error", "blew up");
    await settle();
    // Retried in place: a SECOND implement worker was spawned, and the ticket was NOT moved out of
    // in_progress (it's actively staffed again, never silently wedged).
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    expect(client.setStateCalls).toHaveLength(0);
    expect(client.comments.at(-1)!.body).toContain("retrying (attempt 1/3)");
  });

  test("implement timeout (backstop cap) → status comment names the cap and retries", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    created[0].finish("error", "ran long", null, /*timedOut*/ true);
    await settle();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const body = client.comments.at(-1)!.body;
    expect(body).toContain("safety cap");
    expect(body).toContain("Where it stopped:");
    expect(client.setStateCalls).toHaveLength(0);
  });

  test("implement incomplete past the retry cap → returns ticket to todo (never stuck in_progress)", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    // 4 incomplete finishes: 3 retries, then the 4th exhausts the cap and returns to todo.
    for (let i = 0; i < 4; i++) {
      await settle();
      const live = created.at(-1)!;
      live.finish("error", `stall ${i}`, null, true);
    }
    await settle();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "todo" }]);
    expect(client.comments.at(-1)!.body).toContain("moving this back to **todo**");
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

  test("done worker promotes unblocked dependents immediately, without waiting for a poller done event", async () => {
    const { d, client } = newDispatcher();
    const blocker = makeTicket({
      id: "a",
      identifier: "OPS-A",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    const dependent = makeTicket({
      id: "b",
      identifier: "OPS-B",
      state: "backlog",
      blockedBy: ["OPS-A"],
    });
    client.board = [blocker, dependent];

    await d.handle(stateChanged(blocker, "in_progress"));
    await tick();
    created[0].finish("success", "a done");
    await tick();

    expect(client.setStateCalls).toContainEqual({ id: "a", state: "done" });
    expect(client.setStateCalls).toContainEqual({ id: "b", state: "in_progress" });
    expect(client.comments.some((c) => c.ticketId === "b" && c.body.includes("All blockers done"))).toBe(true);
  });

  test("v3.1: publishes the project repo to GitHub on done and links the URL in the comment", async () => {
    const client = new FakeClient();
    const calls: { slug: string; repoRoot: string; description: string; ticket?: string }[] = [];
    const d = new Dispatcher({
      client,
      config: cfg(),
      resolveRepoRoot: () => "/home/beckett/Projects/balloons-game",
      publishRepo: async (a) => {
        calls.push(a);
        return { url: "https://github.com/0xbeckett/balloons-game", kind: "pushed" as const };
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
    // Published deterministically with the slugified project + its repo root + the ticket id, and the
    // real URL (not a guess) is woven into the done comment so the Concierge can hand it out.
    expect(calls).toEqual([
      {
        slug: "balloons-game",
        repoRoot: "/home/beckett/Projects/balloons-game",
        description: "Build balloons",
        ticket: "OPS-1",
      },
    ]);
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    expect(client.comments.at(-1)!.body).toContain("https://github.com/0xbeckett/balloons-game");
  });

  test("v3.1: a `pr` publish words the done comment as needing a human merge (not 'shipped')", async () => {
    const client = new FakeClient();
    const d = new Dispatcher({
      client,
      config: cfg(),
      resolveRepoRoot: () => "/home/beckett/Projects/probabilities",
      publishRepo: async () => ({
        url: "https://github.com/SSHdotCodes/probabilities",
        kind: "pr" as const,
        prUrl: "https://github.com/SSHdotCodes/probabilities/pull/7",
      }),
    });
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "did it");
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    const done = client.comments.at(-1)!.body;
    expect(done).toContain("needs your merge");
    expect(done).toContain("/pull/7");
  });

  test("v3.1: a GitHub publish FAILURE parks the ticket for courier work", async () => {
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
    // Publish failed → the ticket must NOT be marked done (that was the false-done bug), but it
    // also must not stay in an active state that restarts will re-staff.
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "todo" }]);
    expect(client.comments.some((c) => c.body.includes("couldn't publish it to GitHub"))).toBe(true);
    expect(client.comments.some((c) => c.body.includes("no worker keeps burning tokens"))).toBe(true);
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
    created[0].finish("success", "looks good", doneSignal("complete"));
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
  });

  test("review verdict blocked → back to in_progress for re-work", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    created[0].finish("success", "missing tests", doneSignal("blocked"));
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_progress" }]);
  });

  test("self-tier implement blocked signal goes to fresh review instead of done", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "blocked", doneSignal("blocked"));
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_review" }]);
    expect(client.comments.at(-1)!.body).toContain("self-review is disabled");
  });

  test("review success with no structured verdict retries review and never auto-passes", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    created[0].finish("success", "plain text only");
    await tick();
    await tick();
    expect(client.setStateCalls).toHaveLength(0);
    expect(spawnCalls.filter((c) => c.stage === "review")).toHaveLength(2);
    expect(client.comments.at(-1)!.body).toContain("schema-valid structured verdict");
  });

  test("reviewer crash retries review without consuming a rework cycle", async () => {
    const { d, client } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    created[0].finish("error", "driver crashed");
    await tick();
    await tick();
    expect(client.setStateCalls).toHaveLength(0);
    expect(spawnCalls.filter((c) => c.stage === "review")).toHaveLength(2);
    expect(client.comments.at(-1)!.body).toContain("does not count as a rework cycle");
    expect(client.comments.at(-1)!.body).not.toContain("Review found issues");
  });

  test("zero-diff self-tier implement is held for fresh review instead of done", async () => {
    commitResult = { committed: false, sha: null };
    diffSince = false;
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "claimed done", doneSignal("complete", { filesChanged: [] }));
    await tick();
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "in_review" }]);
    expect(client.comments.at(-1)!.body).toContain("no diff");
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
    const comment: PlaneComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "cap it at 10s", createdAt: "now" };
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

  test("parking a live ticket stops the worker and commits WIP", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    await d.handle(stateChanged({ ...ticket, state: "todo" }, "todo", "in_progress"));

    expect(created[0].aborted).toBe(true);
    expect(created[0].reaped).toBe(true);
    expect(d.live()).toHaveLength(0);
    expect(client.comments.at(-1)!.body).toContain("Ticket moved to **todo**");
    expect(client.comments.at(-1)!.body).toContain("commit000");
  });

  test("shutdown drain aborts live workers, commits WIP, and drops queued spawns", async () => {
    const { d } = newDispatcher(1);
    const a = makeTicket({ id: "a", identifier: "OPS-A" });
    const b = makeTicket({ id: "b", identifier: "OPS-B" });

    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();

    const result = await d.drainForShutdown("SIGTERM", 1000);
    await tick();

    expect(result).toEqual({ liveWorkers: 1, queuedSpawns: 1, completed: 1, timedOut: false });
    expect(created[0].aborted).toBe(true);
    expect(created[0].reaped).toBe(true);
    expect(commitCalls).toEqual([
      { workspace: "/tmp/fake-wt/1", message: "beckett: OPS-A WIP (wk_1)" },
    ]);
    expect(d.live()).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("rework cap", () => {
  test("repeated review failures stop auto-rework after MAX_REWORK_CYCLES", async () => {
    const { d, client } = newDispatcher(5);
    const ticket = makeTicket({ state: "in_review" });
    for (let i = 0; i < 3; i++) {
      await d.handle(stateChanged(ticket, "in_review"));
      await tick();
      created[created.length - 1].finish("success", "still broken", doneSignal("blocked"));
      await tick();
    }
    const backToProgress = client.setStateCalls.filter((c) => c.state === "in_progress");
    expect(backToProgress).toHaveLength(2); // cycles 1 & 2 rework; cycle 3 stops, awaiting a human
    expect(client.comments.some((c) => c.body.includes("stopping"))).toBe(true);
  });

  test("rework count survives dispatcher restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-state-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket({ state: "in_review" });
      const { d: before, client } = newDispatcher(5, { runtimeStatePath });

      for (let i = 0; i < 2; i++) {
        await before.handle(stateChanged(ticket, "in_review"));
        await tick();
        created.at(-1)!.finish("success", "still broken", doneSignal("blocked"));
        await tick();
      }

      const after = new Dispatcher({
        client,
        config: cfg(5),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
      });
      await after.handle(stateChanged(ticket, "in_review"));
      await tick();
      created.at(-1)!.finish("success", "still broken", doneSignal("blocked"));
      await tick();

      expect(client.setStateCalls.filter((c) => c.state === "in_progress")).toHaveLength(2);
      expect(client.comments.at(-1)!.body).toContain("rework cycle 3/3");
      expect(client.comments.at(-1)!.body).toContain("stopping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("review base SHA survives dispatcher restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-base-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket();
      const { d: before } = newDispatcher(2, { runtimeStatePath });

      await before.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "implemented");
      await tick();

      const { d: after } = newDispatcher(2, { runtimeStatePath });
      await after.handle(stateChanged({ ...ticket, state: "in_review" }, "in_review"));
      await tick();

      expect(spawnCalls.at(-1)).toMatchObject({ stage: "review", baseRef: "base000" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── issue #20: crash-recovery worker ledger + session resume ─────────────────────────────
describe("crash recovery", () => {
  function readState(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  test("spawn writes the worker ledger; clean finish removes the entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-ledger-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const { d } = newDispatcher(2, { runtimeStatePath });
      const ticket = makeTicket();
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();

      const live = readState(runtimeStatePath).liveWorkers;
      expect(live[ticket.id]).toMatchObject({
        stage: "implement",
        sessionId: "sess-1",
        pid: 1001,
        harness: "claude",
      });

      created[0].finish("success", "done");
      await tick();
      expect(readState(runtimeStatePath).liveWorkers).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("boot sweeps the orphan, commits ghost WIP, and resumes the interrupted session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-recover-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket();
      const { d: before } = newDispatcher(2, { runtimeStatePath });
      await before.handle(stateChanged(ticket, "in_progress"));
      await tick();
      // No finish — simulate the daemon dying with the worker live (ledger entry persists).

      const swept: { pid: number; bin: string }[] = [];
      const { client } = { client: new FakeClient() };
      const after = new Dispatcher({
        client,
        config: cfg(2),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
        sweepOrphan: (pid, bin) => {
          swept.push({ pid, bin });
          return true;
        },
      });
      await after.recoverFromCrash();

      expect(swept).toEqual([{ pid: 1001, bin: "claude" }]);
      // Ghost WIP committed in the recorded repo root with the restart marker.
      expect(commitCalls.some((c) => c.message.includes("restart WIP"))).toBe(true);
      // The on-disk ledger is cleared once recovery consumed it.
      expect(readState(runtimeStatePath).liveWorkers).toEqual({});

      // Re-staff the same stage → the spawn resumes the persisted session.
      await after.handle(stateChanged(ticket, "in_progress"));
      await tick();
      expect(spawnCalls.at(-1)).toMatchObject({ stage: "implement", resumeSessionId: "sess-1" });

      // The hint is consumed: a later same-stage spawn is fresh.
      created.at(-1)!.finish("error", "crashed again");
      await tick();
      const retry = spawnCalls.at(-1)!;
      expect(retry.resumeSessionId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed resume falls back to a fresh worker instead of stranding the ticket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-resumefail-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket();
      const { d: before } = newDispatcher(2, { runtimeStatePath });
      await before.handle(stateChanged(ticket, "in_progress"));
      await tick();

      const after = new Dispatcher({
        client: new FakeClient(),
        config: cfg(2),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
        sweepOrphan: () => false,
      });
      await after.recoverFromCrash();

      failNextResumeSpawn = true;
      await after.handle(stateChanged(ticket, "in_progress"));
      await tick();

      const [resumeAttempt, freshFallback] = spawnCalls.slice(-2);
      expect(resumeAttempt!.resumeSessionId).toBe("sess-1");
      expect(freshFallback!.resumeSessionId).toBeUndefined();
      expect(freshFallback!.stage).toBe("implement");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a recovered implement session is NOT resumed for a review stage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-stagemismatch-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket();
      const { d: before } = newDispatcher(2, { runtimeStatePath });
      await before.handle(stateChanged(ticket, "in_progress"));
      await tick();

      const after = new Dispatcher({
        client: new FakeClient(),
        config: cfg(2),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
        sweepOrphan: () => false,
      });
      await after.recoverFromCrash();
      await after.handle(stateChanged({ ...ticket, state: "in_review" }, "in_review"));
      await tick();

      expect(spawnCalls.at(-1)).toMatchObject({ stage: "review" });
      expect(spawnCalls.at(-1)!.resumeSessionId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── issue #17: preflight fallback chain + failure taxonomy policy ─────────────────────────
describe("preflight + failure taxonomy", () => {
  const healthy = async () => ({ ok: true, problems: [] });

  test("a cast harness that fails preflight is substituted with a comment", async () => {
    const { d, client } = newDispatcher(2, {
      preflight: async (h: string) =>
        h === "codex" ? { ok: false, problems: ["no codex login"] } : { ok: true, problems: [] },
    });
    const ticket = makeTicket({ casting: { implement: { harness: "codex", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ harness: { harness: "claude", effort: "low" } });
    const note = client.comments.find((c) => c.body.includes("unavailable"));
    expect(note?.body).toContain("no codex login");
    expect(note?.body).toContain("**claude**");
  });

  test("no healthy harness → spawn-failure path (bounded retry comment), never a wedge", async () => {
    const { d, client } = newDispatcher(2, {
      preflight: async () => ({ ok: false, problems: ["everything is down"] }),
    });
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    expect(spawnCalls).toHaveLength(0);
    const note = client.comments.at(-1);
    expect(note?.body).toContain("Could not start the implement worker");
    expect(note?.body).toContain("Retrying in 30s (attempt 1/3)");
  });

  test("auth-classed death with no alternative parks the ticket with the login fix", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board.push(ticket);
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].finish("error", "claude said: not logged in", null, false, "auth");
    await tick();

    expect(client.setStateCalls.at(-1)).toMatchObject({ state: "todo" });
    const park = client.comments.at(-1)!;
    expect(park.body).toContain("login looks expired");
    expect(park.body).toContain("sign in by running `claude`");
    expect(spawnCalls).toHaveLength(1); // no doomed respawn
  });

  test("auth-classed death moves the ticket to a healthy fallback harness", async () => {
    const { d, client } = newDispatcher(2, { preflight: healthy });
    const ticket = makeTicket();
    client.board.push(ticket);
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].finish("error", "not logged in", null, false, "auth");
    await tick();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.harness.harness).toBe("pi"); // next in the default fallback order
    const note = client.comments.find((c) => c.body.includes("continuing this ticket on **pi**"));
    expect(note).toBeDefined();
  });

  test("rate-limit death with no alternative backs off instead of instant-respawning", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board.push(ticket);
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].finish("error", "429 too many requests", null, false, "rate_limit");
    await tick();

    expect(spawnCalls).toHaveLength(1); // respawn is DEFERRED behind the backoff timer
    const note = client.comments.at(-1)!;
    expect(note.body).toContain("rate-limited");
    expect(note.body).toContain("backing off 30s");
    expect(client.setStateCalls).toHaveLength(0); // still in_progress, actively scheduled
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

  test("same-project tickets serialize on the project repo even when worker slots are free", async () => {
    const { d, client } = newDispatcher(2);
    const a = makeTicket({ id: "a", identifier: "OPS-A", project: "balloons" });
    const b = makeTicket({ id: "b", identifier: "OPS-B", project: "balloons" });

    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();

    expect(spawnCalls).toHaveLength(1);
    expect(d.live()).toEqual([
      { state: "live", ticketId: "a", workerId: "wk_1", repoRoot: "/tmp/repo/balloons" },
      {
        state: "queued",
        ticketId: "b",
        workerId: null,
        stage: "implement",
        repoRoot: "/tmp/repo/balloons",
        waitingFor: "OPS-A",
      },
    ]);
    expect(client.comments.at(-1)!.body).toContain("Waiting for OPS-A to free `/tmp/repo/balloons`");

    created[0].finish("success", "a done");
    await tick();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.ticketId).toBe("b");
  });

  test("cancelling a same-project worker releases the queued ticket", async () => {
    const { d } = newDispatcher(2);
    const a = makeTicket({ id: "a", identifier: "OPS-A", project: "balloons" });
    const b = makeTicket({ id: "b", identifier: "OPS-B", project: "balloons" });

    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1);

    await d.handle({ kind: "cancelled", ticket: a });
    await tick();

    expect(created[0].aborted).toBe(true);
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
    const status = d.live();
    expect(status.filter((s) => s.state === "live")).toHaveLength(2); // still exactly the cap
    expect(status.filter((s) => s.state === "queued")).toHaveLength(3);
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
