/**
 * Beckett v5 — the dispatcher stage registry (`src/dispatch/stages.ts`)
 * =======================================================================================
 * Phase 3 of the V5 extensibility refactor (OPS-180): the ONE place a worker stage is
 * defined. Before this module, adding a stage meant editing the dispatcher's state-machine
 * switch, its finish-handler if/else chain, its per-stage casting defaults, the spawn
 * helper's prompt builder AND its system-append builder — 7+ hand-wired touch points that
 * all had to agree on a bare string. This registry generalizes the one extension point that
 * already worked (the harness driver registry, `drivers/index.ts`): a stage is a
 * self-describing {@link StageDefinition} that plugs in
 *
 *   - which ticket state staffs it ({@link StageDefinition.entryState} + optional guard),
 *   - its default cast when the ticket casts nothing ({@link StageDefinition.resolveCast}),
 *   - its prompt builder and system-append (moved here from `spawn.ts`),
 *   - its done-signal parser (the shared strict {@link parseDoneSignal} by default),
 *   - its finish handler — what to do with the ticket when its worker ends — written
 *     against the narrow {@link StageOps} surface the {@link Dispatcher} implements,
 *   - its spawn-failure policy (review retries through the review-infra gate) and
 *     spawn-time behavior flags (base-sha capture, diff pre-read).
 *
 * The retry/rework caps the finish handlers bound themselves by are CONFIG now
 * (`[supervise] max_*`, resolved once via {@link retryCapsFor}) — they were hardcoded
 * dispatcher constants. {@link defaultEffortFor} also lives here as the single source of
 * truth (it was duplicated verbatim in `spawn.ts` and `dispatcher.ts`).
 *
 * Behavior contract: the four v5 built-in stages (implement / review / design / design_check)
 * are the pre-registry dispatcher/spawn logic moved VERBATIM — every ticket comment, state
 * transition, and cap default is byte-identical. The dispatcher's shared failure machinery
 * (bounded implement retries, publish gating, classed auth/rate-limit handling) deliberately
 * stays in the dispatcher and is reached through {@link StageOps} — it is fleet policy, not
 * a stage's own shape.
 *
 * issue #128 adds a FIFTH+SIXTH pair, `plan`/`plan_check` (`dispatch/plan-stage.ts`), ahead of
 * implement: every ticket now authors a strong-seat brief before an implement worker is ever
 * staffed, structurally — `implementStage.entryGuard` refuses to staff without a `plan_check`
 * verified record, and that record lives in dispatcher runtime state, never a ticket field a
 * filer could spoof. See `plan-stage.ts`'s header for the full enforcement writeup.
 */

import type { Config, DoneSignal, Logger } from "../types.ts";
import { ActionClass } from "../types.ts";
import type { HarnessSpec, Ticket, TicketState } from "../tracker/types.ts";
import { ExtensionRegistry, type Extension, type ExtensionFactory } from "../ext/index.ts";
import type { DispatchOutcome } from "./events.ts";
import type { TicketWorkerHandle } from "./spawn.ts";
import { defaultEffortFor, isPlanExempt, projectSlug, taskKeyOf } from "../tracker/cast.ts";
import { steeringBlock } from "./resume-brief.ts";
import { CapabilityRegistry, type CapabilityDeps, type PromptBlock } from "../capability/index.ts";
import { availableCapabilityModules, createCapability } from "../capability/modules/index.ts";
import { buildPaths } from "../paths.ts";
import { warmApexDomain } from "../agency/cloudflare.ts";
import { planContextBlock, planNoRederiveNote, planReviewPointer } from "./plan-artifact.ts";
// `plan-stage.ts` imports several of THIS module's exports (taskHeader, taskCriteria,
// workerSystemAppend, parseDoneSignal, doneSignalSummary — all hoisted function declarations,
// plus type-only `StageDefinition`/`StageOps`/`PlanVerification`), so this is a deliberate
// two-way import. It resolves safely because every binding `plan-stage.ts` reads from here is
// either a hoisted `function` (live before either module's top-level body runs) or a type (erased
// at runtime) — never a `const` value — so by the time `buildStagesExtension()` below actually
// runs (module bottom), `plan-stage.ts` has always finished evaluating. See `plan-stage.ts`'s own
// header comment for the other half of this contract.
import { planStage, planCheckStage, planDocPath } from "./plan-stage.ts";

// =======================================================================================
// Shared vocabulary: caps, effort, done-signal parsing
// =======================================================================================

/**
 * The dispatcher's retry/rework bounds, resolved from `[supervise]` config. Every field
 * defaults to the pre-config constant it replaced, so a minimal/legacy config (and the
 * dispatcher unit tests' bare `cfg()`) behaves exactly as before.
 */
export interface RetryCaps {
  /** Max implement↔review round-trips before auto-rework stops and waits for a human. */
  reworkCycles: number;
  /** The completeness checker may send an incomplete design back this many times total. */
  designCycles: number;
  /**
   * The plan checker may send an incomplete/oversized plan back this many times before a human
   * takes over (issue #128) — deliberately separate from {@link designCycles} even though the
   * shape mirrors it: a plan cap change must not silently move design's too. Wired to
   * `[supervise] max_plan_cycles` (`src/capability/builtins.ts`), defaulting to the same 2 this
   * shipped hardcoded with before that config key existed.
   */
  planCycles: number;
  /** Max auto-respawns of an implement worker that ended without a clean finish (OPS-50). */
  implementRetries: number;
  /** Max review infra/schema retries before the dispatcher waits for a human verdict. */
  reviewInfraRetries: number;
  /** Max healthy-harness substitutions (auth/rate-limit recovery) before parking (#84). A clean
   *  substitution is not a spawn failure, so it is bounded by this OWN budget, not implementRetries. */
  harnessSubstitutions: number;
}

/** Resolve the retry caps from config, falling back to the historical defaults. */
export function retryCapsFor(config: Config): RetryCaps {
  return {
    reworkCycles: config.supervise?.max_rework_cycles ?? 3,
    designCycles: config.supervise?.max_design_cycles ?? 2,
    planCycles: config.supervise?.max_plan_cycles ?? 2,
    implementRetries: config.supervise?.max_implement_retries ?? 3,
    reviewInfraRetries: config.supervise?.max_review_infra_retries ?? 1,
    harnessSubstitutions: config.supervise?.max_harness_substitutions ?? 6,
  };
}

