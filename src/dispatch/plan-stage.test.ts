/**
 * Plan/plan_check stage tests (`src/dispatch/plan-stage.ts`, issue #128).
 * Pins the behaviors the enforcement writeup in that file's header promises: a cast override
 * outside the strong-seat allowlist is refused (not merely defaulted around silently), the
 * checker's mechanical size gate overrides a model's own "complete" verdict, the enforcement
 * record is written ONLY on a genuine pass, and cap exhaustion parks for a human rather than
 * auto-advancing an unverified plan into implement.
 */
import { describe, expect, test } from "bun:test";
import type { HarnessSpec, Ticket } from "../tracker/types.ts";
import { taskKeyOf } from "../tracker/cast.ts";
// `stages.ts` MUST finish evaluating before `plan-stage.ts` does — the two modules import each
// other (see plan-stage.ts's header), and stages.ts's `buildStagesExtension()` reads
// `planStage`/`planCheckStage` at ITS OWN module bottom. Every real entry point (dispatcher.ts)
// happens to import stages.ts first, which is what makes the cycle resolve there; a test file
// importing plan-stage.ts as its FIRST module reference hits the opposite, unsafe order and
// throws `ReferenceError: Cannot access 'planStage' before initialization` — reproduced while
// writing this test. Importing stages.ts explicitly first is a real fix for this file, not a
// hack: it forces the one evaluation order the cycle is actually safe in. The underlying
// fragility (this "safety" holds only by import-order coincidence, not by construction) is
// flagged in this ticket's report as a follow-up worth a real fix — e.g. moving the
// `taskHeader`/`taskCriteria`/`workerSystemAppend`/`parseDoneSignal`/`doneSignalSummary` helpers
// plan-stage.ts needs into a THIRD shared module neither `stages.ts` nor `plan-stage.ts` needs to
// import from the other for.
import "./stages.ts";
import type { StageOps, PlanVerification } from "./stages.ts";
import { planStage, planCheckStage, planDocPath } from "./plan-stage.ts";
import { PLAN_TOKEN_CEILING } from "./plan-artifact.ts";

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: over.id ?? "tkt-1",
    identifier: over.identifier ?? "OPS-1",
    title: over.title ?? "Do a thing",
    description: "",
    body: over.body ?? "the body",
    state: over.state ?? "plan",
    assignees: [],
    casting: over.casting ?? {},
    criteria: over.criteria ?? ["it works"],
    blockedBy: [],
    projectId: over.projectId ?? "proj-1",
    url: "http://x",
    updatedAt: "now",
    ...over,
  };
}

/** A minimal {@link TicketWorkerHandle} fake — only the fields plan-stage.ts's finish handlers read. */
function makeHandle(structured: unknown = null): any {
  return {
    id: "wk_1",
    workerId: "wk_1",
    ticketId: "tkt-1",
    stage: "plan",
    harness: "claude",
    workspace: "/tmp/ws",
    branch: "beckett/ops-1",
    sessionId: "",
    pid: 0,
    state: "review",
    result: { structured, timedOut: false, unappliedNudges: [] },
    telemetry: () => ({}),
  };
}

