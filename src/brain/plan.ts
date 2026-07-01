/**
 * Beckett — judgment middle: CLARIFY / PLAN / drift-read / summary (`src/brain/plan.ts`)
 * =======================================================================================
 * The Opus judgment roles that shape and steer work (Spec 06 §4.2–§4.5) plus the cheap Haiku
 * worker summary (B9) that precedes every drift-read (Spec 06 §7.2). Also the pure helpers
 * that turn a {@link PlanOutput} into the executor's {@link Plan}/{@link Dag} shape and fuse
 * STAFF into PLAN for v0 (Spec 06 §4.4).
 *
 * Effort is realized via model tier (Opus vs Haiku) + reasoning framing in the system prompt,
 * NOT a `--effort` flag (unverified — Spec 06 §2.2 / Spec 02 §7.1).
 *
 * Degradation (Spec 06 §3.4): a drift-read failure → `continue` + a short re-look (never abort
 * a worker on a brain glitch); a summary failure → a minimal mechanical summary; a clarify
 * failure → proceed (reversible bias). PLAN re-throws so the orchestrator pauses + escalates
 * rather than dispatching blind.
 */

import { z } from "zod";
import type {
  TaskRecord,
  BrainContext,
  Persona,
  ClarifyOutput,
  PlanOutput,
  Plan,
  PlanNode,
  NodeDep,
  StaffOutput,
  WorkerAssignment,
  Worker,
  WorkerSummary,
  SmokeAlarm,
  SuperviseDecision,
  Harness,
} from "../types.ts";
import { availableHarnesses, hasDriver } from "../drivers/index.ts";
import { callJSON, BrainCallError, type RoleDeps } from "./llm.ts";
import {
  clarifySystem,
  clarifyUser,
  planSystem,
  planUser,
  driftSystem,
  driftUser,
  summarySystem,
  summaryUser,
} from "./prompts.ts";

// =======================================================================================
// CLARIFY (Spec 06 §4.2)
// =======================================================================================

export const CLARIFY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["needsClarify"],
  properties: {
    needsClarify: { type: "boolean" },
    question: {
      type: "string",
      description: "required iff needsClarify; ONE crisp question about the irreversible ambiguity",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "iff proceeding: the reversible assumptions to report at delivery",
    },
    pushback: { type: "string", description: "optional: standing to push back on a bad/contradictory ask" },
  },
};

const ClarifyZ = z.object({
  needsClarify: z.boolean(),
  question: z.string().optional(),
  assumptions: z.array(z.string()).optional(),
  pushback: z.string().optional(),
});

/**
 * The CLARIFY judgment (B3). Returns {needsClarify:false} on a brain failure — the reversible
 * bias means we'd rather proceed (and surface assumptions) than block on a glitch.
 */
export async function runClarify(
  task: TaskRecord,
  ctx: BrainContext | undefined,
  persona: Persona,
  deps: RoleDeps,
  model: string,
): Promise<ClarifyOutput> {
  try {
    const out = await callJSON<ClarifyOutput>({
      bin: deps.bin,
      model,
      system: clarifySystem(persona),
      prompt: clarifyUser(task, ctx),
      jsonSchema: CLARIFY_SCHEMA,
      validate: (v) => ClarifyZ.parse(v) as ClarifyOutput,
      schemaName: "clarify",
      retry: deps.retry,
      logger: deps.logger,
    });
    // Enforce the cross-field rule: needsClarify ⇒ a question must exist.
    if (out.needsClarify && !out.question?.trim()) {
      out.needsClarify = false;
    }
    return out;
  } catch (err) {
    deps.logger.warn("clarify failed; proceeding (reversible bias)", {
      error: (err as Error).message,
    });
    return { needsClarify: false, assumptions: [] };
  }
}