/**
 * The configured default reasoning effort for a harness — the ONE source of truth (this switch
 * was previously duplicated in `spawn.ts#defaultEffortFor` and `dispatcher.ts#defaultEffortFor`,
 * one drift away from casting and telemetry disagreeing). Issue #128: the implementation moved to
 * `tracker/cast.ts` so `isPlanExempt` there can resolve a ticket's real implement effort without
 * `cast.ts` importing this module (a cycle — this module already imports `cast.ts`); re-exported
 * here VERBATIM so every existing call site (`dispatch/spawn.ts`, `dispatch/dispatcher.ts`) keeps
 * importing it from `./stages.ts` with no change.
 */
export { defaultEffortFor };

/** Strict structured done-signal parse (Spec 02 §6): anything off-schema is null, never a guess. */
export function parseDoneSignal(structured: unknown): DoneSignal | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const o = structured as Record<string, unknown>;
  const allowed = new Set(["status", "summary", "filesChanged", "checksRun", "blockedReason"]);
  if (Object.keys(o).some((key) => !allowed.has(key))) return null;
  const status = o.status;
  if (status !== "complete" && status !== "blocked" && status !== "partial") return null;
  if (typeof o.summary !== "string") return null;
  if (!Array.isArray(o.filesChanged) || !o.filesChanged.every((f) => typeof f === "string")) return null;
  if (
    o.checksRun !== null &&
    (!Array.isArray(o.checksRun) || !o.checksRun.every((c) => typeof c === "string"))
  ) {
    return null;
  }
  if (o.blockedReason !== null && typeof o.blockedReason !== "string") return null;

  return {
    status,
    summary: o.summary,
    filesChanged: o.filesChanged,
    ...(Array.isArray(o.checksRun) ? { checksRun: o.checksRun } : {}),
    ...(typeof o.blockedReason === "string" ? { blockedReason: o.blockedReason } : {}),
  };
}

/** A done-signal's human summary, with the blocked reason appended when present. */
export function doneSignalSummary(signal: DoneSignal, fallback: string): string {
  const blockedReason = signal.blockedReason ? `\n\nBlocked reason:\n${signal.blockedReason}` : "";
  const summary = signal.summary || fallback;
  return `${summary}${blockedReason}`;
}

/** INT is a separate tracker board; its identifiers are minted as INT-N. */
export function isIntTicket(ticket: Ticket): boolean {
  return ticket.identifier.toUpperCase().startsWith("INT-") || ticket.projectId.toUpperCase() === "INT";
}

/**
 * Review effort scaled from the implement cast (issue #27): a `low`-effort implement doesn't
 * need an `xhigh` review. Defaults to `high` — the review's job is judging a diff against
 * criteria, not re-deriving the implementation.
 */
export function reviewEffortFor(ticket: Ticket): NonNullable<HarnessSpec["effort"]> {
  switch (ticket.casting.implement?.effort) {
    case "low":
      return "medium";
    case "xhigh":
      return "xhigh";
    default:
      return "high";
  }
}

// =======================================================================================
// The stage contract
// =======================================================================================

/** Inputs to a stage's task-brief builder (the worker's first user turn). */
export interface StagePromptArgs {
  ticket: Ticket;
  /** Base ref the ticket's worktree was first branched from (the REVIEW diff base). */
  baseRef?: string;
  /** Steering comments buffered while no worker was live (issue #22). */
  steering?: string[];
  /** The pre-read contribution diff for review prompts (issue #27). */
  reviewDiff?: string;
  /**
   * The ticket's verified plan-stage brief (issue #128), pre-read by the dispatcher when
   * `ops.hasVerifiedPlan(ticket.id)`. Absent for every ticket without one — including every
   * ticket that predates this stage — so `genericTaskPrompt`'s output stays byte-identical to
   * before (`plan-artifact.ts#planContextBlock` returns `""` for `undefined`).
   */
  planDoc?: string;
  /** Commit the plan doc was verified at (freshness marker in the inlined block). */
  planDocSha?: string;
}

/** Inputs to a stage's system-append builder (the worker persona + scope). */
export interface StageAppendArgs {
  ticket: Ticket;
  config: Config;
  baseRef?: string;
  /** Env source for the publishing guidance (tests inject; defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Same plan-doc presence signal as {@link StagePromptArgs.planDoc} — gates `planNoRederiveNote()`. */
  planDoc?: string;
}

/** A finished worker, as the dispatcher hands it to the stage's finish handler. */
export interface StageFinishArgs {
  ticket: Ticket;
  handle: TicketWorkerHandle;
  status: "success" | "error";
  /** Human summary (done-signal summary or last assistant text, spend line appended). */
  summary: string;
}

/**
 * A dispatcher-owned record of a ticket's plan-stage brief, written ONLY by `plan_check`'s finish
 * handler once it verifies a plan doc is complete, within the size ceiling, AND was actually
 * authored by an allowlisted strong seat (issue #128). Deliberately captures the cast that
 * ACTUALLY RAN — `pickHealthyHarness`'s resolved harness/model, not the ticket's requested cast —
 * so a harness substitution can never silently satisfy the gate with a weaker seat than the one
 * that was supposed to run (see `implementStage.entryGuard` / `hasQualifyingPlan`, the consumer).
 */
export interface PlanVerification {
  /** Commit the plan doc was verified at (`docs/plan/<id>.md`'s content, at this sha), or null
   *  when the checker's worktree read couldn't resolve one (never silently wrong — see `ops.headSha`). */
  sha: string | null;
  /** The harness that actually produced the verified plan (post-substitution, if any). */
  harness: string;
  /** The model that actually produced the verified plan, when the harness names one. */
  model?: string;
  /**
   * The plan doc's full committed text, captured ONCE by `plan_check`'s finish handler (issue
   * #128 correction pass, "amortize per task"). This record is keyed by TASK, not ticket
   * (`taskKeyOf`) — a sibling branch reusing this record never ran a plan worker of its own, so
   * its own git worktree never has the doc committed in it. Storing the text here (not just a
   * path) means the reused ticket's implement/review prompt still gets the real inlined brief
   * regardless of git branch topology — the guarantee amortization must not quietly weaken.
   */
  doc: string;
  /** ISO-8601 timestamp `plan_check` recorded this verification. */
  verifiedAt: string;
}