/** Records every call a finish handler makes through {@link StageOps}, for assertion. */
function fakeOps(opts: {
  readTicketFile?: (ticket: Ticket, relPath: string) => Promise<string>;
  planCyclesCap?: number;
  /** What `doSpawn` "actually launched" the plan worker with — decoupled from `ticket.casting.plan`
   *  on purpose, so tests can prove `planCheckStage.finish` records THIS, not the ticket's request. */
  planAuthorCast?: HarnessSpec;
  headSha?: string | null;
  commitSha?: string | null;
} = {}): StageOps & {
  comments: string[];
  advanced: Array<{ state: string; comment: string }>;
  parked: string[];
  spawned: string[];
  recorded: Array<{ key: string; record: PlanVerification }>;
} {
  const comments: string[] = [];
  const advanced: Array<{ state: string; comment: string }> = [];
  const parked: string[] = [];
  const spawned: string[] = [];
  const recorded: Array<{ key: string; record: PlanVerification }> = [];
  const planCycles = new Map<string, number>();
  const verified = new Map<string, PlanVerification>();

  const base: StageOps = {
    config: {} as StageOps["config"],
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as StageOps["logger"],
    caps: {
      reworkCycles: 3,
      designCycles: 2,
      planCycles: opts.planCyclesCap ?? 2,
      implementRetries: 3,
      reviewInfraRetries: 1,
      harnessSubstitutions: 6,
    },
    trace() {},
    async postComment(_ticketId: string, body: string) {
      comments.push(body);
    },
    async advanceTicket(_ticket: Ticket, state, comment: string) {
      advanced.push({ state, comment });
      return true;
    },
    async parkForHuman(_ticket: Ticket, comment: string) {
      parked.push(comment);
      return true;
    },
    async commitWip() {
      return opts.commitSha === undefined ? "deadbeef123" : opts.commitSha;
    },
    async commitContribution() {
      return true;
    },
    spawnStage(ticket: Ticket, stage: string) {
      spawned.push(`${ticket.id}:${stage}`);
    },
    async finishTicketAsDone() {
      return true;
    },
    reviewTierFor() {
      return "self";
    },
    async hasTicketContribution() {
      return true;
    },
    async implementIncomplete() {},
    async reviewInfraFailure() {},
    persistRuntimeState() {},
    hasVerifiedPlan(taskKey: string) {
      return verified.has(taskKey);
    },
    recordPlanVerified(taskKey: string, record: PlanVerification) {
      verified.set(taskKey, record);
      recorded.push({ key: taskKey, record });
    },
    planAuthorCastFor() {
      return opts.planAuthorCast;
    },
    async headSha() {
      return opts.headSha === undefined ? "deadbeef123456789" : opts.headSha;
    },
    readTicketFile: opts.readTicketFile ?? (async () => "## Scope & files\n\nx"),
    counters: {
      rework: new Map(),
      reviewInfra: new Map(),
      designCycles: new Map(),
      planCycles,
    },
  };

  return Object.assign(base, { comments, advanced, parked, spawned, recorded });
}

describe("planStage.resolveCast — bypass #1's spawn-time half", () => {
  test("an allowlisted explicit cast wins", () => {
    const explicit = { harness: "claude" as const, model: "claude-fable-5", effort: "high" as const };
    expect(planStage.resolveCast!(explicit, makeTicket(), {} as any)).toEqual(explicit);
  });

  test("a non-allowlisted explicit cast is REFUSED, not defaulted silently — falls back to the strong-seat default", () => {
    const rejected = { harness: "claude" as const, model: "claude-sonnet-5", effort: "high" as const };
    expect(planStage.resolveCast!(rejected, makeTicket(), {} as any)).toEqual({
      harness: "claude",
      model: "claude-opus-5",
      effort: "high",
    });
  });

  test("no explicit cast gets the strong-seat default", () => {
    expect(planStage.resolveCast!(undefined, makeTicket(), {} as any)).toEqual({
      harness: "claude",
      model: "claude-opus-5",
      effort: "high",
    });
  });
});

describe("planStage.buildPrompt", () => {
  test("names the mandatory stage, the doc path, and the size ceiling", () => {
    const ticket = makeTicket({ identifier: "OPS-7" });
    const prompt = planStage.buildPrompt({ ticket, steering: [] });
    expect(prompt).toContain(planDocPath(ticket));
    expect(prompt).toContain("MANDATORY");
    expect(prompt).toContain(`${PLAN_TOKEN_CEILING}`);
    expect(prompt).toContain("do not implement");
  });
});