// =======================================================================================
// PLAN (Spec 06 §4.3 / §6) — the DAG + criteria + staffing + check-ins
// =======================================================================================

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nodes"],
  properties: {
    summary: { type: "string", minLength: 1, description: "the one-line read, refined; first person" },
    scopeNote: { type: "string", description: "optional big-swing resource note for the ack" },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "intent", "dependsOn", "scopePaths", "criteria", "suggestedWorker", "envelope"],
        properties: {
          id: { type: "string", description: "stable node id, e.g. 'n1'" },
          title: { type: "string", minLength: 1 },
          intent: { type: "string", minLength: 1, description: "becomes the worker's task brief" },
          dependsOn: { type: "array", items: { type: "string" }, description: "node ids that must complete first; [] = root" },
          scopePaths: { type: "array", items: { type: "string" }, minItems: 1, description: "owned path globs (the worktree write boundary)" },
          network: { type: "boolean", description: "node needs network (npm/git push); default false" },
          criteria: {
            type: "object",
            additionalProperties: false,
            required: ["checks", "nl"],
            properties: {
              checks: { type: "array", items: { type: "string" }, description: "executable commands; exit 0 = pass" },
              nl: { type: "array", items: { type: "string" }, minItems: 1, description: "natural-language criteria for the reviewer" },
              interfaceContract: { type: "string", description: "optional shared-boundary contract" },
            },
          },
          suggestedWorker: {
            type: "object",
            additionalProperties: false,
            required: ["harness", "model", "effort"],
            properties: {
              // v0 is Claude-only — no other harness has a registered driver (drivers/index.ts).
              // Constrain generation here; staffFromPlan also coerces defensively (S2).
              harness: { enum: ["claude"] },
              model: { type: "string", description: "e.g. claude-sonnet-5-1 / claude-opus-4-9" },
              effort: { enum: ["low", "medium", "high", "xhigh"] },
              rationale: { type: "string" },
            },
          },
          reviewTier: { enum: ["self", "fresh"], description: "self for simple, fresh adversarial for critical" },
          envelope: {
            type: "object",
            additionalProperties: false,
            required: ["turnTarget", "wallClockSecs"],
            properties: {
              turnTarget: { type: "integer", minimum: 1 },
              wallClockSecs: { type: "integer", minimum: 1 },
            },
          },
          initialCheckIn: {
            type: "object",
            additionalProperties: false,
            required: ["reason"],
            properties: {
              afterTurns: { type: "integer", minimum: 1 },
              afterSecs: { type: "integer", minimum: 1 },
              reason: { type: "string", minLength: 1, description: "note to future-self" },
            },
          },
        },
      },
    },
  },
};

const CriteriaZ = z.object({
  checks: z.array(z.string()),
  nl: z.array(z.string()).min(1),
  interfaceContract: z.string().optional(),
});

const SuggestedWorkerZ = z.object({
  harness: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  rationale: z.string().optional(),
});

const PlanNodeZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1),
  dependsOn: z.array(z.string()),
  scopePaths: z.array(z.string()).min(1),
  network: z.boolean().optional(),
  criteria: CriteriaZ,
  suggestedWorker: SuggestedWorkerZ,
  reviewTier: z.enum(["self", "fresh"]).optional(),
  envelope: z.object({
    turnTarget: z.number().int().min(1),
    wallClockSecs: z.number().int().min(1),
  }),
  initialCheckIn: z
    .object({
      afterTurns: z.number().int().min(1).optional(),
      afterSecs: z.number().int().min(1).optional(),
      reason: z.string().min(1),
    })
    .optional(),
});

const PlanOutputZ = z.object({
  summary: z.string().min(1),
  scopeNote: z.string().optional(),
  nodes: z.array(PlanNodeZ).min(1),
});

/**
 * The PLAN call (B4) — the most important Opus decision. Opus effort high (model tier +
 * "think hard" framing). Re-throws on failure: a blind dispatch is worse than a paused task
 * the orchestrator escalates (Spec 06 §3.4).
 */
export async function runPlan(
  task: TaskRecord,
  ctx: BrainContext | undefined,
  persona: Persona,
  deps: RoleDeps,
  model: string,
): Promise<PlanOutput> {
  return callJSON<PlanOutput>({
    bin: deps.bin,
    model,
    system: planSystem(persona),
    prompt: planUser(task, ctx),
    jsonSchema: PLAN_SCHEMA,
    validate: (v) => PlanOutputZ.parse(v) as PlanOutput,
    schemaName: "plan",
    retry: deps.retry,
    logger: deps.logger,
  });
}

// ── pure plan transforms (no model) ──

/**
 * Validate a {@link PlanOutput} before STAFF (Spec 06 §4.3 / Spec 04 T9): unique ids, every
 * dependsOn resolves, the DAG is acyclic, and every node carries criteria. Returns a list of
 * human-readable issues ([] = valid).
 */
export function validatePlanOutput(plan: PlanOutput): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const n of plan.nodes) {
    if (ids.has(n.id)) issues.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (n.criteria.checks.length === 0 && n.criteria.nl.length === 0) {
      issues.push(`node "${n.id}" has no criteria (mandatory — Spec 11 §2)`);
    }
  }
  for (const n of plan.nodes) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep)) issues.push(`node "${n.id}" depends on unknown node "${dep}"`);
      if (dep === n.id) issues.push(`node "${n.id}" depends on itself`);
    }
  }
  if (hasCycle(plan.nodes)) issues.push("the DAG is cyclic");
  return issues;
}

