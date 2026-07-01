/**
 * Beckett — THE CONTRACT (`src/types.ts`)
 * =======================================================================================
 * This file is the **frozen contract** for the whole codebase. ~10 downstream modules
 * import their shared types and module interfaces from here. It is intentionally
 * implementation-free: types, interfaces, enums, and a few const unions only — NO logic.
 *
 * Anchored to the specs (see ./specs):
 *   - Spec 00 — canon & vocabulary
 *   - Spec 01 — architecture, config schema (§4), IPC (§7)
 *   - Spec 02 — Worker / HarnessDriver / WorkerEvent / WorkerSpend / scope / envelope
 *   - Spec 03 — SmokeAlarm / CheckIn / SuperviseDecision / nudge primitives
 *   - Spec 04 — TaskState / NodeState FSMs, Dag, Escalation, recovery
 *   - Spec 05 — Discord IncomingMessage / AwaitingReply
 *   - Spec 06 — Brain roles, HaikuClassification / ClarifyOutput / PlanOutput / StaffOutput
 *   - Spec 07 — Identity / ActionClass / PendingAction (agency gate)
 *   - Spec 08 — Memory knowledge graph (MemoryNode / RecallQuery / RememberIntent)
 *   - Spec 09 — persistence row types, EventRecord, learned-model outcome
 *   - Spec 10 — CLI id scheme, IPC command set, StatusReport
 *   - Spec 11 — AcceptanceCriteria / CheckResult / ReviewVerdict / GateResult
 *
 * Import style for the whole codebase: **explicit `.ts` extensions** (bun-native, enabled
 * by tsconfig `allowImportingTsExtensions`). e.g. `import { Task } from "./types.ts";`
 */

// =======================================================================================
// SECTION 1 — Primitive unions & enums (Spec 02 §2, Spec 04 §2)
// =======================================================================================

/** A coding-agent CLI Beckett drives as a subprocess (Spec 00 glossary). */
export type Harness = "claude" | "codex" | "pi";

/**
 * The concrete driver implementation for a harness (Spec 02 §2).
 * `codex-app-server` (mid-turn steer) is reserved for v2 and intentionally absent.
 */
export type DriverKind = "claude-cli-stream" | "codex-exec-oneshot" | "pi-cli-stream";

/** Reasoning depth; mapped per-harness at spawn (Spec 02 §9.1). */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** Worker runtime lifecycle (Spec 02 §2, §10.1). `done` is set by GATE, not the driver. */
export type WorkerState =
  | "spawning" // worktree + process being created; no session_id yet
  | "running" // process alive, a turn in flight or idle awaiting input
  | "nudging" // a steer message is queued/written, not yet acked at a turn boundary
  | "paused" // checkpointed: process killed/idle, session_id retained, diff inspectable
  | "review" // turn loop ended, handed to REVIEW/GATE (Spec 11)
  | "done" // terminal: criteria satisfied (set by GATE)
  | "failed" // terminal: harness error / max-turns / max-wall-clock without success
  | "aborted"; // terminal: deliberately hard-stopped (Spec 03 decision)

/** Terminal worker states (no further driver transitions). */
export const WORKER_TERMINAL: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "done",
  "failed",
  "aborted",
]);

/**
 * TASK-level FSM states (Spec 04 §2). One task is in exactly one state at a time;
 * `EXECUTING` hosts the running DAG of NODE FSMs.
 */
export enum TaskState {
  INTAKE = "INTAKE", // Haiku received the mention; classify + ack
  CLARIFY = "CLARIFY", // awaiting one crisp answer (irreversible ambiguity only)
  PLAN = "PLAN", // Opus writing the DAG + per-node acceptance criteria
  STAFF = "STAFF", // Opus assigning worker type per node (capability table)
  EXECUTING = "EXECUTING", // DAG executor running; many NODE FSMs live underneath
  ESCALATED = "ESCALATED", // halted, awaiting jawrooo (from CLARIFY/EXECUTING/GATE)
  DELIVERING = "DELIVERING", // Haiku composing + posting the final in-channel message
  DELIVERED = "DELIVERED", // terminal: success, handshake pending or resolved
  ABORTED = "ABORTED", // terminal: hard-stopped by jawrooo or self-halt
  FAILED = "FAILED", // terminal: unrecoverable, escalation exhausted/declined
}

export const TASK_TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>([
  TaskState.DELIVERED,
  TaskState.ABORTED,
  TaskState.FAILED,
]);

/** NODE-level FSM states (Spec 04 §2, §5). Run concurrently inside TaskState.EXECUTING. */
export enum NodeState {
  BLOCKED = "BLOCKED", // ≥1 upstream dependency not yet DONE
  READY = "READY", // deps satisfied; waiting on a concurrency slot
  DISPATCHED = "DISPATCHED", // worker spawned (driver booting), not yet streaming
  SUPERVISING = "SUPERVISING", // worker running; orchestrator tailing JSONL read-only
  NUDGING = "NUDGING", // a steer msg is queued/in-flight to the worker
  PAUSED = "PAUSED", // worker frozen (checkpoint); diff under inspection
  INTEGRATING = "INTEGRATING", // merging this node's branch into the project branch
  REVIEWING = "REVIEWING", // checks + (self|fresh) reviewer running vs criteria
  GATING = "GATING", // Opus pass/fail decision against criteria
  RE_DISPATCH = "RE_DISPATCH", // gate failed; re-dispatching with reviewer feedback
  NODE_DONE = "NODE_DONE", // terminal: integrated + gated green
  NODE_FAILED = "NODE_FAILED", // terminal: retries exhausted or aborted → escalates task
}

export const NODE_TERMINAL: ReadonlySet<NodeState> = new Set<NodeState>([
  NodeState.NODE_DONE,
  NodeState.NODE_FAILED,
]);

/** Re-dispatch cycles per node before escalation (Spec 00 ledger; Spec 04 §8). */
export const MAX_RETRIES = 3 as const;

// =======================================================================================
// SECTION 2 — Worker, scope, envelope, control (Spec 02 §2)
// =======================================================================================

/** Owned, non-overlapping write scope for a worker (Spec 02 §2, §8). */
export interface FileScope {
  /** Paths this worker MAY write, relative to repo root (e.g. ["src/auth/**"]). */
  ownedGlobs: string[];
  /** Optional explicit read allowlist; null = read anywhere in the worktree. */
  readGlobs: string[] | null;
  /** NL scope for the criteria/reviewer ("the auth module only"). */
  description: string;
}

/** Bounds effort/turns/wall-clock/network — never dollars (Spec 00 §4; Spec 02 §9). */
export interface ResourceEnvelope {
  effort: Effort; // reasoning depth; mapped per harness (Spec 02 §9.1)
  turnCap: number; // SOFT turn estimate — drives supervisor drift signals, never a hard kill
  // SOFT wall-clock estimate (s) feeding supervisor drift signals — NOT a hard kill. The hard
  // backstop cap is config.supervise.worker_hard_cap_s (drivers/proc.ts#hardCapSeconds); the old
  // 600s guillotine that read this field is gone (OPS-50).
  wallClockS: number;
  network: boolean; // outbound network allowed? default false, opt-in per node
}

/** Cumulative token counts for one turn / run (Spec 02 §7). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Derived telemetry counters (Spec 02 §2/§7.3). Informational only — NEVER a budget gate
 * (Spec 00 §4 Economics: no USD ledger). `usdEstimate`: claude = stream cost, pi = accumulated
 * `usage.cost.total`, codex = static price-table estimate (null when the model isn't priced).
 */
export interface WorkerSpend {
  turns: number;
  toolCalls: number;
  tokens: TokenUsage;
  diffLines: { added: number; removed: number; files: number };
  usdEstimate: number | null;
}

/**
 * What actually happened to a steer (issue #19 — "queued" used to mean three different
 * things). `delivered` = acked into the live turn (claude echo). `queued` = written/buffered,
 * applies within THIS process's lifetime. `will-restart` = buffered by a one-shot harness and
 * will trigger a full relaunch after the current run. `dropped` = the worker already finished;
 * the text will never be applied (the dispatcher surfaces this on the ticket).
 */