describe("planStage.finish — bypass #1's after-the-fact half", () => {
  test("a rejected cast override gets ONE named comment; an allowlisted cast gets none", async () => {
    const rejectedTicket = makeTicket({ casting: { plan: { harness: "claude", model: "claude-sonnet-5" } } });
    const ops = fakeOps();
    await planStage.finish!(ops, { ticket: rejectedTicket, handle: makeHandle(), status: "success", summary: "done" });
    expect(ops.comments.some((c) => c.includes("not a strong-seat"))).toBe(true);

    const allowedTicket = makeTicket({ id: "tkt-2", casting: { plan: { harness: "claude", model: "claude-opus-5" } } });
    const ops2 = fakeOps();
    await planStage.finish!(ops2, { ticket: allowedTicket, handle: makeHandle(), status: "success", summary: "done" });
    expect(ops2.comments.some((c) => c.includes("not a strong-seat"))).toBe(false);
  });

  test("always hands off to the independent checker, never to itself", async () => {
    const ticket = makeTicket();
    const ops = fakeOps();
    await planStage.finish!(ops, { ticket, handle: makeHandle(), status: "success", summary: "done" });
    expect(ops.spawned).toEqual([`${ticket.id}:plan_check`]);
  });

  test("status !== success with nothing committed re-authors instead of paying for a checker over emptiness", async () => {
    // Correction-pass fix: pre-fix this fell through to `plan_check` anyway, which paid a SECOND
    // worker only to report "no document found" — the confirmed "double the tax ... yield zero
    // implement output, pure loss" blocker.
    const ticket = makeTicket();
    const ops = fakeOps({ commitSha: null });
    await planStage.finish!(ops, { ticket, handle: makeHandle(), status: "error", summary: "crashed" });

    expect(ops.spawned).toEqual([`${ticket.id}:plan`]); // re-authors directly, never plan_check
    expect(ops.comments.some((c) => c.includes("nothing committed"))).toBe(true);
    expect(ops.parked).toHaveLength(0);
  });

  test("status !== success with nothing committed, cap exhausted, PARKS instead of looping forever", async () => {
    const ticket = makeTicket();
    const ops = fakeOps({ commitSha: null, planCyclesCap: 1 });
    ops.counters.planCycles.set(ticket.id, 1); // already at the cap
    await planStage.finish!(ops, { ticket, handle: makeHandle(), status: "error", summary: "crashed" });

    expect(ops.spawned).toHaveLength(0);
    expect(ops.parked).toHaveLength(1);
    expect(ops.parked[0]).toContain("mandatory");
  });

  test("status !== success but SOMETHING was committed still runs the completeness check (may still be usable)", async () => {
    const ticket = makeTicket();
    const ops = fakeOps({ commitSha: "abc123deadbeef" });
    await planStage.finish!(ops, { ticket, handle: makeHandle(), status: "error", summary: "partial draft" });

    expect(ops.spawned).toEqual([`${ticket.id}:plan_check`]);
    expect(ops.comments.some((c) => c.includes("ended early"))).toBe(true);
  });
});

describe("planStage.spawnFailure — bypass #4", () => {
  test("names the allowlist and never implies a substitute ran", async () => {
    const ops = fakeOps();
    await planStage.spawnFailure!(ops, makeTicket(), new Error("claude preflight failed"));
    expect(ops.comments).toHaveLength(1);
    expect(ops.comments[0]).toContain("no substitute is permitted");
    expect(ops.comments[0]).toContain("claude-opus-5");
    expect(ops.spawned).toHaveLength(0);
  });
});