/** DFS cycle detection over `dependsOn` edges. */
function hasCycle(nodes: PlanNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=on-stack,2=done
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (visit(n.id)) return true;
  return false;
}

/**
 * Shape a {@link PlanOutput} into the executor's {@link Plan}: nodes carry their own
 * `dependsOn`; `deps` is the flattened edge list persistence/the scheduler consume (Spec 04
 * §2; the Foundation contract — nodes[] + deps[]).
 */
export function planToPlan(plan: PlanOutput): Plan {
  const deps: NodeDep[] = [];
  for (const n of plan.nodes) {
    for (const d of n.dependsOn) deps.push({ nodeId: n.id, dependsOnId: d });
  }
  return { summary: plan.summary, scopeNote: plan.scopeNote, nodes: plan.nodes, deps };
}

/**
 * v0 staffing guard (S2): PLAN may suggest a harness with no registered driver (e.g. "codex",
 * which is intentionally unregistered in v0 — drivers/index.ts). Dispatching it would throw at
 * driver/worktree creation. Coerce any unavailable harness to an available one (v0 forces
 * "claude") so STAFF never hands the executor an undispatchable assignment (Spec 06 §4.4).
 */
function staffableHarness(requested: Harness): { harness: Harness; coerced: boolean } {
  if (hasDriver(requested)) return { harness: requested, coerced: false };
  const avail = availableHarnesses();
  const fallback: Harness | undefined = avail.includes("claude") ? "claude" : avail[0];
  if (!fallback) {
    throw new Error(
      `STAFF: requested harness "${requested}" has no driver and no fallback is registered`,
    );
  }
  return { harness: fallback, coerced: true };
}

/**
 * STAFF fused into PLAN for v0 (Spec 06 §4.4): accept PLAN's `suggestedWorker` per node as the
 * assignment directly — no separate Opus call until the learned capability model lands. Any
 * suggested harness without a driver is coerced to an available one (S2 — see
 * {@link staffableHarness}); the override is recorded for the audit trail.
 */
export function staffFromPlan(plan: PlanOutput): StaffOutput {
  const assignments: WorkerAssignment[] = plan.nodes.map((n) => {
    const requested = n.suggestedWorker.harness;
    const { harness, coerced } = staffableHarness(requested);
    const notes = [
      n.suggestedWorker.rationale,
      coerced
        ? `forced harness "${requested}"→"${harness}" (no ${requested} driver in v0)`
        : undefined,
    ].filter((s): s is string => Boolean(s));
    return {
      nodeId: n.id,
      harness,
      model: n.suggestedWorker.model,
      effort: n.suggestedWorker.effort,
      overrodePlan: coerced,
      rationale: notes.length ? notes.join("; ") : undefined,
    };
  });
  return { assignments };
}

// =======================================================================================
// SUPERVISE drift-read (Spec 06 §4.5 / Spec 03 §4.3)
// =======================================================================================

export const SUPERVISE_DECISION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { enum: ["continue", "nudge", "pause", "abort", "reschedule"] },
    reason: { type: "string", minLength: 1, description: "REQUIRED. first-person, owned" },
    message: { type: "string", description: "REQUIRED iff action==='nudge'" },
    nextCheckIn: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        afterTurns: { type: "integer", minimum: 1 },
        afterSecs: { type: "integer", minimum: 1 },
        reason: { type: "string", minLength: 1 },
      },
    },
    escalate: {
      type: "object",
      additionalProperties: false,
      required: ["severity"],
      properties: {
        severity: { enum: ["fyi", "needs_input"] },
        question: { type: "string", description: "required iff severity==='needs_input'" },
      },
    },
  },
};

const SuperviseZ = z.object({
  action: z.enum(["continue", "nudge", "pause", "abort", "reschedule"]),
  reason: z.string().min(1),
  message: z.string().optional(),
  nextCheckIn: z
    .object({
      afterTurns: z.number().int().min(1).optional(),
      afterSecs: z.number().int().min(1).optional(),
      reason: z.string().min(1),
    })
    .optional(),
  escalate: z
    .object({
      severity: z.enum(["fyi", "needs_input"]),
      question: z.string().optional(),
    })
    .optional(),
});

/**
 * The drift-read (B6) / self-halt (B10). On a brain failure, degrade SAFELY: `continue` + a
 * short re-look — never abort good work on a glitch (Spec 06 §3.4).
 */