export interface NudgeReceipt {
  accepted: "delivered" | "queued" | "will-restart" | "dropped";
  at: number; // epoch ms
}

/** The bound driver handles for one worker — the 3+1 intervention primitives (Spec 02 §2). */
export interface WorkerControl {
  nudge(msg: string): Promise<NudgeReceipt>; // soft steer
  pause(): Promise<void>; // checkpoint (idle/kill, keep session)
  resume(): Promise<void>; // re-attach after pause/restart
  abort(reason: string): Promise<void>; // hard stop, capture partial
  askPlan(): Promise<NudgeReceipt>; // sugar: nudge("what's your current plan?")
}

/**
 * The atomic unit: one harness instance running a scoped node (Spec 02 §2).
 * Orchestrator-owned fields + driver-maintained runtime fields.
 */
export interface Worker {
  id: string; // beckett-assigned, e.g. "wk_7f3a" (NOT the harness session id)
  nodeId: string; // DAG node this worker staffs (Spec 04)
  taskId: string; // owning task
  userId: string; // attribution (Spec 00: multiplayer-ready)

  harness: Harness;
  driver: DriverKind;
  /** Exact launch model id. SOURCE OF TRUTH for Codex (not in its stream — Spec 02 §2). */
  model: string;

  /** claude session_id / codex thread_id. null only while state==='spawning'. */
  sessionId: string | null;

  scope: FileScope;
  workspace: string; // absolute path to this worker's git worktree (its cwd)
  branch: string; // worktree branch, e.g. "beckett/wk_7f3a/<node-slug>"

  resourceEnvelope: ResourceEnvelope;
  criteriaRef: string; // FK to acceptance criteria row (Spec 11)

  state: WorkerState;
  spend: WorkerSpend;
  control: WorkerControl;

  spawnedAt: number;
  lastActivityTs: number; // epoch ms of last parsed WorkerEvent (watchdog input)
  endedAt: number | null;
}

// =======================================================================================
// SECTION 3 — WorkerEvent: normalized telemetry stream (Spec 02 §7)
// =======================================================================================

/** Why a harness failed (issue #17) — drives the dispatcher's per-class recovery policy. */
export type ErrorClass = "auth" | "rate_limit" | "crash" | "timeout" | "spawn";

/**
 * Both raw JSONL formats (claude stream-json / codex --json) normalize into this one
 * discriminated union (Spec 02 §7). The driver owns the raw parse; subscribers only see
 * WorkerEvent. CONTRACT: parsers MUST tolerate unknown raw types — switch on what you know,
 * map the rest to `kind:'unknown'`, never throw (Spec 02 §7.2; loom-desk Risk-A).
 */
export type WorkerEvent =
  | { kind: "session_started"; sessionId: string; model: string; ts: number }
  | { kind: "turn_started"; ts: number }
  | { kind: "assistant_text"; text: string; partial: boolean; ts: number }
  | { kind: "tool_call"; tool: string; input: unknown; toolId: string; ts: number }
  | { kind: "tool_result"; toolId: string; isError: boolean; ts: number }
  | {
      kind: "file_change";
      paths: { path: string; kind: "add" | "update" | "delete" }[];
      ts: number;
    }
  | { kind: "plan_update"; items: { text: string; done: boolean }[]; ts: number }
  | { kind: "user_echo"; text: string; ts: number } // claude --replay-user-messages ack
  | {
      kind: "hook_decision";
      decision: "allow" | "deny" | "ask" | "defer";
      reason?: string;
      ts: number;
    }
  | { kind: "turn_completed"; usage: TokenUsage; ts: number }
  | {
      kind: "finished";
      status: "success" | "error";
      subtype: string;
      structuredOutput: unknown | null;
      usage: TokenUsage;
      /**
       * Failure taxonomy (issue #17): WHY an error finish happened, so the dispatcher can pick
       * the right response — `auth` (hold for a human login), `rate_limit` (back off / fall
       * back), `timeout` (backstop cap), `spawn` (never became a process), `crash` (default
       * bounded retry). Absent on success.
       */
      errorClass?: ErrorClass;
      ts: number;
    }
  | { kind: "error"; message: string; ts: number }
  /** Forward-compat fallthrough: any raw line we recognized but don't model (Spec 02 §7). */
  | { kind: "unknown"; raw: unknown; ts: number };

/** The structured "done-signal" both harnesses fill in when finished (Spec 02 §6). */
export interface DoneSignal {
  status: "complete" | "blocked" | "partial";
  summary: string;
  filesChanged: string[];
  checksRun?: string[];
  blockedReason?: string;
}

// =======================================================================================
// SECTION 4 — Acceptance criteria, checks, review, gate (Spec 11)
// =======================================================================================

/**
 * Acceptance criteria per node: executable checks (exit-code) + NL statements (Spec 11 §2).
 * Mandatory per node (Spec 00: "no node without a 'done'").
 */
export interface AcceptanceCriteria {
  /** Shell commands run in the worktree; ALL must exit 0 for the "checks pass" half. */
  checks: string[];
  /** Natural-language statements a reviewer judges met/not-met against the diff. */
  nl: string[];
  /** Optional interface contract for a node sharing a boundary with a parallel node. */
  interfaceContract?: string;
}

/** Convenience alias used in prose/canon (Spec 00) for AcceptanceCriteria. */
export type Criteria = AcceptanceCriteria;

/** Result of one executable check command (Spec 11 §3). */
export interface CheckResult {
  cmd: string;
  exitCode: number; // 124 convention for our timeout kill
  stdout: string; // truncated
  stderr: string; // truncated
  durationMs: number;
  timedOut: boolean;
  pass: boolean; // exitCode === 0 && !timedOut
}

/** Aggregate of all checks for a node (Spec 11 §3). */
export interface ChecksOutcome {
  results: CheckResult[];
  allPass: boolean; // results.every(r => r.pass) — the "checks pass" gate half
}

/** Tiered review (Spec 11 §4). v0 uses self/fresh; cross/panel are post-v0. */
export type ReviewTier = "self" | "fresh" | "cross" | "panel";

/** Signals that promote a node to a critical (fresh) review tier (Spec 11 §4.1). */
export interface CriticalitySignals {
  touchesSecurity: boolean;
  touchesDeps: boolean;
  blastRadius: number; // # of other nodes depending on this node
  diffLines: number; // added + removed (post-integrate)
  filesChanged: number;
  externalSurface: boolean; // public API / migration / deletes data / irreversible
  priorRetries: number;
}

/** The NL judgment from a reviewer model (Spec 11 §5). */
export interface ReviewVerdict {
  pass: boolean;
  criteriaMet: { criterion: string; met: boolean; note?: string }[];
  issues: {
    severity: "blocker" | "major" | "minor";
    criterion?: string;
    detail: string;
    location?: string;
  }[];
  confidence: number; // 0..1
}

/** Threaded reviewer feedback, appended on every gate-fail (Spec 11 §6; Spec 04 §8). */
export interface ReviewerFeedback {
  attempt: number; // node.attempts at the time of this gate
  tier: ReviewTier;
  reviewerId?: string; // session id of a fresh/cross reviewer
  verdict: ReviewVerdict;
  checkResults: CheckResult[];
  summary: string; // one-line human read, for retry brief + escalation
  at: number; // epoch ms
}

/** The single pass/fail GATE decision: checks pass AND review pass (Spec 11 §6). */
export interface GateResult {
  pass: boolean;
  checksPass: boolean;
  reviewPass: boolean;
  feedback: ReviewerFeedback; // ALWAYS produced — drives RE_DISPATCH on fail, logged on pass
}