/**
 * The dispatcher operations a stage finish handler may perform — the narrow, explicit
 * surface between pluggable stage logic and the dispatcher's shared machinery (tracker
 * writes, publish gating, bounded failure policy, persisted counters). Implemented by the
 * {@link Dispatcher}; a stage never reaches into dispatcher internals beyond this.
 */
export interface StageOps {
  readonly config: Config;
  readonly logger: Logger;
  /** Config-resolved retry/rework bounds (see {@link retryCapsFor}). */
  readonly caps: RetryCaps;
  /** Emit one persisted-before-live stage-transition telemetry event. */
  trace(ticket: Ticket, stage: string, outcome: DispatchOutcome, message?: string, error?: string): void;
  /** Post a dispatcher-marked ticket comment (never read back as steering). Best-effort. */
  postComment(ticketId: string, body: string): Promise<void>;
  /** Move the ticket's ticket state with a comment; false when a human terminal move won. */
  advanceTicket(ticket: Ticket, state: TicketState, comment: string): Promise<boolean>;
  /** Durably hold a ticket for a human even when the tracker projects it as an active state. */
  parkForHuman(ticket: Ticket, comment: string): Promise<boolean>;
  /** Commit whatever is in the ticket's checkout as a WIP snapshot; sha or null. Never throws. */
  commitWip(ticket: Ticket, handle: TicketWorkerHandle): Promise<string | null>;
  /** Safety-net commit of a finished implementation; true when something was committed. */
  commitContribution(ticket: Ticket, handle: TicketWorkerHandle): Promise<boolean>;
  /** Staff another stage on this ticket (queued when the concurrency cap is reached). */
  spawnStage(ticket: Ticket, stage: string): void;
  /** Publish-then-done finish (OPS-30 false-done fix); false when the publish is held/queued. */
  finishTicketAsDone(ticket: Ticket, messagePrefix: string, summary: string): Promise<boolean>;
  /** The ticket's review gate: `self` (one-pass, self-verified) or `fresh` (separate reviewer). */
  reviewTierFor(ticket: Ticket): "self" | "fresh";
  /** True when the ticket has a real diff against its base (self-review zero-diff guard). */
  hasTicketContribution(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    committedContribution: boolean,
  ): Promise<boolean>;
  /** Shared implement failure policy: commit WIP, classed/bounded retry, park on exhaustion. */
  implementIncomplete(ticket: Ticket, handle: TicketWorkerHandle, summary: string): Promise<void>;
  /** Shared review infra/schema failure policy: bounded review retry, then hold for a human. */
  reviewInfraFailure(ticket: Ticket, reason: string, summary: string): Promise<void>;
  /** Persist the dispatcher's restart-surviving ticket memory (counters included). */
  persistRuntimeState(): void;
  /**
   * `true` iff `taskKey` (see {@link taskKeyOf} — the ticket's TASK, not its own id, issue #128
   * correction pass's "amortize per task" ask) has a dispatcher-recorded, `plan_check`-verified
   * plan brief on file — the ONE fact `implementStage.entryGuard` consults (via `hasQualifyingPlan`,
   * which also applies the tiering exemption) to decide whether an implement worker may be
   * staffed. This is the enforcement point: it is dispatcher runtime state (never a ticket field a
   * filer/cast can spoof) and it is set in exactly one place ({@link recordPlanVerified}, called
   * only by `plan_check`'s finish handler on a verified pass).
   */
  hasVerifiedPlan(taskKey: string): boolean;
  /** Record a task's verified plan brief (issue #128), keyed by {@link taskKeyOf}. See {@link PlanVerification}. */
  recordPlanVerified(taskKey: string, record: PlanVerification): void;
  /**
   * The harness/model that actually launched THIS ticket's plan-authoring worker (issue #128) —
   * set by `doSpawn` once cast resolution/health-substitution/override-rejection are all final,
   * consumed (read-and-cleared) by `plan_check`'s finish handler so it records the cast that
   * ACTUALLY ran, never the ticket's merely-requested cast (closes a doc/code contradiction:
   * `PlanVerification`'s own doc promised this and the pre-fix code didn't deliver it). `undefined`
   * when nothing was recorded (falls back to the strong-seat default — see `plan-stage.ts`).
   */
  planAuthorCastFor(ticketId: string): HarnessSpec | undefined;
  /**
   * Current HEAD sha of the ticket's own worktree checkout, or `null` when it can't be resolved
   * (no allocated workspace, a git read failure). Used by `plan_check`'s finish handler to give
   * {@link PlanVerification.sha} a real freshness marker instead of a hardcoded `null`. Never throws.
   */
  headSha(ticket: Ticket): Promise<string | null>;
  /**
   * Read a file at `relPath` from the ticket's own worktree checkout (issue #128 —
   * `plan_check`'s mechanical size gate reads the committed plan doc directly rather than
   * trusting the cheap checker model's own sense of "is this too long"). Throws if the ticket has
   * no allocated workspace yet or the file doesn't exist; callers treat that as a gap, not a pass.
   */
  readTicketFile(ticket: Ticket, relPath: string): Promise<string>;
  /** Restart-surviving per-ticket counters (persisted by {@link persistRuntimeState}). */
  readonly counters: {
    /** Implement↔review round-trips, bounded by {@link RetryCaps.reworkCycles}. */
    rework: Map<string, number>;
    /** Review crashes/malformed verdicts, bounded by {@link RetryCaps.reviewInfraRetries}. */
    reviewInfra: Map<string, number>;
    /** Incomplete design-check passes, bounded by {@link RetryCaps.designCycles}. */
    designCycles: Map<string, number>;
    /** Incomplete/oversized/wrong-seat plan-check passes, bounded by {@link RetryCaps.planCycles}. */
    planCycles: Map<string, number>;
  };
}

/**
 * One self-describing worker stage. Register one of these and the dispatcher can staff it,
 * cast it, prompt it, parse its done-signal, and advance the ticket when it finishes — no
 * other file needs to know the stage exists.
 */