describe("planCheckStage.finish — THE enforcement record", () => {
  const okSignal = {
    status: "complete" as const,
    summary: "looks good",
    filesChanged: [],
    checksRun: null,
    blockedReason: null,
  };

  test("complete + within ceiling ⇒ records the ACTUALLY-run cast (not the ticket's requested cast), keyed by TASK, and advances to in_progress", async () => {
    // The ticket REQUESTS claude-fable-5, but `doSpawn` actually launched claude-opus-5 (e.g. a
    // health-substitution, or simply the strong-seat default winning over an ineligible request) —
    // `planAuthorCastFor` is the source of truth `plan_check` must record from, never
    // `ticket.casting.plan`. This is the regression pin for the confirmed doc/code contradiction
    // the correction pass flagged (`PlanVerification`'s doc always claimed to record the cast that
    // actually ran; the pre-fix code read `ticket.casting.plan` instead).
    const ticket = makeTicket({ casting: { plan: { harness: "claude", model: "claude-fable-5" } } });
    const ops = fakeOps({ planAuthorCast: { harness: "claude", model: "claude-opus-5", effort: "high" } });
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(okSignal), status: "success", summary: "ok" });

    expect(ops.recorded).toHaveLength(1);
    // Keyed by TASK, not the ticket's own id (issue #128 correction pass, "amortize per task") —
    // this ticket has no `branchRef`, so its task key degrades to `ticket.identifier`, distinct
    // from `ticket.id` in this test fixture (they're deliberately different strings here, unlike
    // production bored where they're equal — see `makeTicket`).
    expect(ops.recorded[0]!.key).toBe(taskKeyOf(ticket));
    expect(ops.recorded[0]!.key).not.toBe(ticket.id);
    expect(ops.recorded[0]!.record.harness).toBe("claude");
    expect(ops.recorded[0]!.record.model).toBe("claude-opus-5");
    expect(ops.recorded[0]!.record.doc).toContain("Scope & files");
    expect(ops.recorded[0]!.record.sha).toBe("deadbeef123456789");
    expect(ops.advanced).toEqual([{ state: "in_progress", comment: expect.stringContaining("Starting implementation") }]);
    expect(ops.parked).toHaveLength(0);
  });

  test("no planAuthorCastFor on record (e.g. a restart-lost claim) falls back to the strong-seat default, never to the ticket's requested cast", async () => {
    const ticket = makeTicket({ casting: { plan: { harness: "claude", model: "claude-fable-5" } } });
    const ops = fakeOps(); // no planAuthorCast option set
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(okSignal), status: "success", summary: "ok" });

    expect(ops.recorded[0]!.record.model).toBe("claude-opus-5"); // PLAN_STAGE_DEFAULT, not claude-fable-5
  });

  test("a doc over the mechanical size ceiling forces a bounce EVEN IF the model said complete", async () => {
    const ticket = makeTicket();
    const oversized = "x".repeat(PLAN_TOKEN_CEILING * 4 + 1);
    const ops = fakeOps({ readTicketFile: async () => oversized });
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(okSignal), status: "success", summary: "ok" });

    expect(ops.recorded).toHaveLength(0);
    expect(ops.advanced).toHaveLength(0);
    // Cycle budget not yet exhausted (cap defaults to 2) → re-authors by re-spawning `plan` directly,
    // never by asking the tracker to re-enter a state the ticket never left (see this file's header
    // on why `design`'s retry-via-state-transition doesn't apply here).
    expect(ops.spawned).toEqual([`${ticket.id}:plan`]);
    expect(ops.comments.some((c) => c.includes("size ceiling"))).toBe(true);
  });

  test("an incomplete verdict bounces the same way, distinct from the ceiling gap", async () => {
    const ticket = makeTicket();
    const blocked = { status: "blocked" as const, summary: "", filesChanged: [], checksRun: null, blockedReason: "missing Approach section" };
    const ops = fakeOps();
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(blocked), status: "success", summary: "ok" });

    expect(ops.recorded).toHaveLength(0);
    expect(ops.spawned).toEqual([`${ticket.id}:plan`]);
    expect(ops.comments.some((c) => c.includes("missing Approach section"))).toBe(true);
  });

  test("cap exhaustion PARKS for a human — does not auto-advance an unverified plan into implement", async () => {
    const ticket = makeTicket();
    const ops = fakeOps({ planCyclesCap: 1 });
    ops.counters.planCycles.set(ticket.id, 1); // already at the cap
    const blocked = { status: "blocked" as const, summary: "", filesChanged: [], checksRun: null, blockedReason: "still thin" };
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(blocked), status: "success", summary: "ok" });

    expect(ops.recorded).toHaveLength(0);
    expect(ops.advanced).toHaveLength(0); // never "in_progress" on an unverified plan
    expect(ops.spawned).toHaveLength(0); // never quietly re-tries past the cap either
    expect(ops.parked).toHaveLength(1);
    expect(ops.parked[0]).toContain("mandatory");
  });

  test("a read failure while size-checking degrades to a gap, never a silent pass", async () => {
    const ticket = makeTicket();
    const ops = fakeOps({ readTicketFile: async () => { throw new Error("ENOENT"); } });
    await planCheckStage.finish!(ops, { ticket, handle: makeHandle(okSignal), status: "success", summary: "ok" });

    expect(ops.recorded).toHaveLength(0);
    expect(ops.advanced).toHaveLength(0);
  });
});