/**
 * The learned-model outcome key+result for a finished worker (Spec 00 §4 learned model;
 * Spec 09 §2.13 worker_outcomes). The capability-table signal STAFF later ranks on.
 * NOTE: the persisted superset is {@link WorkerOutcomeRow}; this is the canonical summary
 * named in the Foundation contract: (harness, model, task_type, passed, retries,
 * drift_events, turns).
 */
export interface GateOutcome {
  harness: Harness;
  model: string;
  taskType: string;
  passed: boolean;
  retries: number;
  driftEvents: number;
  turns: number;
}

// =======================================================================================
// SECTION 5 — Plan / DAG (Spec 04 §2, Spec 06 §4.3)
// =======================================================================================

/** PLAN's proposed worker for a node; STAFF confirms/overrides (Spec 06 §4.3/§4.4). */
export interface SuggestedWorker {
  harness: Harness;
  model: string;
  effort: Effort;
  rationale?: string;
}

/** Per-node resource estimate authored at PLAN (Spec 06 §4.3 envelope). */
export interface NodeEnvelopeEstimate {
  turnTarget: number;
  wallClockSecs: number;
}

/** An Opus self-scheduled first look armed at dispatch (Spec 03 §3; Spec 06 §4.3). */
export interface InitialCheckIn {
  afterTurns?: number;
  afterSecs?: number;
  reason: string; // note to future-self
}

/** One node as authored by PLAN (Spec 06 §4.3 plan node schema). */
export interface PlanNode {
  id: string; // stable node id, e.g. "n1"
  title: string;
  intent: string; // becomes the worker's task brief
  dependsOn: string[]; // node ids that must complete first; [] = root
  scopePaths: string[]; // owned path globs (the worktree write boundary)
  network?: boolean; // node needs network (npm/git push); default false
  criteria: AcceptanceCriteria;
  suggestedWorker: SuggestedWorker;
  reviewTier?: "self" | "fresh";
  envelope: NodeEnvelopeEstimate;
  initialCheckIn?: InitialCheckIn;
}

/** A normalized DAG edge (dependent depends on upstream). */
export interface NodeDep {
  nodeId: string; // the dependent
  dependsOnId: string; // the upstream that must be NODE_DONE
}

/**
 * The plan: single-node for v0 but shaped for a DAG (Foundation contract: nodes[] + deps[]).
 * `nodes` carry their own `dependsOn`; `deps` is the flattened edge list the executor /
 * persistence layer consume (Spec 09 node_deps). Both are kept consistent by PLAN.
 */
export interface Plan {
  summary: string; // the one-line read, refined; first person
  scopeNote?: string; // optional big-swing resource note for the ack
  nodes: PlanNode[];
  deps: NodeDep[];
}

/** Worker assignment from STAFF (Spec 06 §4.4). */
export interface WorkerAssignment {
  nodeId: string;
  harness: Harness;
  model: string;
  effort: Effort;
  overrodePlan?: boolean;
  rationale?: string;
}

/**
 * The runtime DAG structure the executor walks (Spec 04 §2). Nodes are decomposed into
 * SQLite rows for queryability (Spec 09 §2.2); this is the in-memory hydrated view.
 */
export interface Dag {
  nodes: Record<string, NodeRecord>;
  projectBranch: string; // integration target (e.g. beckett/<task>/integration)
}

// =======================================================================================
// SECTION 6 — Task & Node records (Spec 04 §2)
// =======================================================================================

/** The TASK FSM record (Spec 04 §2; persisted to `tasks`, Spec 09 §2.2). */
export interface TaskRecord {
  id: string;
  userId: string; // multiplayer-ready (Spec 00: user_id on every task)
  channelId: string; // Discord origin channel (ambient model, Spec 05)
  originMsgId?: string; // the mention message id (reply threading / dedupe)
  state: TaskState;
  taskType?: string; // classifier label (code|email|research|ops|…) → learned model
  prompt: string; // original request
  assumptions: string[]; // reversible-ambiguity choices, surfaced at DELIVER
  projectBranch?: string; // Dag.projectBranch — integration target
  dag?: Dag; // populated at PLAN (hydrated; persisted decomposed)
  escalation?: Escalation; // populated when state === ESCALATED
  createdAt: number;
  updatedAt: number; // bumped on every persisted transition (durability)
}

/** The NODE FSM record (Spec 04 §2; persisted to `nodes`, Spec 09 §2.3). */
export interface NodeRecord {
  id: string;
  taskId: string;
  userId: string; // denormalized for outcome queries (Spec 09 §2.3)
  title: string;
  deps: string[]; // node ids this node depends on
  scope: FileScope; // owned, non-overlapping paths (Spec 02)
  network: boolean; // envelope.network opt-in (Spec 02 §9)
  worker?: WorkerAssignment; // set at STAFF
  workerId?: string; // live worker handle id (denormalized convenience)
  sessionId?: string; // persisted on spawn → enables --resume
  branch: string; // beckett/<task>/<node> worktree branch
  state: NodeState;
  criteria: AcceptanceCriteria; // written at PLAN (Spec 11)
  attempts: number; // re-dispatch counter; escalate when > MAX_RETRIES
  feedback: ReviewerFeedback[]; // threaded across retries
  lastReviewerId?: string; // resume-vs-fresh decisioning
  criticalPathRank?: number; // scheduler ordering hint
  createdAt: number;
  updatedAt: number;
}

// =======================================================================================
// SECTION 7 — Escalation, decisions, intake (Spec 04 §9, Spec 03 §4, Spec 06 §1)
// =======================================================================================

/** One option offered to jawrooo at an escalation (Spec 04 §2). */
export interface EscalationOption {
  key: string;
  label: string;
  effect: string; // human description of what choosing it does
}

/** The three escalation points all converge here (Spec 04 §9). */
export interface Escalation {
  origin: "CLARIFY" | "SUPERVISE" | "GATE";
  nodeId?: string; // null for CLARIFY-origin
  reason: string; // first-person account
  options: EscalationOption[]; // "tried 3×, options A/B/C"
  postedMessageId?: string; // Discord message awaiting reply
  raisedAt: number;
}

/**
 * The normalized layer of brain judgment Beckett can return at a decision point
 * (Foundation contract: nudge / pause / abort / proceed / escalate / clarify).
 * The SUPERVISE-specific schema with its exact JSON-schema shape is
 * {@link SuperviseDecision}; this union is the broader judgment surface used across the
 * loop (CLARIFY/SUPERVISE/GATE).
 */
export type Decision =
  | { kind: "proceed"; reason?: string }
  | { kind: "nudge"; message: string; reason?: string }
  | { kind: "pause"; reason: string }
  | { kind: "abort"; reason: string }
  | {
      kind: "escalate";
      origin: Escalation["origin"];
      reason: string;
      options: EscalationOption[];
    }
  | { kind: "clarify"; question: string };

/** The intake event normalized from a Discord mention (Spec 01 §3; Spec 05 §2.1). */
export interface IntakeEvent {
  userId: string;
  channelId: string;
  msgId: string;
  text: string;
  ts: number;
}

// =======================================================================================
// SECTION 8 — Supervise: smoke-alarms, check-ins, decisions (Spec 03)
// =======================================================================================

/** Mechanical drift signals — "go look", never a verdict (Spec 03 §2). */
export type SmokeAlarmKind =
  | "no_diff_progress"
  | "over_envelope"
  | "repeated_tool_calls"
  | "scope_violation"
  | "worker_blocked";

/** A fired smoke-alarm (Spec 03 §2). */
export interface SmokeAlarm {
  kind: SmokeAlarmKind;
  workerId: string;
  nodeId: string;
  firedAt: number;
  detail: Record<string, number | string>; // the counter values that tripped it
  dedupeKey: string; // kind + workerId + bucket (Spec 03 §2.3)
}

/** An Opus-scheduled future look (Spec 03 §3.1; persisted to `check_ins`, Spec 09 §2.8). */
export interface CheckIn {
  id: string;
  workerId: string;
  nodeId: string;
  createdByDecisionId: string;
  createdAt: number;
  /** Fires on WHICHEVER trigger comes first (OR semantics). At least one required. */
  trigger: {
    afterTurns?: number;
    afterSecs?: number;
    atTurnAbs?: number;
  };
  turnsAtCreate: number;
  fireAt?: number; // precomputed epoch ms for time triggers
  reason: string; // Opus's note to its future self
  state: "pending" | "fired" | "cancelled" | "superseded";
}