export interface StageDefinition {
  readonly name: string;
  /** Ticket state whose entry staffs this stage; absent for follow-on stages a finish handler spawns (design_check). */
  readonly entryState?: TicketState;
  /**
   * Extra admission gate on {@link entryState} staffing (design is INT-board-only; implement
   * requires a verified plan brief — issue #128, see `hasQualifyingPlan`). Takes {@link StageOps}
   * (widened from ticket-only, issue #128) because a guard may need to consult DISPATCHER RUNTIME
   * STATE, not just the ticket's own fields — `hasQualifyingPlan` reads `ops.hasVerifiedPlan`,
   * which no ticket field could carry without also being spoofable by whatever files the ticket.
   * Backward compatible: a guard declared with just `(ticket) => boolean` (like `isIntTicket`)
   * still satisfies this type — TS allows ignoring trailing parameters.
   */
  entryGuard?(ticket: Ticket, ops: StageOps): boolean;
  /** Capture the repo HEAD before new work as the ticket's review-diff base (implement). */
  readonly capturesBaseSha?: boolean;
  /** Pre-read the ticket's contribution diff into the prompt (review, issue #27). */
  readonly preloadsDiff?: boolean;
  /** Resolve the stage's cast: apply the stage default when the ticket casts nothing. */
  resolveCast(explicit: HarnessSpec | undefined, ticket: Ticket, config: Config): HarnessSpec;
  /** The initial task brief (first user turn) handed to the worker. */
  buildPrompt(args: StagePromptArgs): string;
  /** The worker persona + scope system append. */
  buildSystemAppend(args: StageAppendArgs): string;
  /** Parse this stage's structured done-signal (the shared strict parser by default). */
  parseDoneSignal(structured: unknown): DoneSignal | null;
  /**
   * Stage-specific spawn-failure policy (issue #17). Absent → the dispatcher's default
   * bounded, backed-off re-spawn. Review routes through the review-infra gate instead.
   */
  spawnFailure?(ops: StageOps, ticket: Ticket, error: Error): Promise<void>;
  /** Advance the ticket when this stage's worker finishes (state moves + summary comments). */
  finish(ops: StageOps, args: StageFinishArgs): Promise<void>;
}

// =======================================================================================
// The registry
// =======================================================================================

/**
 * The stage lookup, mirroring the harness driver registry (`drivers/index.ts`): the
 * dispatcher and the spawn helper never branch on stage names — they ask the registry.
 * Unknown stage names keep their pre-registry behavior: generic task prompt, worker
 * persona, plain-claude cast, and a generic finish comment (the dispatcher handles the
 * missing-definition case).
 *
 * v6 Phase 5: production resolution moved to the {@link ExtensionRegistry} (the stages facet,
 * read through {@link stageViewOf}); this class remains the standalone, test-constructible
 * implementation of the same {@link StageView} surface and retires with its last consumer.
 */
export class StageRegistry {
  private readonly stages = new Map<string, StageDefinition>();

  /** Register a stage. Duplicate names fail loudly — silent replacement hides drift. */
  register(def: StageDefinition): void {
    if (this.stages.has(def.name)) {
      throw new Error(`beckett: stage "${def.name}" is already registered`);
    }
    this.stages.set(def.name, def);
  }

  /** The stage definition for `name`, or undefined for an unregistered stage. */
  get(name: string): StageDefinition | undefined {
    return this.stages.get(name);
  }

  /** The stage a ticket entering `state` should staff, if any. */
  forState(state: TicketState): StageDefinition | undefined {
    for (const def of this.stages.values()) {
      if (def.entryState === state) return def;
    }
    return undefined;
  }

  /** Registered stage names (diagnostics). */
  names(): string[] {
    return [...this.stages.keys()];
  }

  /** A stage's task brief; unregistered stages get the generic task prompt (old fallback). */
  prompt(stage: string, args: StagePromptArgs): string {
    const def = this.get(stage);
    return def ? def.buildPrompt(args) : genericTaskPrompt(args);
  }

  /** A stage's system append; unregistered stages get the worker persona (old fallback). */
  systemAppend(stage: string, args: StageAppendArgs): string {
    const def = this.get(stage);
    return def ? def.buildSystemAppend(args) : workerSystemAppend(args);
  }

  /** A stage's resolved cast; unregistered stages default to plain claude (old fallback). */
  resolveCast(stage: string, explicit: HarnessSpec | undefined, ticket: Ticket, config: Config): HarnessSpec {
    const def = this.get(stage);
    return def ? def.resolveCast(explicit, ticket, config) : explicit ?? { harness: "claude" };
  }
}

// =======================================================================================
// Prompt + system-append building blocks (moved verbatim from spawn.ts)
// =======================================================================================

/** The criteria bullet block, or a placeholder when none were authored. */
function criteriaBlock(criteria: string[]): string {
  return criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : "- (none specified)";
}

/** The diff command a reviewer runs to see the ticket's whole contribution on its branch. */
function diffHint(baseRef?: string): string {
  return baseRef && baseRef !== "HEAD"
    ? `\`git diff ${baseRef}..HEAD\` (plus \`git status\` for anything uncommitted)`
    : "`git diff HEAD` and `git log`";
}

/** Above this size the review prompt carries a changed-file summary instead of the raw diff. */
const REVIEW_DIFF_INLINE_MAX = 30_000;

/**
 * The diff section of a review prompt (issue #27): the whole diff inline when it fits, else a
 * changed-file list + instructions to read selectively. Empty string when no diff was pre-read
 * (the reviewer then diffs for itself, as before).
 */
function reviewDiffBlock(diff: string | undefined, baseRef?: string): string {
  const trimmed = diff?.trim();
  if (!trimmed) return "";
  if (trimmed.length <= REVIEW_DIFF_INLINE_MAX) {
    return (
      `\n\n<context>\nThe FULL diff of the contribution is inlined below — judge from it directly; only ` +
      `open files when you need surrounding context.\n\n\`\`\`diff\n${trimmed}\n\`\`\`\n</context>`
    );
  }
  const files = [...trimmed.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]!);
  const list = files.length ? files.map((f) => `- ${f}`).join("\n") : "(could not list files)";
  return (
    `\n\n<context>\nThe contribution is large (~${Math.round(trimmed.length / 1024)}KB across ` +
    `${files.length || "several"} files) — too big to inline. Changed files:\n${list}\n` +
    `Inspect selectively with ${diffHint(baseRef)}.\n</context>`
  );
}

/**
 * `[OPS-42] title`, the header every stage brief opens with. Exported (issue #128) so a stage
 * defined outside this file (`dispatch/plan-stage.ts`) can build a brief in the house shape
 * without re-deriving it — the plan stage's own task header must read identically to every
 * other stage's, since it is read by a HUMAN as well as the next worker.
 */