export async function runSupervise(
  worker: Worker,
  summary: WorkerSummary,
  alarms: SmokeAlarm[],
  ctx: BrainContext | undefined,
  persona: Persona,
  deps: RoleDeps,
  model: string,
  checkinDefaultS: number,
): Promise<SuperviseDecision> {
  try {
    const dec = await callJSON<SuperviseDecision>({
      bin: deps.bin,
      model,
      system: driftSystem(persona),
      prompt: driftUser(worker, summary, alarms, ctx),
      jsonSchema: SUPERVISE_DECISION_SCHEMA,
      validate: (v) => SuperviseZ.parse(v) as SuperviseDecision,
      schemaName: "supervise",
      retry: deps.retry,
      logger: deps.logger,
    });
    // Cross-field guards (Spec 03 §4.3): nudge needs a message; reschedule needs a check-in.
    if (dec.action === "nudge" && !dec.message?.trim()) {
      deps.logger.warn("supervise nudge missing message; downgrading to reschedule", {
        worker: worker.id,
      });
      return {
        action: "reschedule",
        reason: dec.reason,
        nextCheckIn: dec.nextCheckIn ?? { afterSecs: checkinDefaultS, reason: "re-look after malformed nudge" },
      };
    }
    if (dec.action === "reschedule" && !dec.nextCheckIn) {
      dec.nextCheckIn = { afterSecs: checkinDefaultS, reason: "re-look" };
    }
    return dec;
  } catch (err) {
    deps.logger.warn("supervise drift-read failed; defaulting to continue + re-look", {
      worker: worker.id,
      error: (err as Error).message,
    });
    return {
      action: "reschedule",
      reason: "I couldn't reach my drift-read just now; letting the worker continue and looking again shortly.",
      nextCheckIn: { afterSecs: checkinDefaultS, reason: "retry drift-read after a brain glitch" },
    };
  }
}

// =======================================================================================
// Cheap worker summary (Spec 06 §4.5 / Spec 03 §4.1, B9)
// =======================================================================================

export const WORKER_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "workerId",
    "whatItsDoing",
    "recentActions",
    "currentPlan",
    "signalsOfDrift",
    "signalsOfProgress",
    "blockedOn",
  ],
  properties: {
    workerId: { type: "string" },
    whatItsDoing: { type: "string" },
    recentActions: { type: "array", items: { type: "string" } },
    currentPlan: { type: "string" },
    signalsOfDrift: { type: "array", items: { type: "string" } },
    signalsOfProgress: { type: "array", items: { type: "string" } },
    blockedOn: { type: ["string", "null"] },
  },
};

const WorkerSummaryZ = z.object({
  workerId: z.string(),
  whatItsDoing: z.string(),
  recentActions: z.array(z.string()),
  currentPlan: z.string(),
  signalsOfDrift: z.array(z.string()),
  signalsOfProgress: z.array(z.string()),
  blockedOn: z.string().nullable(),
});

/**
 * Compress a worker's recent transcript into a {@link WorkerSummary} (Haiku, B9) before the
 * Opus drift-read — never wake Opus on raw JSONL (Spec 06 §7.2). On failure, return a minimal
 * mechanical summary built from the worker's own counters so the drift-read can still run.
 */
export async function summarizeWorker(
  worker: Worker,
  ctx: BrainContext | undefined,
  deps: RoleDeps,
  model: string,
): Promise<WorkerSummary> {
  try {
    const s = await callJSON<WorkerSummary>({
      bin: deps.bin,
      model,
      system: summarySystem(),
      prompt: summaryUser(worker, ctx),
      jsonSchema: WORKER_SUMMARY_SCHEMA,
      validate: (v) => WorkerSummaryZ.parse(v) as WorkerSummary,
      schemaName: "summary",
      retry: deps.retry,
      logger: deps.logger,
    });
    s.workerId = worker.id; // source of truth is the orchestrator's id, not the model's echo
    return s;
  } catch (err) {
    deps.logger.warn("worker summary failed; using mechanical fallback", {
      worker: worker.id,
      error: (err as Error).message,
    });
    return {
      workerId: worker.id,
      whatItsDoing: `running (model ${worker.model}, ${worker.spend.turns} turns)`,
      recentActions: [],
      currentPlan: "unknown (summary unavailable)",
      signalsOfDrift: [],
      signalsOfProgress:
        worker.spend.diffLines.added + worker.spend.diffLines.removed > 0
          ? [`diff +${worker.spend.diffLines.added}/-${worker.spend.diffLines.removed}`]
          : [],
      blockedOn: null,
    };
  }
}

export { BrainCallError };