/** Haiku's read of a worker before Opus judges (Spec 03 §4.1). Summarizes, never judges. */
export interface WorkerSummary {
  workerId: string;
  whatItsDoing: string;
  recentActions: string[];
  currentPlan: string;
  signalsOfDrift: string[];
  signalsOfProgress: string[];
  blockedOn: string | null;
}

/**
 * The canonical control-plane decision object emitted by Opus at SUPERVISE (Spec 03 §4.3).
 * Cross-field rules (orchestrator-enforced): nudge⇒message, reschedule⇒nextCheckIn,
 * escalate.needs_input⇒question.
 */
export interface SuperviseDecision {
  action: "continue" | "nudge" | "pause" | "abort" | "reschedule";
  reason: string; // REQUIRED. First-person, owned.
  message?: string; // REQUIRED iff action==='nudge'
  nextCheckIn?: {
    afterTurns?: number;
    afterSecs?: number;
    reason: string;
  };
  escalate?: {
    severity: "fyi" | "needs_input";
    question?: string; // required iff severity==='needs_input'
  };
}

/** A paused worker's captured checkpoint (Spec 03 §5.2). */
export interface Checkpoint {
  workerId: string;
  at: number;
  sessionId: string;
  diff: string; // git diff (captured, not applied)
  diffStat: { files: number; bytes: number };
  lastTranscriptOffset: number;
  counters: WorkerSpend;
}

/** An aborted worker's captured partial state (Spec 03 §5.3). */
export interface AbortState {
  workerId: string;
  reason: string;
  sessionId: string;
  diff: string;
  diffStat: { files: number; bytes: number };
  lastTranscriptOffset: number;
  counters: WorkerSpend;
  killedAt: number;
}

/** A persisted, restart-safe pending steer message (Spec 03 §6; Spec 09 §2.9). */
export interface QueuedNudge {
  nudgeId: string;
  workerId: string;
  nodeId: string;
  text: string;
  source: "opus_decision" | "cli" | "discord" | "ask_plan";
  userId: string;
  enqueuedAt: number;
  status: "queued" | "delivered" | "failed";
  deliveredAt: number | null;
}

// =======================================================================================
// SECTION 9 — Brain outputs (Spec 06)
// =======================================================================================

/** Haiku front-door classification of a mention (Spec 06 §1.3). */
export interface HaikuClassification {
  kind: "task" | "question" | "chatter" | "fyi";
  withinPurview: boolean;
  escalate: boolean;
  escalateRole?: "clarify" | "plan" | "staff" | "gate" | "integrate" | "decide";
  ack: string; // always posted (instant receipt)
  answer?: string; // posted iff handled by Haiku
  memoryQuery?: string;
  memoryWrite?: string;
}

/** Opus CLARIFY output (Spec 06 §4.2). */
export interface ClarifyOutput {
  needsClarify: boolean;
  question?: string; // ⇒ Discord ONE question, task → CLARIFY
  assumptions?: string[]; // ⇒ proceed to PLAN, surface at delivery
  pushback?: string; // ⇒ may route to ESCALATED
}

/** Opus PLAN output: the DAG + criteria + suggested staffing (Spec 06 §4.3). */
export interface PlanOutput {
  summary: string;
  scopeNote?: string;
  nodes: PlanNode[];
}

/** Opus STAFF output (Spec 06 §4.4). */
export interface StaffOutput {
  assignments: WorkerAssignment[];
}

/** Opus GATE verdict (Spec 06 §4.6; reconciled with Spec 11 GateResult at the call site). */
export interface GateVerdict {
  verdict: "pass" | "fail";
  reason: string;
  unmetCriteria?: string[];
  feedback?: string;
  escalate?: boolean;
}

/** Beckett's voice config (Spec 06 §5.1). User-facing voice only; internal prompts plain. */
export interface Persona {
  base: string; // one-paragraph summary injected into Opus layer-1 (thin)
  full: string; // complete voice guide injected into Haiku user-facing calls
  examples: string[]; // few-shot voice samples
}

/** Brain role identifiers (Spec 06 §2.1). */
export type BrainRole =
  | "intake"
  | "chatter"
  | "recall"
  | "clarify"
  | "plan"
  | "staff"
  | "supervise"
  | "gate"
  | "integrate"
  | "summary"
  | "self_halt"
  | "delivery"
  | "escalation";

/** Assembled context handed to a brain call (Spec 06 §3). */
export interface BrainContext {
  persona: string; // thin or full slice per role
  memory?: RecallResult;
  fields: Record<string, unknown>; // role-specific payload
}

// =======================================================================================
// SECTION 10 — Discord interface (Spec 05)
// =======================================================================================

/**
 * A file attached to an inbound Discord message (image / txt / pdf / md / anything).
 * Captured raw from the gateway; the shell downloads it locally so Beckett can `Read` it
 * (the parent loop is multimodal — image/pdf/text all go through the Read tool).
 */
export interface IncomingAttachment {
  id: string; // Discord attachment snowflake
  name: string; // original filename (e.g. "diagram.png")
  url: string; // CDN url to fetch the bytes
  contentType: string | null; // MIME from Discord (may be null for some uploads)
  size: number; // bytes, as reported by Discord
}

/** A captured inbound Discord message (Spec 05 §2.1). */
export interface IncomingMessage {
  messageId: string;
  userId: string;
  /** The speaker's live Discord display name (guild nick → global name → username), if known. */
  authorDisplayName?: string;
  channelId: string;
  guildId: string | null;
  content: string;
  repliedToId: string | null; // the strong correlation key
  mentionsBot: boolean;
  authorIsBot: boolean;
  createdAt: number;
  attachments: IncomingAttachment[]; // files dragged into the message (empty when none)
}

/** What an outstanding question is waiting for (Spec 05 §4.1). */
export type AwaitKind = "clarify" | "handshake" | "self_halt" | "escalation_choice";

/** A parked task awaiting a user reply, restart-rebindable (Spec 05 §4.1). */
export interface AwaitingReply {
  id: string; // ULID
  kind: AwaitKind;
  taskId: string;
  pendingActionId?: string; // for handshake / self_halt → PendingAction.id
  channelId: string;
  userId: string; // WHO we asked (the expected answerer)
  promptMessageId: string; // the bot message id carrying the question
  buttonsCustomIdPrefix?: string;
  createdAt: number;
  expiresAt: number;
}

/** Options for posting a reply (ambient model — always the origin channel, Spec 05 §3). */
export interface ReplyOptions {
  replyToMessageId?: string; // native reply-to for correlation
  files?: string[]; // local file paths to attach (image-only posts OK)
}

// =======================================================================================
// SECTION 11 — Identity & Agency (Spec 07)
// =======================================================================================

/** Gmail auth — OAuth tokens or app-password fallback (Spec 07 §2.1). */
export type GmailAuth =
  | {
      kind: "oauth";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
    }
  | { kind: "app-password"; appPassword: string };

/** Beckett's own identity surface (Spec 07 §2.1). Read-mostly. */
export interface Identity {
  name: string;
  github: {
    account: string;
    pat: string; // NEVER logged
    apiBase: string;
    noreplyEmail: string;
  };
  gmail: {
    account: string;
    auth: GmailAuth;
  };
  discord: {
    botUser: string;
  };
  osUser: string; // "beckett" on loom-desk
}

/** Every action is exactly one class (Spec 07 §2.2). */
export enum ActionClass {
  FREE = "FREE", // reversible/internal → just do it, log it
  HANDSHAKE_GATED = "HANDSHAKE_GATED", // outward but expected → create PendingAction, ask once
  ALWAYS_ASK = "ALWAYS_ASK", // dangerous/irreversible-at-scale → never unattended
}