export function taskHeader(ticket: Ticket): string {
  return `[${ticket.identifier}] ${ticket.title}`;
}

/** The `<criteria>` block shared by every stage brief. Exported for the same reason as {@link taskHeader}. */
export function taskCriteria(ticket: Ticket): string {
  return `\n\n<criteria>\nAcceptance criteria:\n${criteriaBlock(ticket.criteria)}\n</criteria>`;
}

/** Where a ticket's design stage writes (and its checker reads) the design document. */
function designDocPath(ticket: Ticket): string {
  return `docs/design/${ticket.identifier.toLowerCase()}.md`;
}

/** The generic task brief — the implement stage's prompt AND the unknown-stage fallback. */
function genericTaskPrompt({ ticket, steering, planDoc, planDocSha }: StagePromptArgs): string {
  const body = ticket.body.trim() ? `\n\n${ticket.body.trim()}` : "";
  // Issue #128: the ticket's verified plan brief, inlined ahead of <task> when one exists.
  // `planContextBlock` returns "" for an absent doc — every ticket without a plan (including
  // every ticket filed before this stage existed) gets a byte-identical prompt to before.
  return `${planContextBlock(planDoc, planDocSha)}<task>\n${taskHeader(ticket)}${body}\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}`;
}

/**
 * The capability registry a worker system append composes its prompt blocks from: every
 * normalized capability module (Phase 2), registered exactly as the CLI registers them. Only
 * each module's `promptBlock` matters here — verbs and handlers ride along unused, and the
 * factories are pure closure-builders (no IO), so building fresh per append is cheap and
 * keeps this path stateless for tests. Adding a `promptBlock` to any capability module puts
 * its contribution into every worker persona with NO edit here.
 */
function workerPromptCapabilities(config: Config): CapabilityRegistry {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  const deps: CapabilityDeps = { config, paths: buildPaths(config), logger: quiet };
  const registry = new CapabilityRegistry();
  for (const id of availableCapabilityModules()) registry.register(createCapability(id, deps));
  return registry;
}

/**
 * The design stage's extra persona line — stage-owned, not a capability's, so it rides into
 * the composition as a caller-supplied block. Priority 20 keeps the historical persona
 * order: github guidance (10) → this line → the deploy recipe (30).
 */
const designStageBlock: PromptBlock = {
  id: "stage:design-only",
  priority: 20,
  render: () =>
    "This is a DESIGN stage: write and commit the design document only; do not implement the requested change.",
};

/**
 * The businesslike worker persona + scope system append shared by every registered worker stage
 * (each may add its OWN extra persona line via `opts.stageBlock`) — and the unknown-stage
 * fallback. The acceptance criteria live ONCE, in the task brief (the prompt) — duplicating them
 * here doubled every worker's criteria tokens for nothing (issue #25).
 *
 * Phase 4 (#N.7): the capability-owned content between the persona opener and the done-signal
 * closer — the GitHub publishing contract, the deploy-durability recipe — is COMPOSED from
 * the modules' registered {@link PromptBlock}s ({@link CapabilityRegistry.composePrompt}),
 * not concatenated here. The composed output is byte-identical to the pre-V5 append.
 *
 * Exported (issue #128) so `dispatch/plan-stage.ts` composes the SAME persona + capability
 * blocks the design stage does, with its own stage-owned line, instead of hand-rolling a second
 * copy of the composition call that could silently drift from this one (a stage-persona line
 * doubling as a compliance surface — "write the plan only, do not implement" — must never rot).
 */
export function workerSystemAppend(
  { ticket, config, env = process.env, planDoc }: StageAppendArgs,
  opts: { stageBlock?: PromptBlock } = {},
): string {
  const slug = projectSlug(ticket.project || ticket.identifier);
  // Kick off (once per process) resolving the Cloudflare zone's apex so the deploy-durability
  // recipe names a fork's real hostname. Fire-and-forget: the append stays sync, and until the
  // lookup lands `apexDomain()` returns this install's zone — so behavior here is unchanged.
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  void warmApexDomain({ token: env.CLOUDFLARE_API_TOKEN, zoneId: env.CLOUDFLARE_ZONE_ID, logger: quiet });
  const contributions = workerPromptCapabilities(config).composePrompt(
    { config, ticket, slug, env },
    opts.stageBlock ? [opts.stageBlock] : [],
  );
  // Issue #128: tell the worker to treat the inlined plan as given rather than re-deriving it —
  // absent (no plan on record) this is exactly the pre-#128 append, unchanged.
  const planNote = planDoc ? `${planNoRederiveNote()}\n` : "";
  return (
    `<persona>\n` +
    `You are an autonomous worker implementing a ticket. Your cwd is THIS PROJECT'S OWN git repo ` +
    `(\`~/Projects/${slug}\`) — it is yours to build in. Edit freely and commit your work; treat ` +
    `anything outside it (especially Beckett's own source) as read-only.\n` +
    `You are done when ALL the acceptance criteria in your task brief hold.\n` +
    `SELF-REVIEW before you finish: re-read your own diff and CHECK each acceptance criterion ` +
    `holds — there may be no separate reviewer after you. Run the check commands; fix what fails.\n` +
    `${planNote}` +
    `${contributions ? `${contributions}\n` : ""}` +
    `When finished, emit the structured done-signal matching the provided schema (status ` +
    `"complete" when all criteria hold AND your self-review passed, "blocked"/"partial" ` +
    `otherwise with a reason).\n` +
    `</persona>`
  );
}

// =======================================================================================
// Built-in stage: implement
// =======================================================================================

/** Shared handling for an implement worker that itself reported blocked/partial. */
async function implementReportedIncomplete(
  ops: StageOps,
  ticket: Ticket,
  handle: TicketWorkerHandle,
  signal: DoneSignal,
  summary: string,
): Promise<void> {
  const reason = doneSignalSummary(signal, summary);
  ops.trace(ticket, "implement:verdict", "bounced", `implement reported ${signal.status}`);
  if (ops.reviewTierFor(ticket) === "self") {
    const sha = await ops.commitWip(ticket, handle);
    const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";
    await ops.advanceTicket(
      ticket,
      "in_review",
      `The implement worker reported **${signal.status}**, so self-review is disabled and this ` +
        `is going to a fresh review instead of being marked done. I committed any WIP${at}.\n\n${reason}`,
    );
    ops.logger.warn("self-tier implement reported incomplete — sent to review", {
      ticket: ticket.identifier,
      status: signal.status,
    });
    return;
  }

  await ops.implementIncomplete(ticket, handle, reason);
}

