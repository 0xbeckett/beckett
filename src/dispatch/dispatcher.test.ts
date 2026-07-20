/**
 * Dispatcher state-machine tests (`src/dispatch/dispatcher.ts`).
 * We mock the spawn helper (`./spawn.ts`) and the worktree git ops (`../worker/worktree.ts`)
 * so the full state machine — spawn-on-state, advance-on-finish, steering, cancel, review
 * pass/fail, and the concurrency cap — is exercised deterministically with no real workers.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types.ts";
import type { Ticket, TicketState, PollEvent, HarnessSpec, TicketComment } from "../tracker/types.ts";
import type { GitOps } from "./dispatcher.ts";

// ── controllable fake worker handle + spawn mock ────────────────────────────────────────────
let spawnCalls: {
  ticketId: string;
  stage: string;
  harness: HarnessSpec;
  baseRef: string;
  resumeSessionId?: string;
  steering?: string[];
  reviewDiff?: string;
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
    // Test-only setter so a test can put a handle into the "terminal result set, not yet reaped"
    // window (the real driver sets `result` inside its finished handler before onDone removes it).
    set result(v: any) {
      result = v;
    },
    nudges: [] as string[],
    aborted: false,
    reaped: false,
    nudgeReceipt: "delivered" as string, // tests override to simulate queued/will-restart/dropped
    async nudge(t: string) {
      h.nudges.push(t);
      return h.nudgeReceipt;
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
    onStalled(cb: (idleMs: number, strikes: number) => void) {
      h.stallCbs.add(cb);
    },
    stallCbs: new Set<(idleMs: number, strikes: number) => void>(),
    // test trigger: simulate the driver's stalled signal (issue #21 escalation ladder input).
    stall(idleMs: number, strikes: number) {
      for (const cb of h.stallCbs) cb(idleMs, strikes);
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
      unappliedNudges: string[] = [],
    ) {
      result = { status, summary, structured, timedOut, errorClass, unappliedNudges };
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
    steering: args.steering,
    reviewDiff: args.reviewDiff,
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
let provisionedOwners: string[] = [];
let failProvision: Error | null = null;
let commitResult: { committed: boolean; sha: string | null } = { committed: true, sha: "commit000" };
let commitCalls: { workspace: string; message: string }[] = [];
let diffSince = true;
let fakeReviewDiff = "diff --git a/x.ts b/x.ts\n+added";
let worktreeAdds: { workspace: string; branch: string; baseRef: string }[] = [];
let worktreeRemoves: string[] = [];
let worktreeMerges: { workspace: string; branches: string[] }[] = [];
mock.module("./spawn.ts", () => ({ spawnWorker: fakeSpawn, spawnTicketWorker: fakeSpawn }));
// The dispatcher's git ops, faked via dependency injection (deps.gitOps) rather than
// `mock.module("../worker/worktree.ts")`. bun's module mock is process-global and leaked these
// fakes into other files that need the REAL worktree.ts (scaffolding-guard's real-git tests),
// failing order-dependently on CI. Injecting keeps worktree.ts un-mocked for everyone else.
const gitFakes: Partial<GitOps> = {
  commitWorktree: async (workspace: string, _message: string) => {
    commitCalls.push({ workspace, message: _message });
    return commitResult;
  },
  headSha: async () => "base000", // v3.1 per-ticket diff base (fake repo has no real HEAD)
  hasDiffSince: async () => diffSince,
  ensureProjectRepo: async (_repoRoot: string, slug: string, owner?: string) => {
    if (failProvision) throw failProvision;
    provisioned.push(slug);
    provisionedOwners.push(owner ?? "");
  },
  readDiff: async () => fakeReviewDiff, // issue #27: pre-read diff handed to reviewers
  // v3.2 worktrees: faked so tests never touch real git. createWorktree records + echoes a handle;
  // removeWorktree records teardown; fetchRemote is a no-op success.
  createWorktree: async (opts) => {
    worktreeAdds.push({ workspace: opts.workspace, branch: opts.branch, baseRef: opts.baseRef });
    return { repoRoot: opts.repoRoot, workspace: opts.workspace, branch: opts.branch };
  },
  removeWorktree: async (_repoRoot: string, workspace: string) => {
    worktreeRemoves.push(workspace);
  },
  fetchRemote: async () => true,
  refExists: async () => true,
  mergeBranchesIntoWorktree: async (workspace, branches) => {
    worktreeMerges.push({ workspace, branches });
  },
};

const { Dispatcher, BECKETT_COMMENT_MARKER } = await import("./dispatcher.ts");

// ── fake tracker client ─────────────────────────────────────────────────────────────────────
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
      throw new Error("ticket state write failed");
    }
    this.setStateCalls.push({ id, state });
    const t = this.board.find((b) => b.id === id);
    if (t) t.state = state;
  }
  async addComment(ticketId: string, body: string): Promise<TicketComment> {
    if (this.failAddComment > 0) {
      this.failAddComment--;
      throw new Error("ticket comment write failed");
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
    ...(over.branchRef ? { branchRef: over.branchRef } : {}),
    ...(over.targetBranch ? { targetBranch: over.targetBranch } : {}),
    ...(over.startState ? { startState: over.startState } : {}),
    projectId: over.projectId ?? "proj-1",
    url: "http://x",
    updatedAt: "now",
  };
}

function cfg(max_workers = 2): Config {
  return {
    identity: { github_user: "test-account", gmail_address: "" },
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
    publishOutboxPath?: string;
    runtimeStatePath?: string;
    dispatchEventsPath?: string;
    preflight?: (harness: string) => Promise<{ ok: boolean; problems: string[] }>;
  } = {},
) {
  const client = new FakeClient();
  const d = new Dispatcher({
    gitOps: gitFakes,
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
  provisionedOwners = [];
  commitResult = { committed: true, sha: "commit000" };
  commitCalls = [];
  diffSince = true;
  worktreeAdds = [];
  worktreeRemoves = [];
  worktreeMerges = [];
  failNextResumeSpawn = false;
  failProvision = null;
});

// ── tests ─────────────────────────────────────────────────────────────────────────────────
describe("dispatch event feed (OPS-167)", () => {
  test("persists stage transitions before a worker can finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-events-"));
    try {
      const path = join(dir, "dispatch.jsonl");
      const { d } = newDispatcher(2, { dispatchEventsPath: path });
      const ticket = makeTicket();
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows.every((row) => row.ticketId === ticket.id && typeof row.branchRef === "string" && typeof row.elapsedMs === "number")).toBe(true);
      expect(rows.some((row) => row.stage === "repo" && row.outcome === "passed")).toBe(true);
      expect(rows.some((row) => row.stage === "worktree" && row.outcome === "passed")).toBe(true);
      expect(rows.some((row) => row.stage === "implement" && row.outcome === "started")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("INT intensive flow", () => {
  test("Design spawns its cast, checks the document, then parks at Review (Design)", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({
      identifier: "INT-7",
      projectId: "INT",
      state: "design",
      casting: {
        design: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
        implement: { harness: "pi", effort: "medium" },
        review: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
      },
    });
    client.board.push(ticket);

    await d.handle(stateChanged(ticket, "design"));
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ stage: "design", harness: ticket.casting.design });

    created[0].finish("success", "wrote docs/design/int-7.md", doneSignal("complete"));
    await tick();
    await tick();
    expect(spawnCalls[1]).toMatchObject({
      stage: "design_check",
      harness: { harness: "claude", model: "claude-haiku-4-5", effort: "low" },
    });

    created[1].finish("success", "all required sections are present", doneSignal("complete"));
    await tick();
    await tick();
    expect(client.setStateCalls).toContainEqual({ id: ticket.id, state: "design_review" });
    expect(client.comments.some((c) => c.body.includes("Here's the design — good to build?"))).toBe(true);
    // The human gate has no worker — it must stay token-inert while parked.
    expect(spawnCalls).toHaveLength(2);

    await d.handle(stateChanged({ ...ticket, state: "in_progress" }, "in_progress", "design_review"));
    await tick();
    expect(spawnCalls[2]).toMatchObject({ stage: "implement", harness: ticket.casting.implement });
  });

  test("Review (Design) is parked and never staffs a worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket({ identifier: "INT-8", projectId: "INT", state: "design_review" });
    await d.handle(stateChanged(ticket, "design_review", "design"));
    await tick();
    expect(spawnCalls).toHaveLength(0);
  });

  test("design states on an OPS ticket cannot spawn an INT worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket({ identifier: "OPS-8", state: "design" });
    await d.handle(stateChanged(ticket, "design"));
    await tick();
    expect(spawnCalls).toHaveLength(0);
  });
});

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
    gitOps: gitFakes,
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

  test("in_review spawns a reviewer with the configured model at scaled effort (issue #27)", async () => {
    const { d } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    // Model from config.models.reviewer; effort defaults to "high" (never the xhigh fall-through).
    expect(spawnCalls[0]).toMatchObject({
      stage: "review",
      harness: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
    });
  });

  test("review effort scales from the implement cast (low → medium, xhigh → xhigh)", async () => {
    const { d } = newDispatcher();
    const low = makeTicket({ id: "t-low", identifier: "OPS-L", state: "in_review", casting: { implement: { harness: "pi", effort: "low" } } });
    await d.handle(stateChanged(low, "in_review"));
    await tick();
    const heavy = makeTicket({ id: "t-hi", identifier: "OPS-H", state: "in_review", casting: { implement: { harness: "claude", effort: "xhigh" } } });
    await d.handle(stateChanged(heavy, "in_review"));
    await tick();
    expect(spawnCalls[0]!.harness.effort).toBe("medium");
    expect(spawnCalls[1]!.harness.effort).toBe("xhigh");
  });

  test("an explicit review cast keeps its effort; one without gets the scaled default", async () => {
    const { d } = newDispatcher();
    const pinned = makeTicket({ id: "t-p", identifier: "OPS-P", state: "in_review", casting: { review: { harness: "claude", model: "claude-opus-4-8", effort: "xhigh" } } });
    await d.handle(stateChanged(pinned, "in_review"));
    await tick();
    const bare = makeTicket({ id: "t-b", identifier: "OPS-B", state: "in_review", casting: { review: { harness: "claude" } } });
    await d.handle(stateChanged(bare, "in_review"));
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ model: "claude-opus-4-8", effort: "xhigh" });
    expect(spawnCalls[1]!.harness.effort).toBe("high");
  });

  test("the reviewer receives the pre-read contribution diff (issue #27)", async () => {
    const { d } = newDispatcher();
    await d.handle(stateChanged(makeTicket({ state: "in_review" }), "in_review"));
    await tick();
    expect(spawnCalls[0]!.reviewDiff).toContain("diff --git a/x.ts");
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

  test("tracker write failure after finish is queued and replayed from the advance outbox", async () => {
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

  test("#65: cancelling a running ticket aborts + reaps its live worker immediately", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board = [ticket];
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const worker = created[0]!;
    expect(worker.aborted).toBe(false);

    // Human cancels; the cancel event reaches the dispatcher.
    ticket.state = "cancelled";
    await d.handle(stateChanged(ticket, "cancelled", "in_progress"));
    await settle();

    // The live worker (and, in the real driver, its whole process group) is torn down at once.
    expect(worker.aborted).toBe(true);
    expect(worker.reaped).toBe(true);
  });

  test("#65: a crashed worker for a cancelled ticket is NOT respawned (crash-retry consults state)", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board = [ticket];
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);

    // Human cancels in the tracker; the poll echo hasn't reached the dispatcher yet — the ONLY signal
    // is the live tracker state. Then the worker crashes, which reads exactly like the retry trigger.
    ticket.state = "cancelled";
    created[0]!.finish("error", "blew up");
    await settle();

    // No fresh worker against the cancelled ticket, no misleading "retrying" comment, no state bump.
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
    expect(client.comments.some((c) => c.body.includes("retrying"))).toBe(false);
    expect(client.setStateCalls).toHaveLength(0);
  });

  test("#65: a late crash callback after a cancel-abort does not resurrect the worker", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board = [ticket];
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const worker = created[0]!;

    ticket.state = "cancelled";
    await d.handle(stateChanged(ticket, "cancelled", "in_progress"));
    await settle();
    expect(worker.aborted).toBe(true);

    // A finish callback that lands AFTER the abort (a race) must not spawn a replacement.
    worker.finish("error", "post-abort crash");
    await settle();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  test("#65: a crashed REVIEW worker for a cancelled ticket is NOT respawned", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ state: "in_review" });
    client.board = [ticket];
    await d.handle(stateChanged(ticket, "in_review"));
    await tick();
    expect(spawnCalls.filter((c) => c.stage === "review")).toHaveLength(1);

    // Human cancels while the reviewer runs; then the review worker crashes (reads like an infra
    // failure). The review-gate retry must consult live state and refuse to respawn.
    ticket.state = "cancelled";
    created[0]!.finish("error", "reviewer blew up");
    await settle();

    expect(spawnCalls.filter((c) => c.stage === "review")).toHaveLength(1);
    expect(client.comments.some((c) => c.body.includes("Retrying the review gate"))).toBe(false);
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

  test("issue #33 regression: a fresh-tier implement finish self-spawns the reviewer with no poll echo", async () => {
    // The instant-milestone path (onAdvance → poller.observe) suppresses the state_changed echo the
    // dispatcher once relied on to staff the reviewer. So a dispatcher-driven advance INTO in_review
    // must self-spawn — here, with NO second stateChanged(in_review) event fired at all.
    const { d, client } = newDispatcher();
    const ticket = makeTicket(); // default cast → fresh review tier
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "implemented");
    await tick();
    // The finish alone advanced the ticket to in_review AND launched the reviewer — no echo needed.
    expect(client.setStateCalls).toContainEqual({ id: "tkt-1", state: "in_review" });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.at(-1)).toMatchObject({ stage: "review" });
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
    const published: Array<{ url: string; kind: string; ticket: string }> = [];
    const d = new Dispatcher({
    gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/home/beckett/Projects/balloons-game",
      publishRepo: async (a) => {
        calls.push(a);
        return { url: "https://github.com/0xbeckett/balloons-game", kind: "pushed" as const };
      },
      onPublished: ({ url, kind, ticket }) => {
        published.push({ url, kind, ticket: ticket.identifier });
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
    // Published deterministically with the slugified project + the ticket id, and the real URL (not
    // a guess) woven into the done comment. v3.2: the publish SOURCE is the ticket's worktree (where
    // its work lives on `beckett/<ticket>`), not the bare project root.
    expect(calls).toEqual([
      {
        slug: "balloons-game",
        repoRoot: "/home/beckett/Projects/balloons-game/.beckett/worktrees/tkt-1",
        description: "Build balloons",
        ticket: "OPS-1",
      },
    ]);
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
    expect(published).toEqual([{
      url: "https://github.com/0xbeckett/balloons-game",
      kind: "pushed",
      ticket: "OPS-1",
    }]);
    expect(client.comments.at(-1)!.body).toContain("https://github.com/0xbeckett/balloons-game");
  });

  test("OPS-185: a ticket's non-main target branch is threaded to the publisher (funnel, main untouched)", async () => {
    const client = new FakeClient();
    const calls: Array<{ slug: string; targetBranch?: string }> = [];
    const d = new Dispatcher({
      gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/home/beckett/Projects/beckett",
      publishRepo: async (a) => {
        calls.push({ slug: a.slug, targetBranch: a.targetBranch });
        return { url: "https://github.com/0xbeckett/beckett", kind: "pushed" as const };
      },
    });
    const ticket = makeTicket({
      project: "beckett",
      title: "V5 phase",
      targetBranch: "v5-daemon",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "phase done");
    await tick();
    // The publisher is told to funnel onto the integration branch — where the guard keeps main safe.
    expect(calls).toEqual([{ slug: "beckett", targetBranch: "v5-daemon" }]);
    expect(client.setStateCalls).toEqual([{ id: "tkt-1", state: "done" }]);
  });

  test("snapshots a branch contribution before direct publication can rebase onto newer main", async () => {
    const client = new FakeClient();
    let visibleAdditions = 4;
    let durableSnapshot = -1;
    let additionsAtDone = -1;
    const d = new Dispatcher({
      gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/voting",
      onBeforePublish: () => { durableSnapshot = visibleAdditions; },
      publishRepo: async () => {
        // Model a parallel branch already landing 7 lines on main before this owned-repo push.
        // The publisher rebases onto it, so the original-base diff now contains A + B.
        visibleAdditions = 11;
        return { url: "https://github.com/acme/voting", kind: "pushed" as const };
      },
      onAdvance: (event) => {
        if (event.kind === "state_changed" && event.to === "done") additionsAtDone = visibleAdditions;
      },
    });
    const ticket = makeTicket({
      branchRef: "42.2",
      project: "voting",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    client.board = [ticket];

    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0]!.finish("success", "shipped it");
    await tick();

    expect(durableSnapshot).toBe(4);
    expect(additionsAtDone).toBe(11);
  });

  test("v3.1: a `pr` publish words the done comment as needing a human merge (not 'shipped')", async () => {
    const client = new FakeClient();
    const d = new Dispatcher({
    gitOps: gitFakes,
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
    gitOps: gitFakes,
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

  test("publish failure persists an in_review retry, then publishes and disposes on replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-publish-outbox-"));
    try {
      const outbox = join(dir, "publish.jsonl");
      const client = new FakeClient();
      let calls = 0;
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config: cfg(),
        resolveRepoRoot: () => "/tmp/repo",
        publishOutboxPath: outbox,
        publishRepo: async () => {
          calls++;
          if (calls === 1) throw new Error("ETIMEDOUT github");
          return { url: "https://github.com/0xbeckett/ops-1", kind: "pushed" as const };
        },
      });
      const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
      client.board = [ticket];
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "shipped it");
      await tick();

      expect(client.setStateCalls).toEqual([{ id: ticket.id, state: "in_review" }]);
      expect(readFileSync(outbox, "utf8")).toContain("\"attempt\":1");
      expect(client.comments.some((c) => c.body.includes("beckett:publish-pending"))).toBe(true);
      expect(spawnCalls).toHaveLength(1); // publish hold must not start a reviewer
      expect(worktreeRemoves).toHaveLength(0);

      const op = JSON.parse(readFileSync(outbox, "utf8"));
      writeFileSync(outbox, JSON.stringify({ ...op, nextAttemptAt: 0 }) + "\n");
      await d.replayPublishes();
      expect(calls).toBe(2);
      expect(client.setStateCalls).toEqual([
        { id: ticket.id, state: "in_review" },
        { id: ticket.id, state: "done" },
      ]);
      expect(worktreeRemoves).toHaveLength(1);
      expect(readFileSync(outbox, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a replayed task PR uses its public ref and fires publication routing hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-task-publish-replay-"));
    try {
      const outbox = join(dir, "publish.jsonl");
      const client = new FakeClient();
      const publishTickets: string[] = [];
      const publications: string[] = [];
      const watchedPrs: string[] = [];
      let calls = 0;
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config: cfg(),
        resolveRepoRoot: () => "/tmp/repo",
        publishOutboxPath: outbox,
        publishRepo: async (args) => {
          calls++;
          publishTickets.push(args.ticket ?? "");
          if (calls === 1) throw new Error("ETIMEDOUT github");
          return {
            url: "https://github.com/acme/voting/pull/9",
            kind: "pr" as const,
            prUrl: "https://github.com/acme/voting/pull/9",
          };
        },
        onPublished: ({ ticket }) => { publications.push(ticket.branchRef ?? ""); },
        onPrOpened: ({ prUrl }) => { watchedPrs.push(prUrl); },
      });
      const ticket = makeTicket({
        branchRef: "42.1",
        project: "voting",
        casting: { implement: { harness: "claude", effort: "low" } },
      });
      client.board = [ticket];

      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0]!.finish("success", "shipped it");
      await tick();

      const op = JSON.parse(readFileSync(outbox, "utf8"));
      writeFileSync(outbox, JSON.stringify({ ...op, nextAttemptAt: 0 }) + "\n");
      await d.replayPublishes();

      expect(publishTickets).toEqual(["task-42-1", "task-42-1"]);
      expect(publications).toEqual(["42.1"]);
      expect(watchedPrs).toEqual(["https://github.com/acme/voting/pull/9"]);
      expect(client.setStateCalls.at(-1)).toEqual({ id: ticket.id, state: "done" });
      expect(readFileSync(outbox, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("boot replay repairs an interrupted publish hold before its retry is due", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-publish-hold-recovery-"));
    try {
      const outbox = join(dir, "publish.jsonl");
      const client = new FakeClient();
      let publishCalls = 0;
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config: cfg(),
        resolveRepoRoot: () => "/tmp/repo",
        publishOutboxPath: outbox,
        publishRepo: async () => {
          publishCalls++;
          throw new Error("ETIMEDOUT github");
        },
      });
      const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
      client.board = [ticket];
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      // The row is written before this tracker hold. Simulate a crash/failure in that tiny window.
      client.failSetState = 1;
      created[0].finish("success", "shipped it");
      await tick();
      expect(ticket.state).toBe("in_progress");
      expect(readFileSync(outbox, "utf8")).toContain(ticket.id);

      await d.replayPublishes();
      expect(ticket.state).toBe("in_review");
      expect(publishCalls).toBe(1); // reconciliation must not spend the scheduled retry early
      expect(readFileSync(outbox, "utf8")).toContain(ticket.id);
      expect(spawnCalls).toHaveLength(1);
      expect(worktreeRemoves).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transient publish retries back off 1m, then 5m, then 30m", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-publish-backoff-"));
    try {
      const outbox = join(dir, "publish.jsonl");
      const client = new FakeClient();
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config: cfg(),
        resolveRepoRoot: () => "/tmp/repo",
        publishOutboxPath: outbox,
        publishRepo: async () => { throw new Error("GitHub returned 503"); },
      });
      const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
      client.board = [ticket];
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "shipped it");
      await tick();

      const first = JSON.parse(readFileSync(outbox, "utf8"));
      expect(first.attempt).toBe(1);
      // Make the first scheduled retry due. Its second transport failure must schedule 5m,
      // rather than accidentally repeating the first 1m delay.
      writeFileSync(outbox, JSON.stringify({ ...first, nextAttemptAt: 0 }) + "\n");
      const before = Date.now();
      await d.replayPublishes();
      const second = JSON.parse(readFileSync(outbox, "utf8"));
      expect(second.attempt).toBe(2);
      expect(second.nextAttemptAt).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
      expect(second.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 50);

      writeFileSync(outbox, JSON.stringify({ ...second, nextAttemptAt: 0 }) + "\n");
      await d.replayPublishes();
      const third = JSON.parse(readFileSync(outbox, "utf8"));
      expect(third.attempt).toBe(3);
      expect(third.nextAttemptAt).toBeGreaterThanOrEqual(Date.now() + 30 * 60_000 - 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("permanent publish failures immediately park in_review with a compare fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-publish-permanent-"));
    const previousOwner = process.env.BECKETT_GH_ORG;
    const previousAccount = process.env.GITHUB_ACCOUNT;
    process.env.BECKETT_GH_ORG = "acme-labs";
    process.env.GITHUB_ACCOUNT = "publisher-bot";
    try {
      const outbox = join(dir, "publish.jsonl");
      const client = new FakeClient();
      const config = {
        ...cfg(),
        identity: { github_user: "octocat", gmail_address: "" },
      } as Config;
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config,
        resolveRepoRoot: () => "/tmp/repo",
        publishOutboxPath: outbox,
        publishRepo: async () => { throw new Error("gh api failed (403): cross-fork PAT limit"); },
      });
      const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
      client.board = [ticket];
      await d.handle(stateChanged(ticket, "in_progress"));
      await tick();
      created[0].finish("success", "shipped it");
      await tick();

      expect(client.setStateCalls).toEqual([{ id: ticket.id, state: "in_review" }]);
      expect(client.comments.some((c) => c.body.includes("Compare-link fallback"))).toBe(true);
      expect(client.comments.some((c) => c.body.includes(
        "https://github.com/acme-labs/ops-1/compare/main...beckett/ops-1",
      ))).toBe(true);
      const op = JSON.parse(readFileSync(outbox, "utf8"));
      expect(op.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
      await d.replayPublishes();
      expect(worktreeRemoves).toHaveLength(0);
      await expect(d.courier(ticket.identifier)).resolves.toEqual({ ticket: ticket.identifier, cancelled: true });
      expect(readFileSync(outbox, "utf8")).toBe("");
    } finally {
      if (previousOwner === undefined) delete process.env.BECKETT_GH_ORG;
      else process.env.BECKETT_GH_ORG = previousOwner;
      if (previousAccount === undefined) delete process.env.GITHUB_ACCOUNT;
      else process.env.GITHUB_ACCOUNT = previousAccount;
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("state/comment write-backs use the ticket's board client", async () => {
    const ops = new FakeClient();
    const vid = new FakeClient();
    const ticket = makeTicket({ id: "vid-tkt-1", identifier: "VID-1", state: "in_review", projectId: "vid-project" });
    vid.board = [ticket];
    const d = new Dispatcher({
      gitOps: gitFakes,
      client: ops,
      clients: [ops, vid],
      clientForProjectId: (projectId) => (projectId === "vid-project" ? vid : ops),
      config: cfg(),
      resolveRepoRoot: (t) => `/tmp/repo/${t.identifier}`,
    });

    await d.handle(stateChanged(ticket, "in_review"));
    await tick();
    created[0].finish("success", "looks good", doneSignal("complete"));
    await tick();

    expect(ops.setStateCalls).toEqual([]);
    expect(ops.comments).toEqual([]);
    expect(vid.setStateCalls).toEqual([{ id: "vid-tkt-1", state: "done" }]);
    expect(vid.comments).toHaveLength(1);
    expect(vid.comments[0]!.ticketId).toBe("vid-tkt-1");
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

  test("passes the config-derived publishing owner into repo provisioning", async () => {
    const previousOrg = process.env.BECKETT_GH_ORG;
    const previousAccount = process.env.GITHUB_ACCOUNT;
    delete process.env.BECKETT_GH_ORG;
    delete process.env.GITHUB_ACCOUNT;
    try {
      const client = new FakeClient();
      const config = {
        ...cfg(),
        identity: { github_user: "octocat", gmail_address: "" },
      } as Config;
      const d = new Dispatcher({
        gitOps: gitFakes,
        client,
        config,
        resolveRepoRoot: () => "/tmp/repo/octocat-project",
      });

      await d.handle(stateChanged(makeTicket({ project: "Config Project" }), "in_progress"));
      await tick();

      expect(provisionedOwners).toContain("octocat");
    } finally {
      if (previousOrg === undefined) delete process.env.BECKETT_GH_ORG;
      else process.env.BECKETT_GH_ORG = previousOrg;
      if (previousAccount === undefined) delete process.env.GITHUB_ACCOUNT;
      else process.env.GITHUB_ACCOUNT = previousAccount;
    }
  });
});

describe("stall escalation ladder (issue #21)", () => {
  test("strike 1 sends a status-check nudge and narrates it on the ticket", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].stall(320_000, 1);
    await tick();

    expect(created[0].nudges).toHaveLength(1);
    expect(created[0].nudges[0]).toContain("Status check");
    expect(created[0].aborted).toBe(false);
    expect(client.comments.at(-1)!.body).toContain("went quiet");
  });

  test("strike 2 aborts the worker and rides the implement retry machinery", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].stall(320_000, 1);
    await tick();
    created[0].stall(640_000, 2);
    await tick();
    await tick();

    expect(created[0].aborted).toBe(true);
    // The abort routed through onImplementIncomplete: WIP narrated + a fresh retry worker.
    expect(client.comments.some((c) => c.body.includes("retrying"))).toBe(true);
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
  });

  test("a stall signal after a real finish is ignored (no double handling)", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    created[0].finish("success", "did it", doneSignal("complete"));
    await tick();
    const commentsBefore = client.comments.length;
    created[0].stall(320_000, 1);
    await tick();

    expect(created[0].nudges).toHaveLength(0);
    expect(client.comments.length).toBe(commentsBefore);
  });
});

describe("restaff lever (issue #21)", () => {
  test("restaff aborts the live worker, commits WIP, and spawns a fresh one", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board.push(ticket);
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    const r = await d.restaff("OPS-1");
    await tick();

    expect(r).toMatchObject({ ticket: "OPS-1", stage: "implement" });
    expect(created[0].aborted).toBe(true);
    expect(created[0].reaped).toBe(true);
    expect(spawnCalls).toHaveLength(2);
    expect(client.comments.some((c) => c.body.includes("Restaffing"))).toBe(true);
  });

  test("restaff --harness pins the fresh worker to the requested harness", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    client.board.push(ticket);
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    await d.restaff(ticket.id, "pi");
    await tick();

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.harness.harness).toBe("pi");
  });

  test("restaff refuses tickets that are not in an active state", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ state: "done" });
    client.board.push(ticket);
    await expect(d.restaff(ticket.id)).rejects.toThrow(/move it to in_progress/);
  });
});

describe("never drop a steer (issue #22)", () => {
  test("a comment with no live worker is held and folded into the next worker's brief", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ state: "todo" });
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "actually cap it at 10s", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });
    expect(client.comments.at(-1)!.body).toContain("holding this comment");

    await d.handle(stateChanged({ ...ticket, state: "in_progress" }, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.steering).toEqual(["actually cap it at 10s"]);
  });

  test("a comment during the finish window (worker has a result) is held for the next stage", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ casting: { review: { harness: "claude" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "did it", doneSignal("complete"));
    // Comment lands while the finish is being processed (handle still registered, result set):
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "also add logging", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });
    await tick();
    await tick();

    expect(created[0].nudges).toHaveLength(0); // never trusted to a finished worker
    // …and the reviewer spawn (or next stage) carries the steer in its brief.
    const review = spawnCalls.find((c) => c.stage === "review");
    if (review) {
      expect(review.steering).toEqual(["also add logging"]);
    } else {
      // finish raced ahead of the comment: the steer must still be held, not dropped
      expect(client.comments.some((c) => c.body.includes("holding this comment"))).toBe(true);
    }
  });

  test("a dropped nudge receipt re-routes the steer instead of trusting it", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].nudgeReceipt = "dropped";
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "use bun not npm", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });

    expect(client.comments.at(-1)!.body).toContain("already finished");
    // Held: the next spawn for this ticket folds it in.
    created[0].finish("error", "crashed");
    await tick();
    await tick();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.steering).toEqual(["use bun not npm"]);
  });

  test("a will-restart receipt gets an honest one-line narration", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ casting: { implement: { harness: "codex" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].nudgeReceipt = "will-restart";
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "prefer sqlite", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });

    expect(created[0].nudges).toEqual(["prefer sqlite"]);
    expect(client.comments.at(-1)!.body).toContain("applies when its current run ends");
  });

  test("unapplied buffered nudges at finish are carried into the retry's brief", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("error", "crashed mid-run", null, false, undefined, ["please add tests"]);
    await tick();
    await tick();

    expect(client.comments.some((c) => c.body.includes("finished before applying"))).toBe(true);
    expect(spawnCalls).toHaveLength(2); // the retry
    expect(spawnCalls[1]!.steering).toEqual(["please add tests"]);
  });

  test("steers orphaned by `done` are surfaced with a reopen hint, not dropped", async () => {
    const { d, client } = newDispatcher();
    const ticket = makeTicket({ state: "todo" });
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "tweak the copy", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });

    await d.handle(stateChanged({ ...ticket, state: "done" }, "done", "in_review"));
    const last = client.comments.at(-1)!.body;
    expect(last).toContain("tweak the copy");
    expect(last).toContain("in_progress");
  });
});

describe("steering + cancel", () => {
  test("a human comment on a live ticket nudges the worker", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "cap it at 10s", createdAt: "now" };
    await d.handle({ kind: "comment_added", ticket, comment });
    expect(created[0].nudges).toEqual(["cap it at 10s"]);
  });

  test("Beckett's own marked comment never self-nudges", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const own: TicketComment = { id: "c1", ticketId: ticket.id, author: "beckett", body: `${BECKETT_COMMENT_MARKER}\nadvanced`, createdAt: "now" };
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
    // One external kick into review; the dispatcher then drives the implement↔review rework cycle
    // autonomously — each advance self-spawns the next stage (issue #33 regression fix), so we only
    // finish workers here rather than re-firing in_review events.
    await d.handle(stateChanged(ticket, "in_review"));
    await tick();
    for (let i = 0; i < 3; i++) {
      created.at(-1)!.finish("success", "still broken", doneSignal("blocked"));
      await tick();
      if (created.at(-1)!.stage === "implement") {
        created.at(-1)!.finish("success", "reworked"); // rework worker lands → re-review self-spawns
        await tick();
      }
    }
    const backToProgress = client.setStateCalls.filter((c) => c.state === "in_progress");
    expect(backToProgress).toHaveLength(2); // cycles 1 & 2 rework; cycle 3 stops, awaiting a human
    expect(client.comments.some((c) => c.body.includes("stopping"))).toBe(true);
  });

  test("rework cap is config-driven ([supervise] max_rework_cycles, OPS-180)", async () => {
    const client = new FakeClient();
    const config = { ...cfg(5), supervise: { max_rework_cycles: 1 } } as unknown as Config;
    const d = new Dispatcher({
      gitOps: gitFakes,
      client,
      config,
      resolveRepoRoot: (t: Ticket) => `/tmp/repo/${t.project ?? t.identifier}`,
    });
    const ticket = makeTicket({ state: "in_review" });
    await d.handle(stateChanged(ticket, "in_review"));
    await tick();
    created.at(-1)!.finish("success", "still broken", doneSignal("blocked"));
    await tick();
    // Cap of 1 → the FIRST failed review already stops auto-rework (no in_progress bounce).
    expect(client.setStateCalls.filter((c) => c.state === "in_progress")).toHaveLength(0);
    expect(client.comments.some((c) => c.body.includes("rework cycle 1/1"))).toBe(true);
    expect(client.comments.some((c) => c.body.includes("stopping"))).toBe(true);
  });

  test("rework count survives dispatcher restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-state-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket({ state: "in_review" });
      const { d: before, client } = newDispatcher(5, { runtimeStatePath });

      // Two full rework cycles on the first dispatcher; each advance self-spawns the next stage,
      // so we alternate finishing the review (blocked) and the rework implement (success).
      await before.handle(stateChanged(ticket, "in_review"));
      await tick();
      for (let i = 0; i < 2; i++) {
        created.at(-1)!.finish("success", "still broken", doneSignal("blocked"));
        await tick();
        created.at(-1)!.finish("success", "reworked"); // implement rework lands → re-review spawns
        await tick();
      }

      const after = new Dispatcher({
    gitOps: gitFakes,
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
      // Self-review tier: a clean implement finish goes straight to done (no re-spawned reviewer),
      // so the ledger returns to empty — the invariant this test guards. A fresh-tier ticket would
      // instead self-spawn a reviewer on finish (issue #33 regression fix), leaving a live entry.
      const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
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
    gitOps: gitFakes,
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
    gitOps: gitFakes,
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
    gitOps: gitFakes,
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

  test("a restart mid-REVIEW re-enters review and resumes that session (not a fresh implement)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-midreview-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const ticket = makeTicket({ state: "in_review" });
      const { d: before } = newDispatcher(2, { runtimeStatePath });
      await before.handle(stateChanged(ticket, "in_review"));
      await tick();
      // The live worker is a REVIEWER; the ledger records stage "review".
      expect(spawnCalls.at(-1)).toMatchObject({ stage: "review" });
      expect(readState(runtimeStatePath).liveWorkers[ticket.id]).toMatchObject({ stage: "review" });
      // No finish — the daemon dies mid-review.

      const after = new Dispatcher({
        gitOps: gitFakes,
        client: new FakeClient(),
        config: cfg(2),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
        sweepOrphan: () => false,
      });
      await after.recoverFromCrash();
      await after.handle(stateChanged(ticket, "in_review"));
      await tick();

      // Re-enters review, resuming the interrupted review session — never a fresh implement.
      expect(spawnCalls.at(-1)).toMatchObject({ stage: "review", resumeSessionId: "sess-1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── OPS-125: periodic worktree checkpoint (bounds the hard-crash loss window) ─────────────
describe("periodic checkpoint (OPS-125)", () => {
  function readState(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  test("commits every live worker's worktree and records the checkpoint on the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-checkpoint-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const { d } = newDispatcher(2, { runtimeStatePath });
      const a = makeTicket({ id: "tkt-a", identifier: "OPS-A" });
      const b = makeTicket({ id: "tkt-b", identifier: "OPS-B" });
      await d.handle(stateChanged(a, "in_progress"));
      await tick();
      await d.handle(stateChanged(b, "in_progress"));
      await tick();
      expect(created).toHaveLength(2);
      commitCalls = []; // ignore any spawn-path commits; count only the checkpoint pass

      const n = await d.checkpointLiveWorkers();
      expect(n).toBe(2);
      // Each live worker's OWN worktree was committed with a checkpoint message.
      const workspaces = created.map((h) => h.workspace).sort();
      expect(commitCalls.map((c) => c.workspace).sort()).toEqual(workspaces);
      expect(commitCalls.every((c) => c.message.includes("checkpoint"))).toBe(true);

      // The ledger now carries the checkpoint floor, persisted to disk.
      const live = readState(runtimeStatePath).liveWorkers;
      expect(live["tkt-a"].lastCheckpointSha).toBe("commit000");
      expect(typeof live["tkt-a"].lastCheckpointAt).toBe("number");
      expect(live["tkt-b"].lastCheckpointSha).toBe("commit000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean worktree is skipped (nothing to checkpoint)", async () => {
    const { d } = newDispatcher(2);
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    commitCalls = [];
    commitResult = { committed: false, sha: null }; // nothing changed since the last checkpoint

    const n = await d.checkpointLiveWorkers();
    expect(n).toBe(0);
    expect(commitCalls).toHaveLength(1); // it TRIED to commit, found a clean tree
  });

  test("best-effort: one worker's commit failure never blocks the others and never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-checkpoint-fail-"));
    try {
      const runtimeStatePath = join(dir, "dispatcher-state.json");
      const seen: string[] = [];
      const failingGit: Partial<GitOps> = {
        ...gitFakes,
        commitWorktree: async (workspace: string, message: string) => {
          seen.push(workspace);
          if (workspace.endsWith("/1")) throw new Error("index.lock: worker mid-commit");
          commitCalls.push({ workspace, message });
          return { committed: true, sha: "commitOK" };
        },
      };
      const d = new Dispatcher({
        gitOps: failingGit,
        client: new FakeClient(),
        config: cfg(2),
        resolveRepoRoot: (t) => `/tmp/repo/${t.project ?? t.identifier}`,
        runtimeStatePath,
      });
      await d.handle(stateChanged(makeTicket({ id: "tkt-a", identifier: "OPS-A" }), "in_progress"));
      await tick();
      await d.handle(stateChanged(makeTicket({ id: "tkt-b", identifier: "OPS-B" }), "in_progress"));
      await tick();
      commitCalls = [];

      // The first worker's worktree throws; the pass must still checkpoint the second and resolve.
      const n = await d.checkpointLiveWorkers();
      expect(seen).toHaveLength(2); // both were attempted
      expect(n).toBe(1); // only the healthy one succeeded
      // Only the surviving worker's ledger entry gets a checkpoint sha.
      const live = readState(runtimeStatePath).liveWorkers;
      const shas = Object.values(live).map((w: any) => w.lastCheckpointSha);
      expect(shas.filter(Boolean)).toEqual(["commitOK"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worker that has already finished is not checkpointed (its finish path owns the commit)", async () => {
    const { d } = newDispatcher(2);
    await d.handle(stateChanged(makeTicket(), "in_progress"));
    await tick();
    // Simulate the terminal result being set but the onDone reap not yet having removed the handle
    // (the checkpoint tick must not race the finish-path commit).
    created[0].result = { status: "success", summary: "done", structured: null, timedOut: false, unappliedNudges: [] };
    commitCalls = [];

    const n = await d.checkpointLiveWorkers();
    expect(n).toBe(0);
    expect(commitCalls).toHaveLength(0);
  });

  test("start/stop is idempotent and a disabled cadence never arms a timer", () => {
    const { d } = newDispatcher(2); // cfg() has no supervise → worker_checkpoint_s undefined → disabled
    expect(() => d.startCheckpointLoop()).not.toThrow();
    expect(() => d.startCheckpointLoop()).not.toThrow(); // second call is a no-op
    expect(() => d.stopCheckpointLoop()).not.toThrow();
    expect(() => d.stopCheckpointLoop()).not.toThrow(); // idempotent
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

  test("preflight AND provisioning both failing still fails the spawn cleanly (overlapped preflight settles)", async () => {
    failProvision = new Error("clone exploded");
    const { d, client } = newDispatcher(2, {
      preflight: async () => ({ ok: false, problems: ["everything is down"] }),
    });
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    expect(spawnCalls).toHaveLength(0);
    const note = client.comments.at(-1);
    expect(note?.body).toContain("Could not start the implement worker");
    expect(note?.body).toContain("could not provision the project repo");
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
    // `a` is self-review tier so its clean finish goes straight to done (no re-spawned reviewer to
    // grab the freed slot) — isolating the pump-on-free behavior this test is about.
    const a = makeTicket({ id: "a", identifier: "OPS-A", casting: { implement: { harness: "claude", effort: "low" } } });
    const b = makeTicket({ id: "b", identifier: "OPS-B" });
    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(1); // b queued behind the cap of 1

    created[0].finish("success", "a done"); // a → done → frees the slot → pump spawns b
    await tick();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.ticketId).toBe("b");
  });

  test("v3.2: same-project tickets run concurrently, each in its own worktree", async () => {
    const { d, client } = newDispatcher(2);
    const a = makeTicket({ id: "a", identifier: "OPS-A", project: "balloons" });
    const b = makeTicket({ id: "b", identifier: "OPS-B", project: "balloons" });

    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();

    // No per-repo serialization anymore: both spawn under the cap, each cutting its own worktree
    // branch off the shared project repo.
    expect(spawnCalls).toHaveLength(2);
    expect(
      d
        .live()
        .filter((s) => s.state === "live")
        .map((s) => s.ticketId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(worktreeAdds.map((w) => w.branch).sort()).toEqual(["beckett/ops-a", "beckett/ops-b"]);
    expect(client.comments.some((c) => c.body.includes("Waiting for"))).toBe(false);
  });

  test("cancelling a live worker frees a capped slot for a queued ticket", async () => {
    const { d } = newDispatcher(2);
    const a = makeTicket({ id: "a", identifier: "OPS-A" });
    const b = makeTicket({ id: "b", identifier: "OPS-B" });
    const c = makeTicket({ id: "c", identifier: "OPS-C" });
    await d.handle(stateChanged(a, "in_progress"));
    await tick();
    await d.handle(stateChanged(b, "in_progress"));
    await tick();
    await d.handle(stateChanged(c, "in_progress"));
    await tick();
    expect(spawnCalls).toHaveLength(2); // c queued behind the cap of 2

    await d.handle({ kind: "cancelled", ticket: a });
    await tick();

    expect(created[0].aborted).toBe(true);
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]!.ticketId).toBe("c");
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
    await tick(); // let the 2 admitted spawns reach the (gated) fake; the 3 over-cap stay queued
    expect(spawnCalls).toHaveLength(2); // cap respected even though no handle has registered yet

    release();
    await tick();
    const status = d.live();
    expect(status.filter((s) => s.state === "live")).toHaveLength(2); // still exactly the cap
    expect(status.filter((s) => s.state === "queued")).toHaveLength(3);
    expect(spawnCalls).toHaveLength(2);
  });
});

describe("worktrees (v3.2)", () => {
  test("implement + review share ONE worktree; done tears it down", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket(); // fresh tier → implement, then a separate review
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "implemented");
    await tick(); // → in_review; the reviewer self-spawns in the SAME worktree

    const workspaces = new Set(worktreeAdds.map((w) => w.workspace));
    expect(workspaces.size).toBe(1); // reused across implement + review, not re-cut
    const ws = [...workspaces][0]!;
    expect(ws).toContain("/.beckett/worktrees/tkt-1");
    expect(worktreeAdds[0]!.branch).toBe("beckett/ops-1");

    created.at(-1)!.finish("success", "looks good", doneSignal("complete"));
    await tick();
    expect(worktreeRemoves).toContain(ws); // shipped → torn down
  });

  test("a cancelled ticket's worktree is torn down", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    const ws = worktreeAdds[0]!.workspace;

    await d.handle({ kind: "cancelled", ticket });
    await tick();
    expect(worktreeRemoves).toContain(ws);
  });

  test("a publish-failed park-to-todo KEEPS the worktree (a human/courier needs the work)", async () => {
    const client = new FakeClient();
    const d = new Dispatcher({
      gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/repo/x",
      publishRepo: async () => {
        throw new Error("gh down");
      },
    });
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0].finish("success", "done"); // self-review → done attempt → publish fails → park todo
    await tick();

    expect(client.setStateCalls).toContainEqual({ id: "tkt-1", state: "todo" });
    expect(worktreeRemoves).toHaveLength(0); // preserved, not torn down
  });
});

describe("dependency promotion (beckett plan DAG)", () => {
  test("boot reconciliation promotes task dependents completed while Beckett was offline", async () => {
    const { d, client } = newDispatcher();
    const blocker = makeTicket({ id: "a", identifier: "OPS-A", state: "done" });
    const standard = makeTicket({
      id: "b",
      identifier: "OPS-B",
      branchRef: "42.1",
      state: "backlog",
      blockedBy: ["OPS-A"],
    });
    const intensive = makeTicket({
      id: "c",
      identifier: "INT-2",
      branchRef: "42.2",
      state: "backlog",
      blockedBy: ["OPS-A"],
      startState: "design",
    });
    const unresolved = makeTicket({
      id: "d",
      identifier: "OPS-D",
      branchRef: "42.3",
      state: "backlog",
      blockedBy: ["OPS-MISSING"],
    });
    const intentionallyTodo = makeTicket({
      id: "e",
      identifier: "OPS-E",
      branchRef: "42.4",
      state: "todo",
      blockedBy: ["OPS-A"],
      startState: "todo",
    });
    client.board = [blocker, standard, intensive, unresolved, intentionallyTodo];

    await expect(d.reconcileDependents()).resolves.toBe(2);

    expect(client.setStateCalls).toEqual([
      { id: "b", state: "in_progress" },
      { id: "c", state: "design" },
    ]);
    expect(client.setStateCalls.some((call) => call.id === "d" || call.id === "e")).toBe(false);
    expect(client.comments.filter((comment) => comment.body.includes("All blockers done"))).toHaveLength(2);
  });

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

  test("task dependents wait for publish, then branch from the predecessor's public Git ref", async () => {
    const client = new FakeClient();
    const blocker = makeTicket({
      id: "a",
      identifier: "OPS-A",
      branchRef: "42.1",
      project: "voting",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    const dependent = makeTicket({
      id: "b",
      identifier: "OPS-B",
      branchRef: "42.2",
      project: "voting",
      state: "backlog",
      blockedBy: ["OPS-A"],
      startState: "in_progress",
    });
    client.board = [blocker, dependent];
    let releasePublish!: () => void;
    let publishedTicket: string | undefined;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const d = new Dispatcher({
      gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/voting",
      publishRepo: async (args) => {
        publishedTicket = args.ticket;
        await publishGate;
        return { url: "https://github.com/acme/voting", kind: "pushed" };
      },
    });

    await d.handle(stateChanged(blocker, "in_progress"));
    await tick();
    created[0]!.finish("success", "done");
    await tick();
    expect(client.setStateCalls.some((call) => call.id === "b")).toBe(false);

    releasePublish();
    await tick();
    await tick();
    expect(client.setStateCalls).toContainEqual({ id: "a", state: "done" });
    expect(client.setStateCalls).toContainEqual({ id: "b", state: "in_progress" });
    expect(publishedTicket).toBe("task-42-1");

    await d.handle(stateChanged(dependent, "in_progress", "backlog"));
    await tick();
    expect(worktreeAdds.at(-1)).toMatchObject({
      branch: "beckett/task-42-2",
      baseRef: "beckett/task-42-1",
    });
  });

  test("an intensive task dependent enters its recorded design state", async () => {
    const { d, client } = newDispatcher();
    const blocker = makeTicket({ id: "a", identifier: "INT-1", branchRef: "7.1", state: "done" });
    const dependent = makeTicket({
      id: "b",
      identifier: "INT-2",
      branchRef: "7.2",
      state: "backlog",
      blockedBy: ["INT-1"],
      startState: "design",
    });
    client.board = [blocker, dependent];

    await d.handle(stateChanged(blocker, "done", "design_review"));
    await tick();
    expect(client.setStateCalls).toContainEqual({ id: "b", state: "design" });
  });
});

describe("pipeline latency (issue #33)", () => {
  test("a DAG dependent is promoted BEFORE publish — even when publish fails", async () => {
    const client = new FakeClient();
    const blocker = makeTicket({
      id: "a",
      identifier: "OPS-A",
      casting: { implement: { harness: "claude", effort: "low" } },
    });
    const dependent = makeTicket({ id: "b", identifier: "OPS-B", state: "backlog", blockedBy: ["OPS-A"] });
    client.board = [blocker, dependent];
    const d = new Dispatcher({
    gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/repo",
      publishRepo: async () => {
        throw new Error("gh down");
      },
    });
    await d.handle(stateChanged(blocker, "in_progress"));
    await tick();
    created[0]!.finish("success", "shipped it");
    await tick();

    // The dependent builds from the LOCAL checkout, so it starts even though the blocker's
    // publish failed and parked it for a courier — and the promotion write lands FIRST.
    expect(client.setStateCalls).toEqual([
      { id: "b", state: "in_progress" },
      { id: "a", state: "todo" },
    ]);
    expect(client.setStateCalls.some((c) => c.id === "a" && c.state === "done")).toBe(false);
  });

  test("advances fire onAdvance with the exact poller event shape (instant milestone path)", async () => {
    const client = new FakeClient();
    const events: PollEvent[] = [];
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    client.board = [ticket];
    const d = new Dispatcher({
    gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/repo",
      onAdvance: (e) => events.push(e),
    });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0]!.finish("success", "shipped it");
    await tick();

    const done = events.find((e) => e.kind === "state_changed" && e.to === "done");
    expect(done).toBeTruthy();
    expect(done!.ticket.state).toBe("done");
    expect(done!.ticket.identifier).toBe("OPS-1");
  });

  test("a throwing onAdvance listener never fails the advance itself", async () => {
    const client = new FakeClient();
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    client.board = [ticket];
    const d = new Dispatcher({
    gitOps: gitFakes,
      client,
      config: cfg(),
      resolveRepoRoot: () => "/tmp/repo",
      onAdvance: () => {
        throw new Error("listener exploded");
      },
    });
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();
    created[0]!.finish("success", "shipped it");
    await tick();
    expect(client.setStateCalls).toContainEqual({ id: "tkt-1", state: "done" });
  });

  test("a slow un-acked nudge no longer blocks the poll batch", async () => {
    const { d } = newDispatcher();
    const ticket = makeTicket();
    await d.handle(stateChanged(ticket, "in_progress"));
    await tick();

    // Worst case pre-fix: the driver waits ACK_TIMEOUT_MS (30s) for a stdin echo. Simulate a
    // nudge that never resolves at all — handle() must still return immediately.
    created[0]!.nudge = () => new Promise<never>(() => {});
    const comment: TicketComment = { id: "c1", ticketId: ticket.id, author: "jawrooo", body: "steer", createdAt: "now" };
    const start = Date.now();
    await d.handle({ kind: "comment_added", ticket, comment });
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("one throwing event does not take down the rest of the batch", async () => {
    const { d } = newDispatcher();
    const broken = makeTicket({ id: "bad", identifier: "OPS-BAD" });
    const fine = makeTicket({ id: "ok", identifier: "OPS-OK" });
    await d.handle([stateChanged(broken, "in_progress"), stateChanged(fine, "in_progress")]);
    await tick();
    expect(created).toHaveLength(2);

    // The first cancel's worker abort blows up mid-handling…
    created[0]!.abort = async () => {
      throw new Error("abort exploded");
    };
    let okAborted = false;
    const okAbort = created[1]!.abort;
    created[1]!.abort = async (reason?: string) => {
      okAborted = true;
      return okAbort(reason);
    };
    await d.handle([
      { kind: "cancelled", ticket: { ...broken, state: "cancelled" } },
      { kind: "cancelled", ticket: { ...fine, state: "cancelled" } },
    ]);
    // …but the SECOND cancel still lands — pre-fix, the batch died with the first throw.
    expect(okAborted).toBe(true);
  });
});