/** Action types the gate classifies (Spec 07 §3). Open-ended core. */
export type ActionType =
  | "gh.branch.push"
  | "gh.pr.open"
  | "gh.pr.update"
  | "gh.pr.review"
  | "gh.pr.merge"
  | "gh.branch.delete"
  | "gmail.draft"
  | "gmail.send"
  | "fs.write"
  | "memory.write"
  | (string & {});

/** Context for an action-class decision (Spec 07 §3). */
export interface ActionContext {
  ref?: string; // git ref / branch
  repo?: string;
  external?: boolean; // crosses an org boundary?
  [k: string]: unknown;
}

/** The irreversible class of a staged pending action (Spec 09 §2.11). */
export type PendingActionClass =
  | "merge_pr"
  | "send_email"
  | "force_push"
  | "external_post"
  | "other";

/** A staged irreversible action awaiting a handshake answer (Spec 07 §5; Spec 09 §2.11). */
export interface PendingAction {
  id: string;
  taskId: string;
  userId: string;
  actionClass: PendingActionClass;
  payload: Record<string, unknown>; // the staged op: {pr_url}|{draft_id,to}|…
  promptText: string; // the handshake question
  postedMsgId?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  decidedBy?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
}

/** The handshake question + classification for a gated action (Spec 07 §5). */
export interface HandshakeSpec {
  actionClass: PendingActionClass;
  promptText: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
}

/** Result of a gate `perform` (Spec 07 §2.3). */
export type GateActionResult<T> =
  | { status: "done"; value: T }
  | { status: "pending"; pendingAction: PendingAction };

/** GitHub operations Beckett performs (Spec 07 §3.4). Most are FREE; merge is gated. */
export interface GitHubClient {
  pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void>;
  openPR(p: OpenPRParams): Promise<{ number: number; url: string }>;
  updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void>;
  reviewPR(repo: string, n: number, r: ReviewParams): Promise<void>;
  mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void>;
  isGreen(repo: string, n: number): Promise<boolean>;
}

export interface OpenPRParams {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}
export interface UpdatePRParams {
  title?: string;
  body?: string;
  base?: string;
}
export interface ReviewParams {
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
}
export type MergeStrategy = "merge" | "squash" | "rebase";

// =======================================================================================
// SECTION 12 — Memory knowledge graph (Spec 08)
// =======================================================================================

/** Memory node kind — open enum with a known core (Spec 08 §1.3). */
export type NodeType =
  | "person"
  | "project"
  | "preference"
  | "env"
  | "worker-note"
  | "reference"
  | "decision"
  | (string & {});

/** One markdown memory file parsed into a node (Spec 08 §2). */
export interface MemoryNode {
  name: string; // kebab-case, unique == node id
  type: NodeType;
  description: string;
  metadata: Record<string, unknown>;
  body: string; // markdown sans frontmatter & generated Backlinks
  path: string; // absolute file path
  created: string;
  updated: string;
  source: "conversation" | "derived" | "env-scan" | "manual" | "import";
  confidence?: "high" | "medium" | "low";
  stale: boolean;
  phantom: boolean; // referenced but no file yet
  mtime: number;
}

/** A wikilink edge between memory files (Spec 08 §2). */
export interface MemoryEdge {
  from: string;
  to: string;
  field: string; // "body" | "members" | "owners" | ...
  alias?: string;
}

/** One line of the MEMORY.md index (Spec 08 §2.3). */
export interface IndexLine {
  name: string;
  type: NodeType;
  description: string;
}

/** The hydrated memory graph (Spec 08 §2). */
export interface MemoryGraph {
  nodes: Map<string, MemoryNode>;
  out: Map<string, MemoryEdge[]>;
  in: Map<string, MemoryEdge[]>;
  index: IndexLine[];
  builtAt: number;
}

/** A relevance-ranked node from recall (Spec 08 §3). */
export interface ScoredNode {
  node: MemoryNode;
  score: number;
  via: "match" | "link";
  reason: string;
}

/** A recall query against the graph (Spec 08 §3). */
export interface RecallQuery {
  text: string;
  hint?: { names?: string[]; types?: NodeType[] };
  k?: number; // seeds before expansion (default 6)
  hops?: number; // link expansion depth (default 1)
}

/** The bundle recall hands the brain (Spec 08 §3). */
export interface RecallResult {
  index: IndexLine[];
  hits: ScoredNode[];
  expanded: ScoredNode[];
  phantoms: string[];
  notes: string[];
}

/** A structured memory write intent (Spec 08 §4). Opus-gated, not a reflex. */
export interface RememberIntent {
  op: "create" | "update" | "append" | "link";
  name: string;
  type?: NodeType; // required for create
  description?: string;
  metadata?: Record<string, unknown>;
  body?: string;
  links?: { to: string; field: string }[];
  source: MemoryNode["source"];
  reason: string; // logged to the event log
}

// =======================================================================================
// SECTION 13 — Persistence: event log + row types (Spec 09)
// =======================================================================================

/** Dotted event taxonomy (Spec 09 §3.3). */
export type EventType =
  // daemon
  | "daemon.start"
  | "daemon.ready"
  | "daemon.stop"
  | "daemon.recover"
  // task
  | "task.created"
  | "task.state_changed"
  | "task.clarify_asked"
  | "task.clarify_answered"
  | "task.delivered"
  // plan
  | "plan.built"
  | "plan.staffed"
  // node
  | "node.created"
  | "node.state_changed"
  | "node.dep_done"
  // worker
  | "worker.spawned"
  | "worker.session_captured"
  | "worker.turn_completed"
  | "worker.tool_call"
  | "worker.file_change"
  | "worker.finished"
  // supervise
  | "supervise.smoke_alarm"
  | "supervise.checkin_scheduled"
  | "supervise.checkin_fired"
  | "supervise.look"
  | "supervise.decision"
  | "supervise.scope_violation"
  // nudge
  | "nudge.enqueued"
  | "nudge.delivered"
  | "nudge.failed"
  // integrate
  | "integrate.merge_clean"
  | "integrate.merge_conflict"
  | "integrate.resolved"
  | "integrate.failed"
  // gate
  | "gate.review_complete"
  | "gate.pass"
  | "gate.fail"
  // escalation
  | "escalation.raised"
  | "escalation.resolved"
  // handshake
  | "handshake.posted"
  | "handshake.approved"
  | "handshake.rejected"
  | "handshake.executed"
  | "handshake.expired"
  // identity
  | "identity.branch_pushed"
  | "identity.pr_opened"
  | "identity.email_drafted"
  | "identity.email_sent"
  // rate_limit
  | "rate_limit.hit"
  | "rate_limit.failover"
  | "rate_limit.backoff"
  // memory
  | "memory.indexed"
  | "memory.note_written"
  // forward-compat
  | (string & {});

/** One immutable JSONL audit record (Spec 09 §3.2). */
export interface EventRecord {
  id: string; // ev_… (ULID — monotonic, sortable)
  seq: number; // per-daemon-run monotonic counter
  ts: number; // epoch ms (UTC)
  type: EventType;
  task_id: string | null;
  node_id: string | null;
  worker_id: string | null;
  user_id: string | null;
  payload: Record<string, unknown>;
}

/** A partial event to append; the writer fills id/seq/ts and null correlation keys. */
export type EventInput = Partial<Omit<EventRecord, "type">> & { type: EventType };

// ── SQLite row types (1:1 with the DDL; enums are the Spec 02/04 unions). Spec 09 §8 ──

export interface UserRow {
  id: string;
  discord_id: string | null;
  display_name: string;
  is_owner: 0 | 1;
  chattiness: "sparse" | "normal";
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  channel_id: string;
  origin_msg_id: string | null;
  state: TaskState;
  task_type: string | null;
  prompt: string;
  assumptions_json: string;
  project_branch: string | null;
  created_at: number;
  updated_at: number;
}