/**
 * THE enforcement point for issue #128's structural guarantee: an implement worker is never
 * staffed for a ticket that lacks a `plan_check`-verified, strong-seat-authored brief — UNLESS
 * the ticket is tiered exempt ({@link isPlanExempt}, the correction pass's "for hard tasks it
 * should get thrown to a Plan phase. but if its super easy then theres no point" rule). Recomputed
 * fresh on every call, never cached: a ticket recast harder (e.g. effort bumped medium→high)
 * AFTER it already reached `in_progress` fails this guard on its very next spawn attempt with no
 * extra plumbing — the tiering check and the verified-plan check are re-run together, always.
 *
 * `ops.hasVerifiedPlan` reads dispatcher RUNTIME STATE (`Dispatcher.planVerified`, written only by
 * `plan_check`'s finish handler on a genuine pass), keyed by TASK not ticket ({@link taskKeyOf} —
 * "amortize per task, not per ticket") — never a ticket field, so nothing a filer (including the
 * concierge, now running on the cheap chat-seat default) can write into a ticket's cast or
 * description can satisfy this gate. This is consulted at EVERY staffing call site that asks
 * `stages.forState(state).entryGuard` before spawning (`dispatcher.ts`: the poll-driven transition
 * handler, `advanceTicket`'s own-transition spawn, the mid-spawn re-staff path, and the staffing
 * watchdog) — see `doSpawn`'s own independent assertion for the defense-in-depth backstop covering
 * any FUTURE call site that forgets to consult it.
 */
function hasQualifyingPlan(ticket: Ticket, ops: StageOps): boolean {
  return isPlanExempt(ticket, ops.config) || ops.hasVerifiedPlan(taskKeyOf(ticket));
}

