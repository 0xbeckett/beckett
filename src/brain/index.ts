/**
 * Beckett — the hybrid Brain (`src/brain/index.ts`)
 * =======================================================================================
 * The {@link Brain} implementation (Spec 06): the Haiku front door + the stateless Opus
 * judgment middle + the Haiku voice. This module wires the role functions
 * (intake/plan/review/deliver) to the model-routing table (Spec 06 §2) and the one model
 * boundary ({@link ./llm.ts}). It holds no LLM session — every call is a fresh stateless
 * `claude -p` subprocess; continuity lives in SQLite + Memory, re-injected via {@link
 * BrainContext} (Spec 06 §3.1).
 *
 * Model routing (config `[models]`):
 *   - front_door (Haiku): intake, worker summary, delivery voice, escalation voice
 *   - judgment  (Opus):   clarify, plan, drift-read, gate review
 *   - reviewer  (Opus):   reserved for the fresh adversarial reviewer (Spec 11) — v0 gate uses judgment
 *
 * STAFF is fused into PLAN for v0 (Spec 06 §4.4): {@link BeckettBrain.staff} accepts PLAN's
 * `suggestedWorker` per node directly, with no extra Opus call.
 */

import type {
  Brain,
  Config,
  Paths,
  Logger,
  IntakeEvent,
  HaikuClassification,
  TaskRecord,
  BrainContext,
  ClarifyOutput,
  PlanOutput,
  StaffOutput,
  Worker,
  WorkerSummary,
  SmokeAlarm,
  SuperviseDecision,
  NodeRecord,
  ChecksOutcome,
  ReviewVerdict,
  Escalation,
  Persona,
} from "../types.ts";
import { makeLogger } from "../log.ts";
import { BRAIN_RETRY_MAX, type RoleDeps } from "./llm.ts";
import { loadPersona } from "./prompts.ts";
import { classifyIntake } from "./intake.ts";
import {
  runClarify,
  runPlan,
  runSupervise,
  summarizeWorker as summarizeWorkerImpl,
  staffFromPlan,
} from "./plan.ts";
import { reviewNode } from "./review.ts";
import { composeDelivery, composeEscalation } from "./deliver.ts";

/** Construction inputs for the Brain (the daemon wires the concrete config + paths). */
export interface BrainDeps {
  config: Config;
  paths: Paths;
  logger?: Logger;
}

/** The hybrid Haiku-front-door + Opus-judgment Brain (Spec 06). */
export class BeckettBrain implements Brain {
  private readonly config: Config;
  private readonly paths: Paths;
  private readonly logger: Logger;
  private readonly deps: RoleDeps;

  constructor(d: BrainDeps) {
    this.config = d.config;
    this.paths = d.paths;
    this.logger = (d.logger ?? makeLogger()).child("brain");
    this.deps = {
      bin: d.config.harness.claude.bin,
      retry: {
        maxRetries: BRAIN_RETRY_MAX,
        backoffBaseMs: d.config.retry.backoff_base_ms,
        backoffMaxMs: d.config.retry.backoff_max_ms,
      },
      logger: this.logger,
    };
  }

  /** Persona, hot-reloaded by mtime from `~/.beckett/persona.md` (Spec 06 §5.1). */
  private persona(): Persona {
    return loadPersona(this.paths.personaFile);
  }

  private get frontDoor(): string {
    return this.config.models.front_door;
  }
  private get judgment(): string {
    return this.config.models.judgment;
  }

  // ── front door (Haiku) ──────────────────────────────────────────────────────────────

  intake(evt: IntakeEvent): Promise<HaikuClassification> {
    return classifyIntake(evt, this.persona(), this.deps, this.frontDoor);
  }

  // ── judgment (Opus) ─────────────────────────────────────────────────────────────────

  clarify(task: TaskRecord, ctx: BrainContext): Promise<ClarifyOutput> {
    return runClarify(task, ctx, this.persona(), this.deps, this.judgment);
  }

  plan(task: TaskRecord, ctx: BrainContext): Promise<PlanOutput> {
    return runPlan(task, ctx, this.persona(), this.deps, this.judgment);
  }

  /** v0: STAFF fused into PLAN — accept the planner's suggestion directly (Spec 06 §4.4). */
  staff(_task: TaskRecord, plan: PlanOutput, _ctx: BrainContext): Promise<StaffOutput> {
    return Promise.resolve(staffFromPlan(plan));
  }

  summarizeWorker(worker: Worker, ctx: BrainContext): Promise<WorkerSummary> {
    return summarizeWorkerImpl(worker, ctx, this.deps, this.frontDoor);
  }

  superviseRead(
    worker: Worker,
    summary: WorkerSummary,
    alarms: SmokeAlarm[],
    ctx: BrainContext,
  ): Promise<SuperviseDecision> {
    return runSupervise(
      worker,
      summary,
      alarms,
      ctx,
      this.persona(),
      this.deps,
      this.judgment,
      this.config.supervise.checkin_default_s,
    );
  }

  gate(
    node: NodeRecord,
    checks: ChecksOutcome,
    diff: string,
    ctx: BrainContext,
  ): Promise<ReviewVerdict> {
    return reviewNode(node, checks, diff, ctx, this.deps, this.judgment);
  }

  // ── voice (Haiku) ───────────────────────────────────────────────────────────────────

  deliver(task: TaskRecord, ctx: BrainContext): Promise<string> {
    return composeDelivery(task, ctx, this.persona(), this.deps, this.frontDoor);
  }

  escalationVoice(escalation: Escalation, ctx: BrainContext): Promise<string> {
    return composeEscalation(escalation, ctx, this.persona(), this.deps, this.frontDoor);
  }
}

/** Factory: build a Brain from config + paths (the daemon's wiring point). */
export function createBrain(deps: BrainDeps): Brain {
  return new BeckettBrain(deps);
}

// ── re-exports the orchestrator consumes (pure helpers + the model boundary) ──

export { callJSON, callText, BrainCallError, BRAIN_RETRY_MAX, type RoleDeps } from "./llm.ts";
export { loadPersona, parsePersona, DEFAULT_PERSONA, renderMemory } from "./prompts.ts";
export { classifyIntake, HAIKU_CLASSIFICATION_SCHEMA } from "./intake.ts";
export {
  runClarify,
  runPlan,
  runSupervise,
  summarizeWorker,
  planToPlan,
  validatePlanOutput,
  staffFromPlan,
  PLAN_SCHEMA,
  CLARIFY_SCHEMA,
  SUPERVISE_DECISION_SCHEMA,
  WORKER_SUMMARY_SCHEMA,
} from "./plan.ts";
export {
  reviewNode,
  runChecks,
  runCheck,
  buildCheckEnv,
  normalizeVerdict,
  runGate,
  summarizeGate,
  gateRetriesExhausted,
  chooseTier,
  criticalitySignals,
  diffStats,
  redispatchBrief,
  buildGateEscalation,
  gateOutcomeRow,
  gateOutcome,
  DEFAULT_REVIEW_CONFIG,
  REVIEW_VERDICT_SCHEMA,
  type ReviewConfig,
  type CheckEnv,
} from "./review.ts";
export { composeDelivery, composeEscalation } from "./deliver.ts";