export interface NodeRow {
  id: string;
  task_id: string;
  user_id: string;
  title: string;
  state: NodeState;
  scope_json: string;
  branch: string;
  network: 0 | 1;
  attempts: number;
  last_reviewer_id: string | null;
  feedback_json: string;
  critical_path_rank: number | null;
  created_at: number;
  updated_at: number;
}

export interface NodeDepRow {
  task_id: string;
  node_id: string;
  depends_on_id: string;
}

export interface WorkerRow {
  id: string;
  node_id: string;
  task_id: string;
  user_id: string;
  harness: Harness;
  driver: DriverKind;
  model: string;
  effort: Effort;
  session_id: string | null;
  workspace: string;
  branch: string;
  is_resume: 0 | 1;
  state: WorkerState;
  turns: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  diff_added: number;
  diff_removed: number;
  diff_files: number;
  usd_estimate: number | null;
  scope_violations: number;
  stream_offset_bytes: number;
  pid: number | null;
  spawned_at: number;
  last_activity_ts: number;
  ended_at: number | null;
}

export interface CriteriaRow {
  id: string;
  node_id: string;
  nl_criteria: string;
  checks_json: string;
  interface_contract: string | null;
  done_schema_path: string | null;
  created_at: number;
}

export interface GateOutcomeRow {
  id: string;
  node_id: string;
  worker_id: string | null;
  attempt: number;
  checks_passed: 0 | 1;
  review_passed: 0 | 1;
  review_tier: ReviewTier;
  reviewer_id: string | null;
  verdict: "pass" | "fail";
  feedback_json: string | null;
  created_at: number;
}

export interface CheckInRow {
  id: string;
  worker_id: string;
  node_id: string;
  created_by_decision_id: string | null;
  after_turns: number | null;
  after_secs: number | null;
  at_turn_abs: number | null;
  turns_at_create: number;
  fire_at: number | null;
  reason: string;
  state: "pending" | "fired" | "cancelled" | "superseded";
  created_at: number;
}

export interface NudgeRow {
  id: string;
  worker_id: string;
  node_id: string;
  user_id: string;
  text: string;
  source: "opus_decision" | "cli" | "discord" | "ask_plan";
  status: "queued" | "delivered" | "failed";
  fail_reason: string | null;
  enqueued_at: number;
  delivered_at: number | null;
}

export interface EscalationRow {
  id: string;
  task_id: string;
  node_id: string | null;
  origin: "CLARIFY" | "SUPERVISE" | "GATE";
  reason: string;
  options_json: string;
  posted_msg_id: string | null;
  state: "open" | "resolved";
  resolution: string | null;
  raised_at: number;
  resolved_at: number | null;
}

export interface PendingActionRow {
  id: string;
  task_id: string;
  user_id: string;
  action_class: PendingActionClass;
  payload_json: string;
  prompt_text: string;
  posted_msg_id: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number | null;
}

export interface AwaitingReplyRow {
  id: string;
  kind: AwaitKind;
  task_id: string;
  pending_action_id: string | null;
  channel_id: string;
  user_id: string;
  prompt_message_id: string;
  buttons_custom_id_prefix: string | null;
  created_at: number;
  expires_at: number;
}

export interface MemoryIndexRow {
  id: string;
  path: string;
  title: string;
  kind: string;
  tags_json: string;
  summary: string | null;
  content_hash: string;
  mtime: number;
  updated_at: number;
}

export interface MemoryLinkRow {
  src_id: string;
  dst_path: string;
}

/** The learned-model feed row, one per finished worker (Spec 09 §2.13). */
export interface WorkerOutcomeRow {
  id: string;
  user_id: string | null;
  task_id: string | null;
  node_id: string | null;
  worker_id: string | null;
  harness: Harness;
  model: string;
  task_type: string;
  effort: Effort;
  passed: 0 | 1;
  retries: number;
  drift_events: number;
  scope_violations: number;
  turns: number;
  tool_calls: number;
  wall_clock_s: number;
  diff_added: number;
  diff_removed: number;
  files_changed: number;
  tokens_in: number;
  tokens_out: number;
  aborted: 0 | 1;
  created_at: number;
}

/** A ranked (harness, model) row from the STAFF capability query (Spec 09 §5.2). */
export interface RankedWorker {
  harness: Harness;
  model: string;
  samples: number;
  pass_rate: number;
  avg_retries: number;
  avg_drift: number;
  avg_wall_s: number;
  avg_turns: number;
  total_scope_viol: number;
}

/** A migration file (Spec 09 §6). */
export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string; // sha256 of `sql`
}

// =======================================================================================
// SECTION 14 — Config & Paths (Spec 01 §4)
// =======================================================================================

/** Resolved filesystem paths (Spec 01 §4 [paths]; built from Config in paths.ts). */
export interface Paths {
  home: string;
  beckettDir: string;
  projects: string;
  db: string;
  eventsDir: string;
  logsDir: string;
  memoryDir: string;
  socket: string;
  configFile: string; // <beckettDir>/config.toml
  envFile: string; // <beckettDir>/.env
  personaFile: string; // <beckettDir>/persona.md
  attachmentsDir: string; // <beckettDir>/attachments — downloaded Discord attachments
  accessFile: string; // <beckettDir>/access.txt — Discord user whitelist (invite-only beta)
  imagesDir: string; // <beckettDir>/images — generated images (beckett image)
  identitiesFile: string; // <beckettDir>/identities.json — per-user known/preferred names (OPS-42)
}

/** The full validated config (Spec 01 §4). Every key has a default so an empty config boots. */
export interface Config {
  concurrency: {
    max_workers: number;
    queue_max: number;
    per_task_soft: number;
  };
  retry: {
    max_redispatch: number;
    backoff_base_ms: number;
    backoff_max_ms: number;
  };
  supervise: {
    drift_no_progress_turns: number;
    repeated_tool_calls_n: number;
    overrun_factor: number;
    checkin_default_s: number;
    /** Generous backstop wall-clock cap (s) the per-worker watchdog enforces — a runaway safety
     *  net, not a work limit (drivers/proc.ts#hardCapSeconds). Floor 1800, default 3600. */
    worker_hard_cap_s: number;
    tail_mode: "stream" | "disk" | "stream+disk";
  };
  models: {
    front_door: string;
    judgment: string;
    reviewer: string;
  };
  harness: {
    /** Substitution order when a cast harness is unhealthy (issue #17 fallback chain). */
    fallback_order: Harness[];
    // No `enabled` for claude: it is the backbone harness and the fallback for every disabled
    // cast — a switch that can't honestly be turned off is config theater (issue #31).
    claude: {
      bin: string;
      default_model: string;
      default_effort: Effort;
      permission_mode: string;
      extra_flags: string[];
    };
    codex: {
      enabled: boolean;
      bin: string;
      default_model: string;
      default_effort: Effort;
      sandbox_mode: string;
      approval_policy: string;
      network_default: boolean;
    };
    pi: {
      enabled: boolean;
      bin: string;
      /** Provider id (pi `--provider`). "openai-codex" = ChatGPT/Codex OAuth backend. */
      default_provider: string;
      /** Model id (pi `--model`). e.g. "gpt-5.5". */
      default_model: string;
      /** Reasoning depth (pi `--thinking`). */
      thinking: Effort;
    };
  };
  paths: {
    home: string;
    beckett_dir: string;
    projects: string;
    db: string;
    events_dir: string;
    logs_dir: string;
    memory_dir: string;
    socket: string;
  };
  discord: {
    reply_channel_mode: "same";
    escalate_after_s: number;
    chattiness: "sparse" | "normal";
  };
  identity: {
    github_user: string;
    gmail_address: string;
    poll_inbox_s: number;
    auto_merge: boolean;
  };
  features: {
    codex_failover: boolean;
    fresh_reviewer: boolean;
    learned_staffing: boolean;
    multiplayer: boolean;
    email_agency: boolean;
    app_server_codex: boolean;
  };
  /** Retention/event tunables (Spec 09 §3.5/§9). Defaults bias toward keeping history. */
  events: {
    max_file_mb: number;
    retain_days: number;
    archive_retain_days: number;
  };
  retention: {
    task_days: number;
    db_backups: number;
    outcomes_max_rows: number; // 0 = unbounded
  };
  /** v3 — Plane ticket-queue config (Spec v3). Secret PLANE_API_TOKEN lives in env, not here. */
  plane: {
    base_url: string;
    workspace_slug: string;
    project_slug: string;
    poll_secs: number;
    /** Each Beckett TicketState → its Plane workflow state NAME (client resolves name→UUID). */
    state_map: {
      backlog: string;
      todo: string;
      in_progress: string;
      in_review: string;
      done: string;
      cancelled: string;
    };
  };
  /** v3 — the Concierge agent that owns Discord and files tickets. */
  concierge: {
    model: string;
    /** Summed-input-token ceiling at which the Concierge session auto-compacts (rotates). */
    rotate_at_tokens: number;
  };
}