const implementStage: StageDefinition = {
  name: "implement",
  entryState: "in_progress",
  entryGuard: hasQualifyingPlan,
  capturesBaseSha: true,
  resolveCast: (explicit) => explicit ?? { harness: "claude" },
  buildPrompt: genericTaskPrompt,
  buildSystemAppend: (args) => workerSystemAppend(args),
  parseDoneSignal,
  async finish(ops, { ticket, handle, status, summary }): Promise<void> {
    if (status !== "success") {
      await ops.implementIncomplete(ticket, handle, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (signal && (signal.status === "blocked" || signal.status === "partial")) {
      await implementReportedIncomplete(ops, ticket, handle, signal, summary);
      return;
    }

    // Capture any uncommitted work the worker left in the checkout so review/rework (and the
    // human) can see it. The worker may have committed already; this is the safety net.
    const committedContribution = await ops.commitContribution(ticket, handle);

    // v3.1 effort-scaled review. `self` (low/medium-risk work) → the worker self-verified inline,
    // so go straight to done in ONE pass — no separate cold reviewer, no relay. `fresh` →
    // a separate adversarial reviewer (the in_review stage), as before. Done tickets promote DAG
    // dependents immediately here; the later poller state_changed(done) is only a restart backstop.
    if (ops.reviewTierFor(ticket) === "self") {
      if (!(await ops.hasTicketContribution(ticket, handle, committedContribution))) {
        await ops.advanceTicket(
          ticket,
          "in_review",
          `Self-review withheld → **in_review** because the implement worker finished with no diff against the ticket base.\n\n${summary}`,
        );
        ops.logger.warn("self-review withheld: zero-diff implementation", {
          ticket: ticket.identifier,
        });
        return;
      }
      const done = await ops.finishTicketAsDone(ticket, "Self-reviewed → **done** (one pass).", summary);
      if (done) ops.logger.info("ticket self-reviewed → done", { ticket: ticket.identifier });
      return;
    }

    await ops.advanceTicket(ticket, "in_review", `Implementation complete → **in_review**.\n\n${summary}`);
    ops.logger.info("ticket advanced to in_review", { ticket: ticket.identifier });
  },
};

// =======================================================================================
// Built-in stage: review
// =======================================================================================

const reviewStage: StageDefinition = {
  name: "review",
  entryState: "in_review",
  preloadsDiff: true,
  resolveCast: (explicit, ticket, config) => {
    // An explicit review cast that names no effort still gets the SCALED default (issue #27) —
    // otherwise it silently falls through to the harness default (xhigh), the priciest tier.
    if (explicit) return explicit.effort ? explicit : { ...explicit, effort: reviewEffortFor(ticket) };
    return { harness: "claude", model: config.models.reviewer, effort: reviewEffortFor(ticket) };
  },
  buildPrompt({ ticket, baseRef, steering, reviewDiff, planDoc }): string {
    const body = ticket.body.trim() ? `\n\n${ticket.body.trim()}` : "";
    const diffBlock = reviewDiffBlock(reviewDiff, baseRef);
    const inspect = diffBlock
      ? "" // the diff (or its file list) is already in hand
      : `The implementation is committed in the repo you're in (your cwd). Inspect it with ` +
        `${diffHint(baseRef)}, then `;
    // Issue #128: a POINTER only, not a second inlined copy — review already has the diff as
    // ground truth (preloadsDiff); doubling an ~800-token plan block into every review turn would
    // cost more than it saves. `planDoc`'s mere presence is the dispatcher's own signal that a
    // verified plan exists (it only ever reads one onto the spawn args when `hasVerifiedPlan` is
    // true) — the pointer names the doc's PATH, not its content, so this stays a one-line append.
    const planLine = planDoc ? `\n\n${planReviewPointer(planDocPath(ticket))}` : "";
    return (
      `<task>\nReview the implementation for ticket ${taskHeader(ticket)}.${body}\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}${diffBlock}${planLine}\n\n` +
      `${inspect}verify it against EVERY acceptance criterion above. Do not ` +
      `modify the implementation — your job is to judge it.`
    );
  },
  buildSystemAppend({ baseRef }): string {
    return (
      `<persona>\n` +
      `You are an autonomous REVIEWER. The implementation under review is committed in the repo ` +
      `at your cwd. Inspect it with ${diffHint(baseRef)} and judge it against the acceptance ` +
      `criteria listed in your task brief — do NOT edit the implementation.\n` +
      `When finished, emit the structured done-signal matching the provided schema:\n` +
      `  - status "complete"  → the work PASSES review (all criteria met).\n` +
      `  - status "blocked"   → the work FAILS review; put the specific reasons in summary + ` +
      `blockedReason so the next implement pass can fix them.\n` +
      `Put your one-line verdict in summary.\n` +
      `</persona>`
    );
  },
  parseDoneSignal,
  // A review worker that could not even START rides the review-infra retry, never the
  // implement respawn backoff (issue #17).
  spawnFailure: (ops, ticket, err) =>
    ops.reviewInfraFailure(ticket, `Could not start the review worker: ${err.message}.`, ""),
  async finish(ops, { ticket, handle, status, summary }): Promise<void> {
    if (status !== "success") {
      await ops.reviewInfraFailure(ticket, `Reviewer exited with ${status}.`, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (!signal) {
      await ops.reviewInfraFailure(
        ticket,
        "Reviewer finished without a schema-valid structured verdict.",
        summary,
      );
      return;
    }

    ops.counters.reviewInfra.delete(ticket.id);
    ops.persistRuntimeState();
    if (signal.status === "complete") {
      ops.trace(ticket, "review:verdict", "passed", "review passed");
      const done = await ops.finishTicketAsDone(ticket, "Review passed → **done**.", summary);
      if (done) ops.logger.info("ticket advanced to done", { ticket: ticket.identifier });
      return;
    }

    // Review failed — bound the implement↔review loop so it can't churn forever.
    const cycles = (ops.counters.rework.get(ticket.id) ?? 0) + 1;
    ops.trace(ticket, "review:verdict", "bounced", `review requested rework (cycle ${cycles}/${ops.caps.reworkCycles})`);
    ops.counters.rework.set(ticket.id, cycles);
    ops.persistRuntimeState();
    if (cycles >= ops.caps.reworkCycles) {
      await ops.parkForHuman(
        ticket,
        `Review found issues, and this is rework cycle ${cycles}/${ops.caps.reworkCycles} — stopping ` +
          `automatic rework and leaving this in **in_review** for a human to take over.\n\n${summary}`,
      );
      ops.counters.rework.delete(ticket.id);
      ops.persistRuntimeState();
      ops.logger.warn("rework cap reached — leaving for human", {
        ticket: ticket.identifier,
        cycles,
      });
      return; // no setState → no new event → loop stops, ticket awaits a human
    }

    await ops.advanceTicket(
      ticket,
      "in_progress",
      `Review found issues → back to **in_progress** for re-work (cycle ${cycles}/${ops.caps.reworkCycles}).\n\n${summary}`,
    );
    ops.logger.info("ticket sent back to in_progress (review fail)", {
      ticket: ticket.identifier,
      cycle: cycles,
    });
  },
};

// =======================================================================================
// Built-in stages: design + design_check (the INT board's authoring pipeline)
// =======================================================================================

const designStage: StageDefinition = {
  name: "design",
  // `design` is INT-only. The identifier guard keeps a malformed non-INT board state
  // from accidentally spending a design worker.
  entryState: "design",
  entryGuard: isIntTicket,
  resolveCast: (explicit) => explicit ?? { harness: "claude", model: "claude-opus-5", effort: "high" },
  buildPrompt({ ticket, steering }): string {
    const body = ticket.body.trim() ? `\n\n${ticket.body.trim()}` : "";
    const path = designDocPath(ticket);
    return (
      `<task>\nWrite the implementation design document for ticket ${taskHeader(ticket)}.${body}\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}\n\n` +
      `This is the INT **Design** stage: do not implement the ticket yet. Read the repository, make ` +
      `the chosen approach concrete, and write the artifact at \`${path}\`. It must state the problem ` +
      `and chosen approach, cover every acceptance criterion, identify file-level touch-points/interfaces ` +
      `or data shapes, and end with a recommendation plus open questions. Commit the document before ` +
      `finishing; an independent model and then the owner will review it.`
    );
  },
  buildSystemAppend: (args) => workerSystemAppend(args, { stageBlock: designStageBlock }),
  parseDoneSignal,
  /**
   * Design is a real worker stage, followed by an independent cheap completeness pass. The
   * checker gets its own model/session so the author cannot approve its own document.
   */
  async finish(ops, { ticket, handle, status }): Promise<void> {
    const sha = await ops.commitWip(ticket, handle);
    const at = sha ? ` (committed as \`${sha.slice(0, 9)}\`)` : "";
    await ops.postComment(
      ticket.id,
      status === "success"
        ? `Design draft complete${at}; running an independent completeness check.`
        : `Design worker ended early${at}; running the completeness check on the saved draft.`,
    );
    ops.spawnStage(ticket, "design_check");
  },
};

const designCheckStage: StageDefinition = {
  name: "design_check",
  // Separate, inexpensive model: it must not mark the design author's own homework.
  resolveCast: (explicit) => explicit ?? { harness: "claude", model: "claude-haiku-4-5", effort: "low" },
  buildPrompt({ ticket, steering }): string {
    const path = designDocPath(ticket);
    return (
      `<task>\nSanity-check the INT design document for ticket ${taskHeader(ticket)}.\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}\n\n` +
      `Read \`${path}\` (and relevant repository context). Do not edit implementation or author the ` +
      `design yourself. Decide whether it is complete: it must state the problem and a chosen approach, ` +
      `cover every acceptance criterion, give concrete file-level touch-points/interfaces or data shapes, ` +
      `and end with a recommendation and open questions. Emit status \`complete\` only if all hold. ` +
      `Otherwise emit \`blocked\` and list every specific gap in summary/blockedReason.`
    );
  },
  buildSystemAppend(): string {
    return (
      `<persona>\n` +
      `You are an independent design-document completeness checker. Do not edit files. Apply the ` +
      `rubric in the task exactly and finish with the structured done-signal: \"complete\" only for a ` +
      `complete design; otherwise \"blocked\" with actionable gaps.\n</persona>`
    );
  },
  parseDoneSignal,
  async finish(ops, { ticket, handle, status, summary }): Promise<void> {
    const signal = status === "success" ? parseDoneSignal(handle.result?.structured) : null;
    if (signal?.status === "complete") {
      ops.counters.designCycles.delete(ticket.id);
      ops.persistRuntimeState();
      await ops.advanceTicket(
        ticket,
        "design_review",
        `Design completeness check passed. Design document: \`${designDocPath(ticket)}\`\n\n` +
          `**Here's the design — good to build?** Reply with approval to start implementation, or ` +
          `send changes and move this ticket back to **Design**.\n\n${summary}`,
      );
      return;
    }

    const gaps = signal ? doneSignalSummary(signal, summary) : summary || "The completeness checker did not return a valid verdict.";
    ops.trace(ticket, "design-check:verdict", "bounced", "design completeness check found gaps");
    const cycle = (ops.counters.designCycles.get(ticket.id) ?? 0) + 1;
    ops.counters.designCycles.set(ticket.id, cycle);
    ops.persistRuntimeState();
    if (cycle < ops.caps.designCycles) {
      await ops.advanceTicket(
        ticket,
        "design",
        `Design completeness check found gaps; returning to **Design** (pass ${cycle}/${ops.caps.designCycles}). ` +
          `Please address these before the human review:\n\n${gaps}`,
      );
      return;
    }

    ops.counters.designCycles.delete(ticket.id);
    ops.persistRuntimeState();
    await ops.advanceTicket(
      ticket,
      "design_review",
      `⚠ Design completeness check still flagged gaps after ${ops.caps.designCycles} passes:\n\n${gaps}\n\n` +
        `Design document: \`${designDocPath(ticket)}\`\n\n` +
        `**Here's the design — good to build?** Please approve it, or send changes and move this ticket back to **Design**.`,
    );
  },
};

// =======================================================================================
// The v6 stages facet (Phase 5) — the built-ins as ONE core-kind extension
// =======================================================================================

/**
 * The exact stage-lookup surface consumers program against — the {@link StageRegistry} API,
 * now also servable as a view over an {@link ExtensionRegistry}'s stage facet
 * ({@link stageViewOf}). The dispatcher takes this by DI and threads it into the spawn helper,
 * so a test-constructed {@link StageRegistry} and the production extension-backed view are
 * interchangeable at every call site.
 */
export interface StageView {
  /** The stage definition for `name`, or undefined for an unregistered stage. */
  get(name: string): StageDefinition | undefined;
  /** The stage a ticket entering `state` should staff, if any. */
  forState(state: TicketState): StageDefinition | undefined;
  /** Registered stage names (diagnostics). */
  names(): string[];
  /** A stage's task brief; unregistered stages get the generic task prompt (old fallback). */
  prompt(stage: string, args: StagePromptArgs): string;
  /** A stage's system append; unregistered stages get the worker persona (old fallback). */
  systemAppend(stage: string, args: StageAppendArgs): string;
  /** A stage's resolved cast; unregistered stages default to plain claude (old fallback). */
  resolveCast(stage: string, explicit: HarnessSpec | undefined, ticket: Ticket, config: Config): HarnessSpec;
}

/**
 * A {@link StageView} over an {@link ExtensionRegistry}'s registered stage facets — the Phase 5
 * consumer seam: the dispatcher and the spawn helper keep their exact old call sites while
 * stage resolution routes through the ONE extension registry. The unknown-stage fallbacks are
 * preserved verbatim (generic task prompt, worker persona, plain-claude cast). The contract's
 * narrow structural `StageFacet` is widened back to the full {@link StageDefinition} here:
 * dispatch owns the stage vocabulary, and every stage facet registered with the daemon IS a
 * StageDefinition at runtime — the contract keeps `src/ext` dependency-clean, not the shape loose.
 */
export function stageViewOf(registry: ExtensionRegistry): StageView {
  const get = (name: string): StageDefinition | undefined =>
    registry.stage(name) as StageDefinition | undefined;
  return {
    get,
    forState: (state) => registry.stageForState(state) as StageDefinition | undefined,
    names: () => registry.stageNames(),
    prompt: (stage, args) => {
      const def = get(stage);
      return def ? def.buildPrompt(args) : genericTaskPrompt(args);
    },
    systemAppend: (stage, args) => {
      const def = get(stage);
      return def ? def.buildSystemAppend(args) : workerSystemAppend(args);
    },
    resolveCast: (stage, explicit, ticket, config) => {
      const def = get(stage);
      return def ? def.resolveCast(explicit, ticket, config) : explicit ?? { harness: "claude" };
    },
  };
}

/**
 * The built-in worker stages as ONE core-kind extension (v6 Phase 5, docs/v6-architecture.md
 * §6): implement / review / design / design_check / plan / plan_check registered through the
 * contract's stages facet. implement/review/design/design_check are the SAME four objects the
 * pre-Phase-5 singleton held, byte-identical (the accuracy floor, docs §8: every prompt string,
 * transition, comment, effort default, and cap; the review tiers stay dispatcher data via
 * `reviewTierFor`). plan/plan_check are new (issue #128) but registered the SAME way — no
 * capabilities/invoke (stages are staffed by the dispatcher's state machine, never
 * @mention-routed) and no lifecycle (stateless data), so registration order never constrains the
 * stateful organs' boot.
 */
function buildStagesExtension(): Extension {
  return {
    manifest: {
      id: "stages",
      version: "1.0.0",
      summary: "The dispatcher's built-in worker stages (plan / plan_check / implement / review / design / design_check).",
      actionClass: ActionClass.FREE,
      kind: "core",
    },
    stages: [planStage, planCheckStage, implementStage, reviewStage, designStage, designCheckStage],
  };
}

/**
 * The stages extension factory the daemon boot registers (`shell/main.ts`, into the ONE
 * BootedSystem registry). Context-free by nature: a stage resolves config per call through its
 * builder args, so the factory ignores the runtime ctx.
 */
export const createStagesExtension: ExtensionFactory = () => buildStagesExtension();

// =======================================================================================
// The default registry — built-ins registered exactly once at module load
// =======================================================================================

/**
 * The module-level host backing {@link stageRegistry} — the byte-safe Phase 5 sharing move:
 * the spawn helper's default and the dispatcher's default DI both read ONE
 * ExtensionRegistry-backed view (the old singleton semantics, resolution now through the
 * extension seam). Production boot (`shell/main.ts`) registers {@link createStagesExtension}
 * in ITS registry and threads that view into the dispatcher (which threads it to spawn), so
 * the live daemon never reads this host — it serves tests and embedders that pass no DI.
 */
const defaultStagesHost = new ExtensionRegistry();
defaultStagesHost.register(buildStagesExtension());

/** The stage view production code shares by default (tests may construct their own {@link StageRegistry}). */
export const stageRegistry: StageView = stageViewOf(defaultStagesHost);