// =======================================================================================
// SECTION 15 — IPC envelope & command set (Spec 01 §7, Spec 10 §8)
// =======================================================================================

/** The CLI→daemon command set (Spec 10 §8.4). */
export type IpcCmd =
  | "nudge"
  | "pause"
  | "resume"
  | "abort"
  | "ask_plan"
  | "reload"
  | "status"
  | "shutdown";

/** The IPC request envelope (Spec 01 §7; Spec 10 §8.2). */
export interface IpcRequest {
  proto: 1;
  request_id: string; // uuid — echoed in the response; correlates in the audit log
  cmd: IpcCmd;
  args: Record<string, unknown>;
  user_id: string; // attribution (not authentication in v1)
}

/** The IPC response envelope (Spec 10 §8.3). */
export interface IpcResponse {
  proto: 1;
  request_id: string;
  ok: boolean;
  data?: unknown; // NudgeReceipt | Checkpoint | AbortState[] | StatusReport | …
  error?: {
    kind: string; // "not_found" | "illegal_state" | "proto_mismatch" | "internal" | …
    message: string;
    exit: number; // the exit code the CLI should use
  };
}

/** Daemon introspection reply for `status` (Spec 10 §7/§8.4). */
export interface StatusReport {
  pid: number;
  uptimeMs: number;
  bunVersion: string;
  liveWorkers: number;
  queuedNodes: number;
  activeTasks: number;
  discord: {
    connected: boolean;
    lastEventAgeMs: number | null;
  };
  recovery: {
    recovering: boolean;
    resumedWorkers: number;
  };
}

// =======================================================================================
// SECTION 16 — Module interfaces (dependency inversion; daemon wires concrete impls)
// =======================================================================================

/**
 * The two-implementation spawn/steer/abort surface (Spec 02 §3). The control plane and DAG
 * executor never touch a CLI directly — they hold a HarnessDriver and call these methods.
 */
export interface HarnessDriver {
  readonly kind: DriverKind;
  /** Create worktree (if needed), launch, return once sessionId is known. spawning→running. */
  spawn(spec: SpawnSpec): Promise<SpawnResult>;
  /** Soft steer. claude: stdin user line (next turn boundary). codex: queued for resume. */
  sendNudge(msg: string): Promise<NudgeReceipt>;
  /** Checkpoint (claude: quiesce; codex: stop auto-resume). */
  pause(): Promise<void>;
  /** Re-attach a paused/crashed worker via --resume / exec resume (same cwd). */
  resume(): Promise<void>;
  /** Hard stop: SIGTERM→SIGKILL the group, retain sessionId. */
  abort(reason: string): Promise<void>;
  /** Subscribe to the normalized event stream. Returns an unsubscribe fn. */
  onEvent(cb: (e: WorkerEvent) => void): () => void;
  /** Snapshot of derived counters (cheap; reads accumulators + git diff --stat). */
  getTelemetry(): WorkerSpend;
}

/** Inputs to spawn one harness process (Spec 02 §3). */
export interface SpawnSpec {
  workerId: string;
  prompt: string; // the node task (initial user turn)
  systemAppend: string; // criteria + scope + worker-persona (businesslike)
  workspace: string; // worktree path
  scope: FileScope;
  envelope: ResourceEnvelope;
  model: string;
  sessionId?: string; // optional caller-minted UUID (claude --session-id); else captured
  /**
   * Crash recovery (issue #20): when set, the driver LAUNCHES IN RESUME MODE against this
   * persisted session/thread id instead of starting fresh — `prompt` becomes the next user turn
   * of the restored transcript (claude `--resume`, pi `--session`, `codex exec resume`).
   * Takes precedence over {@link sessionId}.
   */
  resumeSessionId?: string;
  mcpConfigPath?: string;
  doneSchemaPath: string; // JSON-schema file for the structured done-signal
  // v3.1: external settings file (claude --settings) carrying the scope-guard hook. Used when the
  // worker runs IN the project checkout (no worktree) so we never clobber the project's own
  // .claude/settings.json — claude layers --settings on top rather than replacing it.
  settingsPath?: string;
}

export interface SpawnResult {
  sessionId: string;
  pid: number;
}

/** Request to allocate + dispatch a worker for a node (Spec 01 component 6; Spec 04 N4). */
export interface DispatchRequest {
  node: NodeRecord;
  assignment: WorkerAssignment;
  baseRef: string; // origin/main or the integration branch
  isResume: boolean;
  resumeSessionId?: string;
}

/**
 * Creates/tears down workers: worktree allocation, envelope, driver selection, cap
 * enforcement, live-handle tracking, reaping (Spec 01 component 6; Spec 02).
 */
export interface WorkerManager {
  dispatch(req: DispatchRequest): Promise<Worker>;
  get(workerId: string): Worker | undefined;
  live(): Worker[];
  liveCount(): number;
  abort(workerId: string, reason: string): Promise<AbortState>;
  pause(workerId: string): Promise<Checkpoint>;
  resume(workerId: string): Promise<void>;
  /** Tear down a terminal worker's worktree after its diff is captured/merged. */
  reap(workerId: string): Promise<void>;
}

/**
 * Read-only observation + mechanical smoke-alarms; hands signals to the Brain (Spec 03).
 * Never intervenes itself.
 */
export interface Supervisor {
  /** Ingest one normalized event for a worker (read-only tail). */
  ingest(worker: Worker, event: WorkerEvent): void;
  /** Arm a check-in scheduled by Opus. */
  scheduleCheckIn(checkIn: CheckIn): void;
  /** Re-arm alarms/counters for a resumed worker from a transcript offset (recovery). */
  rearm(worker: Worker, streamOffsetBytes: number): void;
  /** Subscribe to fired alarms (the orchestrator pulls Opus in to look). */
  onAlarm(cb: (alarm: SmokeAlarm, worker: Worker) => void): () => void;
}

/**
 * The LLM-backed judgment surface (Spec 06). All calls shell out to `claude -p
 * --output-format json --model <id>` (subscription auth only; structured calls add
 * `--json-schema`). Stateless — continuity comes from SQLite + Memory.
 */
export interface Brain {
  intake(evt: IntakeEvent): Promise<HaikuClassification>;
  clarify(task: TaskRecord, ctx: BrainContext): Promise<ClarifyOutput>;
  plan(task: TaskRecord, ctx: BrainContext): Promise<PlanOutput>;
  staff(task: TaskRecord, plan: PlanOutput, ctx: BrainContext): Promise<StaffOutput>;
  /** Cheap Haiku compression of a worker's transcript before the Opus drift-read. */
  summarizeWorker(worker: Worker, ctx: BrainContext): Promise<WorkerSummary>;
  /** Opus drift-read at SUPERVISE (and self-halt). */
  superviseRead(
    worker: Worker,
    summary: WorkerSummary,
    alarms: SmokeAlarm[],
    ctx: BrainContext,
  ): Promise<SuperviseDecision>;
  /** Opus GATE verdict against the NL criteria + check results. */
  gate(
    node: NodeRecord,
    checks: ChecksOutcome,
    diff: string,
    ctx: BrainContext,
  ): Promise<ReviewVerdict>;
  /** Haiku delivery voice — dresses the gated result in persona. */
  deliver(task: TaskRecord, ctx: BrainContext): Promise<string>;
  /** Haiku escalation voice — dresses Opus's reason/question for Discord. */
  escalationVoice(escalation: Escalation, ctx: BrainContext): Promise<string>;
}

/** Holds the discord.js connection; ambient in→same-channel out (Spec 05). */
export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Post to a channel; returns the bot message id (for reply correlation). */
  post(channelId: string, content: string, opts?: ReplyOptions): Promise<string>;
  /**
   * Open a public thread hanging off an existing message and return the thread id. The thread id
   * is itself a sendable channel id, so {@link post} delivers into the thread. Used by the progress
   * feed (`src/discord/progress.ts`): the main channel stays sparse (the ack), while the thread
   * carries the granular per-worker play-by-play. Throws if the anchor message can't be resolved or
   * the client is offline (the caller keeps buffering and retries on a later event).
   */
  startThread(channelId: string, anchorMessageId: string, name: string): Promise<string>;
  /** Trigger the typing indicator in a channel (~10s; re-call to keep it alive). */
  sendTyping(channelId: string): Promise<void>;
  /** Register the inbound message handler (intake + awaiting-reply resolution). */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void;
  isConnected(): boolean;
  lastEventAgeMs(): number | null;
}

/**
 * Owns a task's lifecycle: walks the FSMs, resolves the DAG ready-set, drives
 * INTEGRATE/REVIEW/GATE, handles retry≤3 and escalation (Spec 01 component 4; Spec 04).
 */
export interface Orchestrator {
  /** Accept a fresh intake event; returns the created task id. */
  submit(evt: IntakeEvent): Promise<string>;
  /** Resolve an inbound reply to a parked task (clarify/handshake/escalation answer). */
  handleReply(m: IncomingMessage): Promise<boolean>;
  /** Re-drive the DAG scheduler for a task (pure over persisted state). */
  tick(taskId: string): void;
  /** Restart recovery hook (Spec 04 §10; Spec 09 §4). */
  recover(): Promise<void>;
  // IPC-backed control (Spec 10 §8.4):
  nudge(workerId: string, text: string, userId: string, source: QueuedNudge["source"]): Promise<NudgeReceipt>;
  pause(workerId: string): Promise<Checkpoint>;
  resumeWorker(workerId: string): Promise<void>;
  abort(workerId: string, reason: string): Promise<AbortState>;
  askPlan(workerId: string, wait: boolean): Promise<NudgeReceipt>;
}

/**
 * The action-class gate + git/PR helpers (Spec 07). Reversible work is FREE; outbound/
 * irreversible goes through a handshake.
 */
export interface Agency {
  classify(type: ActionType, ctx: ActionContext): ActionClass;
  perform<T>(
    type: ActionType,
    ctx: ActionContext,
    execute: () => Promise<T>,
    handshake?: HandshakeSpec,
  ): Promise<GateActionResult<T>>;
  readonly github: GitHubClient;
}

/** Recall + write over the markdown knowledge graph (Spec 08). */
export interface Memory {
  recall(q: RecallQuery): Promise<RecallResult>;
  remember(intent: RememberIntent): Promise<MemoryNode>;
  /** Rebuild the SQL mirror from the md tree (Spec 09 §2.12). */
  reindex(): Promise<void>;
}

/**
 * The canonical persistence repository over bun:sqlite + the JSONL audit log (Spec 09).
 * Single writer (the daemon); the CLI reads the DB read-only directly. Every state change
 * writes the row AND an EventRecord in one transaction (Spec 09 §3.4).
 */
export interface Store {
  /** Open, set PRAGMAs, run migrations to head (Spec 09 §1.1/§6). */
  init(): void;
  close(): void;
  transaction<T>(fn: () => T): T;

  // ── append-only audit (also called inside the writers below) ──
  appendEvent(e: EventInput): EventRecord;

  // ── users ──
  upsertUser(u: UserRow): void;
  getUserByDiscordId(discordId: string): UserRow | null;
  getOwner(): UserRow | null;

  // ── tasks ──
  createTask(t: TaskRow): void;
  getTask(id: string): TaskRow | null;
  setTaskState(id: string, state: TaskState): void;
  updateTask(t: Partial<TaskRow> & { id: string }): void;
  listActiveTasks(): TaskRow[];
  tasksWhereStateNotIn(terminal: ReadonlySet<TaskState>): TaskRow[];

  // ── nodes + deps ──
  createNode(n: NodeRow): void;
  getNode(id: string): NodeRow | null;
  updateNodeState(id: string, state: NodeState): void;
  updateNode(n: Partial<NodeRow> & { id: string }): void;
  listNodesForTask(taskId: string): NodeRow[];
  addNodeDep(dep: NodeDepRow): void;
  depsOf(nodeId: string): NodeDepRow[];
  dependentsOf(nodeId: string): NodeDepRow[];

  // ── criteria ──
  createCriteria(c: CriteriaRow): void;
  getCriteriaForNode(nodeId: string): CriteriaRow | null;

  // ── workers (durability-critical) ──
  recordWorker(w: WorkerRow): void;
  getWorker(id: string): WorkerRow | null;
  /** Persist session_id + pid the instant they are known, set state='running' (Spec 09 §4.1). */
  persistSessionId(workerId: string, sessionId: string, pid: number): void;
  setWorkerState(id: string, state: WorkerState): void;
  updateWorkerTelemetry(id: string, spend: WorkerSpend, lastActivityTs: number, streamOffsetBytes: number): void;
  liveWorkerForNode(nodeId: string): WorkerRow | null;
  nonTerminalWorkers(): WorkerRow[];

  // ── nudges (persist-first) ──
  enqueueNudge(n: NudgeRow): void;
  markNudgeDelivered(id: string): void;
  markNudgeFailed(id: string, reason: string): void;
  queuedNudges(workerId: string): NudgeRow[];
  allQueuedNudges(): NudgeRow[];

  // ── check-ins ──
  insertCheckIn(c: CheckInRow): void;
  setCheckInState(id: string, state: CheckInRow["state"]): void;
  pendingCheckIns(workerId?: string): CheckInRow[];

  // ── escalations ──
  raiseEscalation(e: EscalationRow): void;
  resolveEscalation(id: string, resolution: string): void;
  openEscalations(): EscalationRow[];

  // ── pending actions (handshakes) ──
  createPendingAction(p: PendingActionRow): void;
  setPendingActionStatus(id: string, status: PendingActionRow["status"], decidedBy?: string): void;
  pendingActions(): PendingActionRow[];

  // ── awaiting replies ──
  createAwaitingReply(a: AwaitingReplyRow): void;
  deleteAwaitingReply(id: string): void;
  openAwaitingReplies(): AwaitingReplyRow[];

  // ── gate + learned model ──
  logGateOutcome(g: GateOutcomeRow): void;
  logOutcome(o: WorkerOutcomeRow): void;
  rankWorkers(taskType: string, since: number, minSamples: number): RankedWorker[];
  countLooks(workerId: string): number;

  // ── memory mirror ──
  upsertMemoryIndex(rows: MemoryIndexRow[], links: MemoryLinkRow[]): void;
  searchMemory(kind?: string): MemoryIndexRow[];
}

/** The daemon-side unix-socket listener (Spec 01 §7; Spec 10 §8). */
export interface IpcServer {
  start(handler: (req: IpcRequest) => Promise<IpcResponse>): Promise<void>;
  stop(): Promise<void>;
}

/** The CLI-side unix-socket client (Spec 10 §8). */
export interface IpcClient {
  send(req: IpcRequest): Promise<IpcResponse>;
}

/** Minimal structured logger surface (src/log.ts). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A child logger that tags every line with a component name. */
  child(component: string): Logger;
}
