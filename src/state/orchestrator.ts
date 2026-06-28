/**
 * Beckett — the Orchestrator + Task/Node state machine (`src/state/orchestrator.ts`)
 * =======================================================================================
 * Component 4 (Spec 01 §1; Spec 04): owns a task's whole lifecycle. It drives the two-level
 * FSM — the single-threaded TASK FSM (INTAKE→CLARIFY?→PLAN→STAFF→EXECUTING→DELIVERING) that
 * wraps a DAG of NODE FSMs (BLOCKED→READY→DISPATCHED→SUPERVISING⇄NUDGING/PAUSED→INTEGRATING
 * →REVIEWING→GATING→NODE_DONE/NODE_FAILED).
 *
 * It is the SPINE that wires the modules together: it pulls {@link Brain} for every model
 * judgment, asks {@link WorkerManager} to spawn/steer/abort workers in isolated worktrees,
 * subscribes to the {@link Supervisor}'s smoke-alarms + check-ins (pulling Opus in to look),
 * runs INTEGRATE (real `git merge`) + the deterministic checks + the Opus GATE, applies the
 * retry≤3 loop, raises the three escalation points, runs the {@link Agency} delivery handshake,
 * and posts back through the {@link DiscordGateway}.
 *
 * v0 scope (Spec 12 §3): the single-node path runs end-to-end for real. The DAG executor
 * ({@link tick}) resolves a ready-set generically — it is correct for N nodes, it just always
 * sees a ready-set of size ≤1 in v0. Multi-node parallelism, the Opus integration worker for
 * conflicts, the fresh adversarial reviewer, and codex failover are seams left for v0+.
 *
 * Durability invariant (Spec 04 §4 / §10): every state transition writes a Store row + a JSONL
 * event BEFORE the side effect, so a SIGKILL mid-turn is recoverable. {@link recover} re-drives
 * from persisted state on boot.
 */

import type {
  Orchestrator,
  Store,
  Brain,
  WorkerManager,
  Supervisor,
  DiscordGateway,
  Agency,
  Memory,
  Config,
  Paths,
  Logger,
  IntakeEvent,
  IncomingMessage,
  TaskRow,
  NodeRow,
  NodeRecord,
  NodeDepRow,
  Worker,
  WorkerEvent,
  WorkerControl,
  WorkerRow,
  WorkerAssignment,
  WorkerSpend,
  WorkerOutcomeRow,
  SmokeAlarm,
  CheckIn,
  CheckInRow,
  SuperviseDecision,
  WorkerSummary,
  BrainContext,
  RecallResult,
  NudgeReceipt,
  Checkpoint,
  AbortState,
  QueuedNudge,
  PlanOutput,
  Plan,
  AcceptanceCriteria,
  FileScope,
  Escalation,
  ReviewerFeedback,
  ReviewTier,
  CriteriaRow,
  NodeDep,
  PendingActionRow,
  AwaitingReplyRow,
  UserRow,
} from "../types.ts";
import { TaskState, NodeState, NODE_TERMINAL, MAX_RETRIES } from "../types.ts";
import {
  taskId as mintTaskId,
  nodeId as mintNodeId,
  criteriaId as mintCriteriaId,
  nudgeId as mintNudgeId,
  escalationId as mintEscalationId,
  checkInId as mintCheckInId,
  outcomeId as mintOutcomeId,
  ulidId,
} from "../ids.ts";
import { log as rootLog } from "../log.ts";
import { commitWorktree, mergeBranch, readDiff, type CommitAuthor } from "../worker/worktree.ts";
import {
  runChecks,
  buildCheckEnv,
  runGate,
  gateOutcomeRow,
  chooseTier,
  criticalitySignals,
  redispatchBrief,
  buildGateEscalation,
  gateRetriesExhausted,
  validatePlanOutput,
} from "../brain/index.ts";
import { mergeHandshakeSpec, PR_PENDING_CREDS_NOTE } from "../agency/index.ts";

// =======================================================================================
// Construction
// =======================================================================================

/** Concrete Supervisor with the (non-frozen) check-in subscription the daemon wires. */
export interface SupervisorWithCheckIns extends Supervisor {
  onCheckInFired?(cb: (checkIn: CheckIn, worker: Worker) => void): () => void;
}

/** Concrete Agency surface with the handshake-execute hook the orchestrator drives. */
export interface AgencyWithExecute extends Agency {
  readonly githubAvailable?: boolean;
  executeApproved?(pa: PendingActionRow): Promise<unknown>;
}

export interface OrchestratorDeps {
  store: Store;
  brain: Brain;
  workerManager: WorkerManager;
  supervisor: SupervisorWithCheckIns;
  discord: DiscordGateway;
  agency: AgencyWithExecute;
  memory: Memory;
  config: Config;
  paths: Paths;
  /** Resolve the absolute git repo root for a task (v0 single project — see report). */
  repoRoot: (task: TaskRow) => string;
  /** Commit/merge author identity (Beckett). */
  commitAuthor?: CommitAuthor;
  logger?: Logger;
  now?: () => number;
}

/** Everything PLAN authored that has no column on NodeRow (kept in-memory for the run). */
interface NodeExtras {
  assignment: WorkerAssignment;
  initialCheckIn?: { afterTurns?: number; afterSecs?: number; reason: string };
}

// =======================================================================================
// Orchestrator
// =======================================================================================

export class BeckettOrchestrator implements Orchestrator {
  private readonly d: OrchestratorDeps;
  private readonly log: Logger;
  private readonly now: () => number;

  /** PLAN output that has no NodeRow column (assignment + initial check-in), keyed by nodeId. */
  private readonly nodeExtras = new Map<string, NodeExtras>();
  /** Per-worker drift-look guard (no concurrent Opus reads for one worker). */
  private readonly lookInFlight = new Set<string>();
  /** Per-worker count of looks (for the learned-model drift_events column). */
  private readonly driftEvents = new Map<string, number>();
  /** Workers whose `finished` event has already been processed (idempotency). */
  private readonly finishedWorkers = new Set<string>();
  /** Tasks currently being delivered (avoid double-fire). */
  private readonly delivering = new Set<string>();
  /** Workers re-attached via --resume during the last recover() (Spec 10 StatusReport.recovery). */
  private resumedWorkerCount = 0;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
    this.log = (deps.logger ?? rootLog).child("orchestrator");
    this.now = deps.now ?? Date.now;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // INTAKE — accept a fresh mention (Spec 04 T1–T11)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Accept a fresh intake event; returns the created task id (Spec 04 T1). */
  async submit(evt: IntakeEvent): Promise<string> {
    this.ensureUser(evt.userId);
    const id = mintTaskId();
    const now = this.now();
    const row: TaskRow = {
      id,
      user_id: evt.userId,
      channel_id: evt.channelId,
      origin_msg_id: evt.msgId,
      state: TaskState.INTAKE,
      task_type: null,
      prompt: evt.text,
      assumptions_json: "[]",
      project_branch: null,
      created_at: now,
      updated_at: now,
    };
    this.d.store.createTask(row);
    this.log.info("task created", { taskId: id, userId: evt.userId, channelId: evt.channelId });
    // The heavy intake→plan→execute pipeline runs in the background so the gateway stays responsive.
    void this.runIntake(row, evt).catch((err) =>
      this.failTask(id, `intake pipeline crashed: ${(err as Error).message}`),
    );
    return id;
  }

  /** INTAKE classification (Haiku) → ack → CLARIFY?/PLAN branch (Spec 04 T2/T3/T4). */
  private async runIntake(task: TaskRow, evt: IntakeEvent): Promise<void> {
    const cls = await this.d.brain.intake(evt);

    this.d.store.updateTask({ id: task.id, task_type: cls.kind === "task" ? "code" : cls.kind });

    if (cls.kind !== "task") {
      // chatter / question / fyi → a SINGLE conversational reply, no DAG (Spec 04 T4; Spec 00
      // sparseness law). A greeting must NOT get both an ack and an answer — prefer the full
      // answer, fall back to the ack. The ack-then-deliver two-beat is for tasks only.
      const reply = cls.answer?.trim() || cls.ack?.trim();
      if (reply) await this.post(task.channel_id, reply, evt.msgId);
      this.d.store.setTaskState(task.id, TaskState.DELIVERED);
      return;
    }

    // It's a task → post the instant honest one-line ack now (the work itself delivers later,
    // Spec 05 §2.2), then CLARIFY decisioning.
    if (cls.ack?.trim()) await this.post(task.channel_id, cls.ack, evt.msgId);
    this.d.store.setTaskState(task.id, TaskState.CLARIFY);
    const ctx = await this.ctx(task.prompt);
    const clarify = await this.d.brain.clarify(this.toTaskRecordLite(this.d.store.getTask(task.id)!), ctx);

    if (clarify.needsClarify && clarify.question?.trim()) {
      const msgId = await this.post(task.channel_id, clarify.question, evt.msgId);
      this.d.store.appendEvent({ type: "task.clarify_asked", task_id: task.id, payload: { question: clarify.question } });
      this.armAwaitingReply(task, "clarify", msgId);
      return; // park in CLARIFY until the answer arrives (handleReply)
    }

    // Proceed-on-reversible: record assumptions, go straight to PLAN (Spec 04 T2).
    if (clarify.assumptions?.length) {
      this.d.store.updateTask({ id: task.id, assumptions_json: JSON.stringify(clarify.assumptions) });
    }
    await this.planAndExecute(this.d.store.getTask(task.id)!);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // PLAN + STAFF + DAG build (Spec 04 T9–T11)
  // ─────────────────────────────────────────────────────────────────────────────────────

  private async planAndExecute(task: TaskRow): Promise<void> {
    this.d.store.setTaskState(task.id, TaskState.PLAN);
    const tr = this.toTaskRecordLite(task);
    const ctx = await this.ctx(task.prompt);

    let plan: PlanOutput;
    try {
      plan = await this.d.brain.plan(tr, ctx);
    } catch (err) {
      // PLAN failure: pause + escalate rather than dispatch blind (Spec 06 §3.4 / T10).
      await this.escalate(task, {
        origin: "CLARIFY",
        reason: `I couldn't build a plan for this right now: ${(err as Error).message}`,
        options: [
          { key: "A", label: "Try again", effect: "re-run planning" },
          { key: "B", label: "Drop it", effect: "abandon the task" },
        ],
        raisedAt: this.now(),
      });
      return;
    }

    const issues = validatePlanOutput(plan);
    if (issues.length) {
      await this.escalate(task, {
        origin: "CLARIFY",
        reason: `I can't staff this as written — ${issues.join("; ")}.`,
        options: [
          { key: "A", label: "Rephrase", effect: "you clarify, I re-plan" },
          { key: "B", label: "Drop it", effect: "abandon the task" },
        ],
        raisedAt: this.now(),
      });
      return;
    }

    // STAFF (fused into PLAN for v0 — Spec 06 §4.4).
    this.d.store.setTaskState(task.id, TaskState.STAFF);
    const staff = await this.d.brain.staff(tr, plan, ctx);
    const assignmentByNode = new Map(staff.assignments.map((a) => [a.nodeId, a]));

    // Persist the DAG (nodes + criteria + deps) and seed the integration branch.
    const projectBranch = `beckett/${this.shortId(task.id)}/integration`;
    try {
      await this.ensureIntegrationBranch(task, projectBranch);
    } catch (err) {
      await this.escalate(task, {
        origin: "CLARIFY",
        reason: `I couldn't set up a working branch in the project repo: ${(err as Error).message}`,
        options: [{ key: "A", label: "OK", effect: "acknowledge" }],
        raisedAt: this.now(),
      });
      return;
    }
    this.d.store.updateTask({ id: task.id, project_branch: projectBranch });

    this.persistPlan(task, plan, assignmentByNode, projectBranch);
    this.d.store.appendEvent({ type: "plan.built", task_id: task.id, payload: { nodes: plan.nodes.length } });
    this.d.store.appendEvent({ type: "plan.staffed", task_id: task.id, payload: { assignments: staff.assignments.length } });

    // EXECUTING — start the DAG executor (Spec 04 T11).
    this.d.store.setTaskState(task.id, TaskState.EXECUTING);
    this.tick(task.id);
  }

  /** Decompose a PlanOutput into rows (Spec 09 §2.3/§2.4/§2.6) + the in-memory extras. */
  private persistPlan(
    task: TaskRow,
    plan: PlanOutput,
    assignmentByNode: Map<string, WorkerAssignment>,
    _projectBranch: string,
  ): void {
    const p: Plan = { summary: plan.summary, nodes: plan.nodes, deps: planDeps(plan) };
    // Map PLAN's node ids (n1, n2, …) to minted persistent ids.
    const idMap = new Map<string, string>();
    for (const pn of p.nodes) idMap.set(pn.id, mintNodeId());

    for (const pn of p.nodes) {
      const nid = idMap.get(pn.id)!;
      const now = this.now();
      const scope: FileScope = {
        ownedGlobs: pn.scopePaths,
        readGlobs: null,
        description: pn.title,
      };
      const deps = pn.dependsOn.map((d) => idMap.get(d)).filter((x): x is string => !!x);
      const branch = `beckett/${this.shortId(task.id)}/${this.shortId(nid)}`;
      const nodeRow: NodeRow = {
        id: nid,
        task_id: task.id,
        user_id: task.user_id,
        title: pn.title,
        state: deps.length ? NodeState.BLOCKED : NodeState.READY,
        scope_json: JSON.stringify(scope),
        branch,
        network: pn.network ? 1 : 0,
        attempts: 0,
        last_reviewer_id: null,
        feedback_json: "[]",
        critical_path_rank: null,
        created_at: now,
        updated_at: now,
      };
      this.d.store.createNode(nodeRow);

      const critRow: CriteriaRow = {
        id: mintCriteriaId(),
        node_id: nid,
        nl_criteria: JSON.stringify(pn.criteria.nl),
        checks_json: JSON.stringify(pn.criteria.checks),
        interface_contract: pn.criteria.interfaceContract ?? null,
        done_schema_path: null,
        created_at: now,
      };
      this.d.store.createCriteria(critRow);

      for (const dep of deps) {
        const depRow: NodeDepRow = { task_id: task.id, node_id: nid, depends_on_id: dep };
        this.d.store.addNodeDep(depRow);
      }

      const assignment = assignmentByNode.get(pn.id) ?? {
        nodeId: nid,
        harness: pn.suggestedWorker.harness,
        model: pn.suggestedWorker.model,
        effort: pn.suggestedWorker.effort,
      };
      this.nodeExtras.set(nid, {
        assignment: { ...assignment, nodeId: nid },
        initialCheckIn: pn.initialCheckIn,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // DAG executor — the topological scheduler (Spec 04 §6)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Re-drive the DAG scheduler for a task (pure over persisted state — safe after replay). */
  tick(taskId: string): void {
    const task = this.d.store.getTask(taskId);
    if (!task || task.state !== TaskState.EXECUTING) return;
    const nodes = this.d.store.listNodesForTask(taskId);

    // 1. Promote BLOCKED → READY where every dep is NODE_DONE (join semantics, Spec 04 N3).
    for (const n of nodes) {
      if (n.state !== NodeState.BLOCKED) continue;
      const deps = this.d.store.depsOf(n.id);
      const allDone = deps.every((dep) => {
        const up = this.d.store.getNode(dep.depends_on_id);
        return up?.state === NodeState.NODE_DONE;
      });
      if (allDone) {
        this.d.store.updateNodeState(n.id, NodeState.READY);
        this.d.store.appendEvent({ type: "node.dep_done", task_id: taskId, node_id: n.id, payload: {} });
        n.state = NodeState.READY;
      }
    }

    // 2. Dispatch READY nodes (the WorkerManager enforces + queues the global cap, Spec 01 §2.1).
    for (const n of nodes) {
      if (n.state === NodeState.READY) {
        void this.dispatchNode(task, n).catch((err) =>
          this.onNodeError(taskId, n.id, `dispatch failed: ${(err as Error).message}`),
        );
      }
    }

    // 3. Completion (Spec 04 T12 / §6.2).
    const fresh = this.d.store.listNodesForTask(taskId);
    if (fresh.length > 0 && fresh.every((n) => NODE_TERMINAL.has(n.state))) {
      if (fresh.some((n) => n.state === NodeState.NODE_FAILED)) return; // escalation already raised
      if (!this.delivering.has(taskId)) {
        this.delivering.add(taskId);
        void this.deliver(task).finally(() => this.delivering.delete(taskId));
      }
    }
  }

  /** Spawn (or re-spawn) a worker for a node (Spec 04 N4/N5). */
  private async dispatchNode(
    task: TaskRow,
    node: NodeRow,
    isResume = false,
    resumeSessionId?: string,
  ): Promise<Worker> {
    // Set DISPATCHED synchronously so a concurrent tick can't double-dispatch.
    this.d.store.updateNodeState(node.id, NodeState.DISPATCHED);

    const rec = this.hydrateNode(node);
    const assignment = this.assignmentFor(rec);
    const baseRef = task.project_branch ?? "HEAD";

    const worker = await this.d.workerManager.dispatch({
      node: rec,
      assignment,
      baseRef,
      isResume,
      resumeSessionId,
    });

    this.driftEvents.set(worker.id, this.driftEvents.get(worker.id) ?? 0);
    this.d.store.updateNodeState(node.id, NodeState.SUPERVISING);

    // Arm the Opus-scheduled first look (Spec 03 §3 / Spec 06 §4.3) if PLAN authored one. On a
    // resume the original check-ins are re-armed from SQLite by the supervisor (Tailer.rearm), so
    // we must NOT arm a fresh one here.
    const extras = this.nodeExtras.get(node.id);
    if (!isResume && extras?.initialCheckIn) {
      this.armCheckIn(worker, extras.initialCheckIn);
    }
    this.log.info("node dispatched", { nodeId: node.id, workerId: worker.id, isResume });
    return worker;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // SUPERVISE — driver-stream observation routed here by the daemon (Spec 03)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lifecycle hook for the worker's normalized event stream (wired by the daemon alongside the
   * Supervisor's read-only tail). The orchestrator only acts on terminal exit; the rich tail +
   * smoke-alarms stay with the Supervisor.
   */
  onWorkerEvent(worker: Worker, event: WorkerEvent): void {
    if (event.kind !== "finished") return;
    if (this.finishedWorkers.has(worker.id)) return;
    this.finishedWorkers.add(worker.id);
    void this.handleFinished(worker, event).catch((err) =>
      this.onNodeError(worker.taskId, worker.nodeId, `post-run pipeline crashed: ${(err as Error).message}`),
    );
  }

  /** A fired smoke-alarm → pull Opus in to look (Spec 03 §4). Wired by the daemon. */
  handleAlarm(alarm: SmokeAlarm, worker: Worker): void {
    void this.look(worker, [alarm]);
  }

  /** A fired check-in → pull Opus in to look (Spec 03 §3). Wired by the daemon. */
  handleCheckIn(_checkIn: CheckIn, worker: Worker): void {
    void this.look(worker, []);
  }

  /** Haiku-summarize → Opus drift-read → apply the decision (Spec 03 §4). */
  private async look(worker: Worker, alarms: SmokeAlarm[]): Promise<void> {
    if (this.lookInFlight.has(worker.id)) return;
    const live = this.d.workerManager.get(worker.id);
    // BLOCKER 2(a): a SUCCESSFUL worker sits in 'review' (set by the manager) before GATE advances
    // the node — exclude it, any terminal worker, and any worker whose finish we've already begun
    // processing, so a late alarm/check-in can't pull Opus in to "look" at a worker whose node
    // handleFinished is already driving INTEGRATING→…→NODE_DONE.
    if (
      !live ||
      this.finishedWorkers.has(worker.id) ||
      live.state === "review" ||
      live.state === "done" ||
      live.state === "failed" ||
      live.state === "aborted"
    ) {
      return;
    }
    this.lookInFlight.add(worker.id);
    this.driftEvents.set(worker.id, (this.driftEvents.get(worker.id) ?? 0) + 1);
    let decision: SuperviseDecision | null = null;
    try {
      this.d.store.appendEvent({
        type: "supervise.look",
        task_id: worker.taskId,
        node_id: worker.nodeId,
        worker_id: worker.id,
        payload: { alarms: alarms.map((a) => a.kind) },
      });
      const ctx = await this.ctx();
      let summary: WorkerSummary;
      try {
        summary = await this.d.brain.summarizeWorker(live, ctx);
      } catch {
        summary = {
          workerId: live.id,
          whatItsDoing: "(summary unavailable)",
          recentActions: [],
          currentPlan: "",
          signalsOfDrift: alarms.map((a) => a.kind),
          signalsOfProgress: [],
          blockedOn: null,
        };
      }
      decision = await this.d.brain.superviseRead(live, summary, alarms, ctx);
      this.d.store.appendEvent({
        type: "supervise.decision",
        task_id: worker.taskId,
        node_id: worker.nodeId,
        worker_id: worker.id,
        payload: { action: decision.action, reason: decision.reason },
      });
    } finally {
      // S2: release the per-worker look guard BEFORE delivering the decision. applyDecision's nudge
      // can block up to the 30s ACK timeout; holding lookInFlight across it would black out every
      // other alarm/check-in for this worker for that whole window. Further looks are NOT gated on
      // ack arrival — only on concurrent Opus reads (the Opus calls above).
      this.lookInFlight.delete(worker.id);
    }
    if (decision) await this.applyDecision(live, decision);
  }

  /** Enact an Opus supervise decision (Spec 03 §5). */
  private async applyDecision(worker: Worker, decision: SuperviseDecision): Promise<void> {
    switch (decision.action) {
      case "continue":
        break;
      case "nudge":
        if (decision.message?.trim()) {
          // BLOCKER 2(b): the worker can finish during the awaited Opus look above; re-check
          // liveness right before delivery so we don't steer (and FSM-regress) a finished worker.
          const liveNow = this.d.workerManager.get(worker.id);
          if (liveNow && !this.finishedWorkers.has(worker.id)) {
            await this.nudge(worker.id, decision.message, worker.userId, "opus_decision");
          }
        }
        break;
      case "pause":
        await this.pause(worker.id).catch((e) => this.log.warn("pause failed", { error: String(e) }));
        break;
      case "abort":
        await this.abort(worker.id, decision.reason).catch((e) =>
          this.log.warn("abort failed", { error: String(e) }),
        );
        break;
      case "reschedule":
        if (decision.nextCheckIn) {
          this.armCheckIn(worker, decision.nextCheckIn);
        }
        break;
    }
    // An explicit escalation rides alongside the action (Spec 03 §4.3).
    if (decision.escalate?.severity === "needs_input") {
      const task = this.d.store.getTask(worker.taskId);
      if (task) {
        await this.escalate(task, {
          origin: "SUPERVISE",
          nodeId: worker.nodeId,
          reason: decision.reason,
          options: [
            { key: "A", label: "Answer", effect: "provide the input and continue" },
            { key: "B", label: "Abort", effect: "stop this worker" },
          ],
          raisedAt: this.now(),
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // INTEGRATE → REVIEW → GATE (Spec 04 N11–N20; Spec 11)
  // ─────────────────────────────────────────────────────────────────────────────────────

  private async handleFinished(worker: Worker, event: WorkerEvent & { kind: "finished" }): Promise<void> {
    const task = this.d.store.getTask(worker.taskId);
    const nodeRow = this.d.store.getNode(worker.nodeId);
    if (!task || !nodeRow) return;
    if (NODE_TERMINAL.has(nodeRow.state)) return;

    // A worker crash (non-zero / error) shares the retry budget with gate-fails (Spec 04 N12).
    if (event.status === "error") {
      this.log.warn("worker exited with error", { workerId: worker.id, subtype: event.subtype });
      await this.failOrRetry(task, nodeRow, worker, "crash");
      return;
    }

    // INTEGRATE — commit the branch, merge into the integration branch (Spec 04 N11/N13).
    this.d.store.updateNodeState(nodeRow.id, NodeState.INTEGRATING);
    const repoRoot = this.d.repoRoot(task);
    try {
      await commitWorktree(worker.workspace, `beckett: ${nodeRow.title}`, this.d.commitAuthor);
      const projectBranch = task.project_branch!;
      const merge = await mergeBranch(repoRoot, worker.branch, projectBranch, this.d.commitAuthor);
      if (!merge.clean) {
        // v0 has no Opus integration worker yet — escalate honestly (Spec 04 §6.5 / N16).
        this.d.store.appendEvent({
          type: "integrate.merge_conflict",
          task_id: task.id,
          node_id: nodeRow.id,
          payload: { conflictFiles: merge.conflictFiles },
        });
        await this.failNode(task, nodeRow, worker, {
          origin: "SUPERVISE",
          nodeId: nodeRow.id,
          reason: `Merging "${nodeRow.title}" into the integration branch hit conflicts in ${merge.conflictFiles.join(", ") || "the tree"} and I can't auto-reconcile it in v0.`,
          options: [
            { key: "A", label: "I'll resolve it", effect: "you merge the branch by hand" },
            { key: "B", label: "Drop the node", effect: "abandon this node" },
          ],
          raisedAt: this.now(),
        });
        return;
      }
      this.d.store.appendEvent({
        type: "integrate.merge_clean",
        task_id: task.id,
        node_id: nodeRow.id,
        payload: { mergeSha: merge.mergeSha },
      });
    } catch (err) {
      this.log.error("integrate failed", { nodeId: nodeRow.id, error: (err as Error).message });
      await this.failOrRetry(task, nodeRow, worker, "crash");
      return;
    }

    // REVIEW — deterministic checks + the diff (Spec 04 N13/N17; Spec 11 §3).
    this.d.store.updateNodeState(nodeRow.id, NodeState.REVIEWING);
    const rec = this.hydrateNode(nodeRow);
    const baseRef = task.project_branch!;
    const diff = await safe(() => readDiff(worker.workspace, baseRef), "");
    const env = buildCheckEnv();
    const checks = await runChecks(rec.criteria.checks, worker.workspace, env);

    // GATE — Opus verdict against the NL criteria + checks (Spec 04 N18–N20; Spec 11 §6).
    this.d.store.updateNodeState(nodeRow.id, NodeState.GATING);
    const tier: ReviewTier = chooseTier(
      criticalitySignals(rec, diff, this.d.store.dependentsOf(nodeRow.id).length),
    );
    let verdict;
    try {
      const ctx = await this.ctx();
      verdict = await this.d.brain.gate(rec, checks, diff, ctx);
    } catch (err) {
      // Brain failure at GATE: pause + escalate rather than gating blind (Spec 11 §6.3).
      await this.failNode(task, nodeRow, worker, {
        origin: "GATE",
        nodeId: nodeRow.id,
        reason: `I couldn't run my review of "${nodeRow.title}" just now: ${(err as Error).message}`,
        options: [{ key: "A", label: "Retry", effect: "re-run the gate" }],
        raisedAt: this.now(),
      });
      return;
    }

    const result = runGate(rec, checks, verdict, tier === "fresh" ? "self" : tier, worker.sessionId ?? undefined);
    this.d.store.logGateOutcome(gateOutcomeRow(rec, result, worker.id));
    this.d.store.appendEvent({
      type: "gate.review_complete",
      task_id: task.id,
      node_id: nodeRow.id,
      worker_id: worker.id,
      payload: { pass: result.pass, checksPass: result.checksPass, reviewPass: result.reviewPass },
    });

    if (result.pass) {
      this.logWorkerOutcome(task, rec, worker, true, false);
      this.d.store.updateNodeState(nodeRow.id, NodeState.NODE_DONE);
      this.d.store.updateNode({ id: nodeRow.id, last_reviewer_id: worker.sessionId ?? null });
      await this.d.workerManager.reap(worker.id).catch(() => {});
      // Unblock dependents + check for DAG completion (Spec 04 N18/N22).
      this.tick(task.id);
      return;
    }

    // Gate fail — thread feedback, retry or escalate (Spec 04 N19/N20).
    await this.failOrRetry(task, nodeRow, worker, "gate", result.feedback);
  }

  /**
   * Apply the retry≤3 loop on a gate-fail or a crash (Spec 04 §8). Feedback is threaded into the
   * node + the next attempt's brief. After MAX_RETRIES the node escalates the task.
   */
  private async failOrRetry(
    task: TaskRow,
    nodeRow: NodeRow,
    worker: Worker,
    cause: "gate" | "crash",
    feedback?: ReviewerFeedback,
  ): Promise<void> {
    const history: ReviewerFeedback[] = JSON.parse(nodeRow.feedback_json || "[]");
    if (feedback) history.push(feedback);
    const attempts = nodeRow.attempts + 1;
    this.d.store.updateNode({
      id: nodeRow.id,
      attempts,
      feedback_json: JSON.stringify(history),
    });
    const updated: NodeRow = { ...nodeRow, attempts, feedback_json: JSON.stringify(history) };

    if (gateRetriesExhausted(this.hydrateNode(updated))) {
      this.logWorkerOutcome(task, this.hydrateNode(updated), worker, false, false);
      await this.failNode(task, updated, worker, buildGateEscalation(this.hydrateNode(updated)));
      return;
    }

    // RE_DISPATCH: reap the old worker, re-dispatch fresh with a feedback brief (Spec 04 N21/§8.1).
    this.d.store.updateNodeState(nodeRow.id, NodeState.RE_DISPATCH);
    await this.d.workerManager.reap(worker.id).catch(() => {});
    this.finishedWorkers.delete(worker.id);
    this.logWorkerOutcome(task, this.hydrateNode(updated), worker, false, false);
    this.d.store.appendEvent({
      type: cause === "gate" ? "gate.fail" : "worker.finished",
      task_id: task.id,
      node_id: nodeRow.id,
      payload: { attempt: attempts, cause },
    });
    // Back to READY so the executor re-dispatches it (carries the threaded feedback via hydrateNode).
    this.d.store.updateNodeState(nodeRow.id, NodeState.READY);
    this.tick(task.id);
  }

  /** Mark a node NODE_FAILED and escalate the owning task (Spec 04 T13/N23). */
  private async failNode(
    task: TaskRow,
    nodeRow: NodeRow,
    worker: Worker | null,
    escalation: Escalation,
  ): Promise<void> {
    this.d.store.updateNodeState(nodeRow.id, NodeState.NODE_FAILED);
    if (worker) await this.d.workerManager.reap(worker.id).catch(() => {});
    await this.escalate(task, escalation);
  }

  private onNodeError(taskId: string, nodeId: string, reason: string): void {
    this.log.error("node error", { taskId, nodeId, reason });
    const task = this.d.store.getTask(taskId);
    const node = this.d.store.getNode(nodeId);
    if (!task || !node || NODE_TERMINAL.has(node.state)) return;
    void this.failNode(task, node, null, {
      origin: "SUPERVISE",
      nodeId,
      reason,
      options: [{ key: "A", label: "OK", effect: "acknowledge" }],
      raisedAt: this.now(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // DELIVER (Spec 04 T12/T18; Spec 07 delivery handshake)
  // ─────────────────────────────────────────────────────────────────────────────────────

  private async deliver(task: TaskRow): Promise<void> {
    const fresh = this.d.store.getTask(task.id);
    if (!fresh || fresh.state !== TaskState.EXECUTING) return;
    this.d.store.setTaskState(task.id, TaskState.DELIVERING);

    const nodes = this.d.store.listNodesForTask(task.id);
    const projectBranch = fresh.project_branch ?? "";
    const fields: Record<string, unknown> = {
      branch: projectBranch,
      nodes: nodes.map((n) => ({ title: n.title, state: n.state })),
    };

    // Optional GitHub delivery handshake (Spec 07). Degrades gracefully without a PAT.
    let handshakePending: { pa: PendingActionRow; promptText: string } | null = null;

    // N8 idempotent recovery (Spec 09 §4.3): a prior (crashed) delivery may already have opened the
    // PR + staged the handshake. Reuse that staged action instead of double-pushing / double-PRing.
    // If that prior delivery ALSO already posted (its handshake awaiting-reply exists), the whole
    // delivery completed — finish the transition without re-posting to Discord.
    const priorPa = this.d.store.pendingActions().find((p) => p.task_id === fresh.id && p.status === "pending");
    if (priorPa) {
      const alreadyPosted = this.d.store
        .openAwaitingReplies()
        .some((a) => a.task_id === fresh.id && a.kind === "handshake");
      if (alreadyPosted) {
        this.d.store.setTaskState(fresh.id, TaskState.DELIVERED);
        return;
      }
      handshakePending = { pa: priorPa, promptText: priorPa.prompt_text };
      fields.handshake = priorPa.prompt_text;
    } else if (this.d.agency.githubAvailable) {
      try {
        const repo = this.repoSlug(fresh);
        await this.d.agency.github.pushBranch(repo, projectBranch, projectBranch);
        const pr = await this.d.agency.github.openPR({
          repo,
          head: projectBranch,
          base: "main",
          title: this.firstLine(fresh.prompt),
          body: `Automated by Beckett.\n\n${fresh.prompt}`,
        });
        fields.pr = pr;
        const hs = mergeHandshakeSpec({ repo, prNumber: pr.number, prUrl: pr.url, taskTitle: this.firstLine(fresh.prompt) });
        const res = await this.d.agency.perform(
          "gh.pr.merge",
          { taskId: fresh.id, userId: fresh.user_id, repo, ref: "main" },
          () => this.d.agency.github.mergePR(repo, pr.number, "squash"),
          hs,
        );
        if (res.status === "pending") {
          handshakePending = { pa: this.paRow(res.pendingAction), promptText: hs.promptText };
          fields.handshake = hs.promptText;
        }
      } catch (err) {
        this.log.warn("github delivery degraded", { error: (err as Error).message });
        fields.note = PR_PENDING_CREDS_NOTE;
      }
    } else {
      fields.note = PR_PENDING_CREDS_NOTE;
    }

    const ctx = await this.ctx(fresh.prompt, fields);
    let message: string;
    try {
      message = await this.d.brain.deliver(this.toTaskRecordLite(fresh), ctx);
    } catch {
      message = `Done. Work is on \`${projectBranch}\`.` + (fields.note ? `\n${fields.note}` : "");
    }
    const postedId = await this.post(fresh.channel_id, message, fresh.origin_msg_id ?? undefined);
    this.d.store.appendEvent({ type: "task.delivered", task_id: fresh.id, payload: { messageId: postedId } });
    this.d.store.setTaskState(fresh.id, TaskState.DELIVERED);

    if (handshakePending && postedId) {
      this.d.store.createAwaitingReply({
        id: ulidId("await"),
        kind: "handshake",
        task_id: fresh.id,
        pending_action_id: handshakePending.pa.id,
        channel_id: fresh.channel_id,
        user_id: fresh.user_id,
        prompt_message_id: postedId,
        buttons_custom_id_prefix: null,
        created_at: this.now(),
        expires_at: this.now() + 24 * 60 * 60 * 1000,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // ESCALATION (Spec 04 §9)
  // ─────────────────────────────────────────────────────────────────────────────────────

  private async escalate(task: TaskRow, escalation: Escalation): Promise<void> {
    this.d.store.setTaskState(task.id, TaskState.ESCALATED);
    const escId = mintEscalationId();
    this.d.store.raiseEscalation({
      id: escId,
      task_id: task.id,
      node_id: escalation.nodeId ?? null,
      origin: escalation.origin,
      reason: escalation.reason,
      options_json: JSON.stringify(escalation.options),
      posted_msg_id: null,
      state: "open",
      resolution: null,
      raised_at: escalation.raisedAt,
      resolved_at: null,
    });

    let message: string;
    try {
      message = await this.d.brain.escalationVoice(escalation, await this.ctx());
    } catch {
      message =
        `${escalation.reason}\n\n` +
        escalation.options.map((o) => `${o.key}) ${o.label} — ${o.effect}`).join("\n");
    }
    const postedId = await this.post(task.channel_id, message, task.origin_msg_id ?? undefined);
    if (postedId) {
      this.d.store.createAwaitingReply({
        id: ulidId("await"),
        kind: escalation.origin === "CLARIFY" ? "clarify" : "escalation_choice",
        task_id: task.id,
        pending_action_id: null,
        channel_id: task.channel_id,
        user_id: task.user_id,
        prompt_message_id: postedId,
        buttons_custom_id_prefix: null,
        created_at: this.now(),
        expires_at: this.now() + this.d.config.discord.escalate_after_s * 1000,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // REPLY resolution (Spec 05 §4 / Spec 04 T5/T15)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Resolve an inbound reply to a parked task (clarify / handshake / escalation answer). */
  async handleReply(m: IncomingMessage): Promise<boolean> {
    const open = this.d.store.openAwaitingReplies();
    if (open.length === 0) return false;
    let match =
      (m.repliedToId ? open.find((r) => r.prompt_message_id === m.repliedToId) : undefined) ??
      open.find((r) => r.channel_id === m.channelId && r.user_id === m.userId);
    if (!match) return false;

    const task = this.d.store.getTask(match.task_id);
    if (!task) {
      this.d.store.deleteAwaitingReply(match.id);
      return false;
    }
    this.ensureUser(m.userId);

    switch (match.kind) {
      case "clarify":
        return this.resolveClarify(match, task, m);
      case "handshake":
        return this.resolveHandshake(match, task, m);
      case "escalation_choice":
      case "self_halt":
        return this.resolveEscalationChoice(match, task, m);
      default:
        return false;
    }
  }

  private async resolveClarify(match: AwaitingReplyRow, task: TaskRow, m: IncomingMessage): Promise<boolean> {
    this.d.store.deleteAwaitingReply(match.id);
    this.d.store.appendEvent({ type: "task.clarify_answered", task_id: task.id, payload: { answer: m.content } });
    this.d.store.updateTask({ id: task.id, prompt: `${task.prompt}\n\n[Clarification from you] ${m.content}` });
    await this.planAndExecute(this.d.store.getTask(task.id)!);
    return true;
  }

  private async resolveHandshake(match: AwaitingReplyRow, task: TaskRow, m: IncomingMessage): Promise<boolean> {
    this.d.store.deleteAwaitingReply(match.id);
    const paId = match.pending_action_id;
    const pa = paId ? this.d.store.pendingActions().find((p) => p.id === paId) : undefined;
    const approve = /^\s*(y|yes|go|do it|merge|ship|approve|ok|sure)\b/i.test(m.content);
    if (!pa) {
      await this.post(task.channel_id, "That handshake already expired or was handled.", m.messageId);
      return true;
    }
    if (approve) {
      this.d.store.setPendingActionStatus(pa.id, "approved", m.userId);
      try {
        const row: PendingActionRow = { ...pa, status: "approved", decided_by: m.userId };
        if (this.d.agency.executeApproved) await this.d.agency.executeApproved(row);
        await this.post(task.channel_id, "Done — merged.", m.messageId);
      } catch (err) {
        await this.post(task.channel_id, `I couldn't complete that: ${(err as Error).message}`, m.messageId);
      }
    } else {
      this.d.store.setPendingActionStatus(pa.id, "rejected", m.userId);
      await this.post(task.channel_id, "Got it — I'll leave it for you.", m.messageId);
    }
    return true;
  }

  private async resolveEscalationChoice(match: AwaitingReplyRow, task: TaskRow, m: IncomingMessage): Promise<boolean> {
    this.d.store.deleteAwaitingReply(match.id);
    const esc = this.d.store.openEscalations().find((e) => e.task_id === task.id);
    if (esc) this.d.store.resolveEscalation(esc.id, m.content);
    this.d.store.appendEvent({ type: "escalation.resolved", task_id: task.id, payload: { answer: m.content } });

    const c = m.content.toLowerCase();
    if (/\b(abort|stop|cancel|drop it|kill)\b/.test(c)) {
      this.d.store.setTaskState(task.id, TaskState.ABORTED);
      await this.post(task.channel_id, "Stopped.", m.messageId);
      return true;
    }
    if (/\b(retry|again|continue|resume|more rope|a\b|keep going)\b/.test(c)) {
      // Reset the failed node and re-enter EXECUTING (Spec 04 T15).
      for (const n of this.d.store.listNodesForTask(task.id)) {
        if (n.state === NodeState.NODE_FAILED) {
          this.d.store.updateNode({ id: n.id, attempts: 0, feedback_json: "[]" });
          this.d.store.updateNodeState(n.id, NodeState.READY);
        }
      }
      this.d.store.setTaskState(task.id, TaskState.EXECUTING);
      this.tick(task.id);
      await this.post(task.channel_id, "On it — picking this back up.", m.messageId);
      return true;
    }
    // Anything else → take it as a "you handle it" close.
    this.d.store.setTaskState(task.id, TaskState.FAILED);
    await this.post(task.channel_id, "Understood — I'll leave this one to you.", m.messageId);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // IPC-backed control (Spec 10 §8.4)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Soft steer a worker (persist-first, then deliver via the driver — Spec 03 §6). */
  async nudge(workerId: string, text: string, userId: string, source: QueuedNudge["source"]): Promise<NudgeReceipt> {
    const worker = this.d.workerManager.get(workerId);
    if (!worker) throw new Error(`no live worker ${workerId}`);
    const nid = mintNudgeId();
    // Persist-first (Spec 03 §6.1): the nudge row is durable before any delivery attempt. The driver
    // layer buffers on a dead pipe, so delivery itself is always safe.
    this.d.store.enqueueNudge({
      id: nid,
      worker_id: workerId,
      node_id: worker.nodeId,
      user_id: userId,
      text,
      source,
      status: "queued",
      fail_reason: null,
      enqueued_at: this.now(),
      delivered_at: null,
    });

    // BLOCKER 2(c): only drive the NODE FSM while the node is actually under supervision. The worker
    // can finish during the awaited Opus look before we reach here; handleFinished then moves the
    // node INTEGRATING→REVIEWING→GATING→NODE_DONE. Writing NUDGING/SUPERVISING in that window would
    // regress a dead worker's node. When the node has moved on we still deliver (buffered) but never
    // touch the FSM.
    const node0 = this.d.store.getNode(worker.nodeId);
    const steerFsm =
      !this.finishedWorkers.has(workerId) &&
      !!node0 &&
      (node0.state === NodeState.SUPERVISING || node0.state === NodeState.NUDGING);
    if (steerFsm) this.d.store.updateNodeState(worker.nodeId, NodeState.NUDGING);

    // SUPERVISING resumes once the steer lands (Spec 04 N7) — but only if we still own NUDGING
    // (the worker may have finished during delivery and advanced the node).
    const restoreSupervising = (): void => {
      if (!steerFsm) return;
      const n = this.d.store.getNode(worker.nodeId);
      if (n?.state === NodeState.NUDGING) this.d.store.updateNodeState(worker.nodeId, NodeState.SUPERVISING);
    };

    try {
      const receipt = await worker.control.nudge(text);
      if (receipt.accepted === "delivered") this.d.store.markNudgeDelivered(nid);
      restoreSupervising();
      return receipt;
    } catch (err) {
      this.d.store.markNudgeFailed(nid, (err as Error).message);
      restoreSupervising();
      throw err;
    }
  }

  async pause(workerId: string): Promise<Checkpoint> {
    const worker = this.d.workerManager.get(workerId);
    const cp = await this.d.workerManager.pause(workerId);
    if (worker) this.d.store.updateNodeState(worker.nodeId, NodeState.PAUSED);
    return cp;
  }

  async resumeWorker(workerId: string): Promise<void> {
    const worker = this.d.workerManager.get(workerId);
    await this.d.workerManager.resume(workerId);
    if (worker) this.d.store.updateNodeState(worker.nodeId, NodeState.SUPERVISING);
  }

  async abort(workerId: string, reason: string): Promise<AbortState> {
    const worker = this.d.workerManager.get(workerId);
    const st = await this.d.workerManager.abort(workerId, reason);
    if (worker) {
      const task = this.d.store.getTask(worker.taskId);
      const node = this.d.store.getNode(worker.nodeId);
      if (task && node && !NODE_TERMINAL.has(node.state)) {
        await this.failNode(task, node, null, {
          origin: "SUPERVISE",
          nodeId: node.id,
          reason: `Aborted: ${reason}`,
          options: [
            { key: "A", label: "Re-scope & retry", effect: "reset and try again" },
            { key: "B", label: "Drop it", effect: "abandon this node" },
          ],
          raisedAt: this.now(),
        });
      }
    }
    return st;
  }

  async askPlan(workerId: string, _wait: boolean): Promise<NudgeReceipt> {
    const worker = this.d.workerManager.get(workerId);
    if (!worker) throw new Error(`no live worker ${workerId}`);
    return this.nudge(
      workerId,
      "What's your current plan? List your remaining steps and what's left to do.",
      worker.userId,
      "ask_plan",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // RECOVERY (Spec 04 §10; Spec 09 §4)
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Re-drive every non-terminal task from durable state on boot (Spec 04 §10.2). */
  async recover(): Promise<void> {
    const tasks = this.d.store.tasksWhereStateNotIn(
      new Set([TaskState.DELIVERED, TaskState.ABORTED, TaskState.FAILED]),
    );
    this.log.info("recovery: re-driving tasks", { count: tasks.length });
    for (const task of tasks) {
      try {
        switch (task.state) {
          case TaskState.INTAKE:
          case TaskState.CLARIFY:
          case TaskState.ESCALATED:
            // Awaiting-reply rows are durable; handleReply re-binds on the next message. Nothing
            // to actively resume here (Spec 04 §10.2 rearmAwaitingUser).
            break;
          case TaskState.PLAN:
          case TaskState.STAFF:
            // N8 idempotent recovery: if the DAG was already persisted before the crash, re-running
            // PLAN would mint duplicate node rows — resume the executor instead. Only re-plan when
            // nothing was persisted yet (PLAN crashed before persistPlan). Spec 09 §4.3.
            if (this.d.store.listNodesForTask(task.id).length > 0) {
              this.d.store.setTaskState(task.id, TaskState.EXECUTING);
              await this.recoverDag(this.d.store.getTask(task.id)!);
            } else {
              await this.planAndExecute(task);
            }
            break;
          case TaskState.EXECUTING:
            await this.recoverDag(task);
            break;
          case TaskState.DELIVERING:
            this.d.store.setTaskState(task.id, TaskState.EXECUTING); // so deliver's guard passes
            await this.deliver({ ...task, state: TaskState.EXECUTING });
            break;
        }
      } catch (err) {
        this.log.error("recovery failed for task", { taskId: task.id, error: (err as Error).message });
      }
    }

    // Spec 09 §4.3 step 0: reconcile durable steering against the now-recovered workers so nothing
    // is silently dropped or left orphaned. A queued nudge is delivered to its resumed worker (the
    // worker id is reused across --resume) or marked failed if its node was re-dispatched fresh /
    // didn't come back. A pending check-in whose worker didn't resume is cancelled (resumed ones
    // were already re-armed in resumeNode via the supervisor).
    for (const n of this.d.store.allQueuedNudges()) {
      const w = this.d.workerManager.get(n.worker_id);
      if (w) {
        try {
          const r = await w.control.nudge(n.text);
          if (r.accepted === "delivered") this.d.store.markNudgeDelivered(n.id);
        } catch (err) {
          this.d.store.markNudgeFailed(n.id, (err as Error).message);
        }
      } else {
        this.d.store.markNudgeFailed(n.id, "worker not resumed on recovery");
      }
    }
    for (const ci of this.d.store.pendingCheckIns()) {
      if (!this.d.workerManager.get(ci.worker_id)) this.d.store.setCheckInState(ci.id, "cancelled");
    }

    this.d.store.appendEvent({ type: "daemon.recover", payload: { tasks: tasks.length, resumed: this.resumedWorkerCount } });
  }

  /**
   * Recover a running DAG (Spec 04 §10.2 / Spec 09 §4.3). An actively-running worker whose session
   * was persisted is re-driven via the driver's `--resume` in its original worktree (losing ≤1
   * turn); a worker that already finished has its idempotent post-run phase (INTEGRATE/REVIEW/GATE)
   * re-driven; only a node with no resumable session falls back to a fresh re-dispatch.
   */
  private async recoverDag(task: TaskRow): Promise<void> {
    const repoRoot = this.d.repoRoot(task);
    for (const node of this.d.store.listNodesForTask(task.id)) {
      switch (node.state) {
        case NodeState.DISPATCHED:
        case NodeState.SUPERVISING:
        case NodeState.NUDGING:
        case NodeState.PAUSED: {
          // An actively-running worker. A persisted session_id ⇒ --resume it in place (Spec 09
          // §4.3, acceptance: lose ≤1 turn); otherwise it was never resumable ⇒ clean up + go READY.
          const live = this.d.store.liveWorkerForNode(node.id);
          if (live?.session_id) {
            await this.resumeNode(task, node, live);
          } else {
            if (live) {
              const { removeWorktree } = await import("../worker/worktree.ts");
              await removeWorktree(repoRoot, live.workspace).catch(() => {});
              this.d.store.setWorkerState(live.id, "aborted");
            }
            this.d.store.updateNodeState(node.id, NodeState.READY);
          }
          break;
        }
        case NodeState.INTEGRATING:
        case NodeState.REVIEWING:
        case NodeState.GATING: {
          // The worker already finished before the crash; re-drive the idempotent post-run pipeline
          // (guarded merge + pure checks/gate) rather than losing the completed node (Spec 09 §4.3
          // replayNodePhase). No live process is needed — branch + worktree + criteria are durable.
          const fin = this.d.store.liveWorkerForNode(node.id);
          if (fin) {
            await this.replayNodePhase(task, node, fin).catch((err) =>
              this.onNodeError(task.id, node.id, `recovery replay failed: ${(err as Error).message}`),
            );
          } else {
            this.d.store.updateNodeState(node.id, NodeState.READY);
          }
          break;
        }
        case NodeState.RE_DISPATCH:
          // Gate-fail was mid-flight; the old worker was already reaped in failOrRetry — re-dispatch
          // fresh with the persisted feedback brief (Spec 04 §8.1).
          this.d.store.updateNodeState(node.id, NodeState.READY);
          break;
        default:
          break; // BLOCKED / READY / NODE_DONE / NODE_FAILED — tick() handles them.
      }
    }
    this.tick(task.id);
  }

  /**
   * Re-attach an actively-running worker via the driver's `--resume <session_id>` (Spec 09 §4.3).
   * The WorkerManager reuses the prior worker row + worktree; here we re-seed the supervisor's
   * counters/alarms and re-arm its pending check-ins from the persisted transcript offset so a
   * reattach doesn't instantly re-trip an alarm. Falls back to a fresh dispatch if resume fails.
   */
  private async resumeNode(task: TaskRow, node: NodeRow, live: WorkerRow): Promise<void> {
    try {
      const worker = await this.dispatchNode(task, node, true, live.session_id ?? undefined);
      this.d.supervisor.rearm(worker, live.stream_offset_bytes);
      this.resumedWorkerCount += 1;
      this.log.info("node resumed via --resume", { nodeId: node.id, workerId: worker.id });
    } catch (err) {
      this.log.error("resume failed; re-dispatching fresh", {
        nodeId: node.id,
        error: (err as Error).message,
      });
      this.d.store.updateNodeState(node.id, NodeState.READY);
    }
  }

  /**
   * Re-drive a finished worker's idempotent post-run pipeline on recovery (Spec 09 §4.3). The merge
   * is guarded "already up to date", and checks/gate are pure over branch+criteria, so re-running
   * INTEGRATE→REVIEW→GATE is safe and avoids re-running the agent for a node whose work is done.
   */
  private async replayNodePhase(task: TaskRow, node: NodeRow, row: WorkerRow): Promise<void> {
    const worker = this.reconstructWorker(node, row);
    this.finishedWorkers.add(worker.id);
    await this.handleFinished(worker, {
      kind: "finished",
      status: "success",
      subtype: "recovered_replay",
      structuredOutput: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      ts: this.now(),
    });
  }

  /**
   * Rebuild a finished worker handle from its persisted row so {@link handleFinished} can re-drive
   * an idempotent post-run phase on recovery (Spec 09 §4.3). No live process/driver is involved —
   * the phase only reads the worktree, branch, telemetry, and criteria, all of which are durable.
   */
  private reconstructWorker(node: NodeRow, row: WorkerRow): Worker {
    const noop: WorkerControl = {
      nudge: async () => ({ accepted: "queued", at: this.now() }),
      pause: async () => {},
      resume: async () => {},
      abort: async () => {},
      askPlan: async () => ({ accepted: "queued", at: this.now() }),
    };
    return {
      id: row.id,
      nodeId: row.node_id,
      taskId: row.task_id,
      userId: row.user_id,
      harness: row.harness,
      driver: row.driver,
      model: row.model,
      sessionId: row.session_id,
      scope: this.hydrateNode(node).scope,
      workspace: row.workspace,
      branch: row.branch,
      resourceEnvelope: { effort: row.effort, turnCap: 0, wallClockS: 0, network: false },
      criteriaRef: "",
      state: "review",
      spend: {
        turns: row.turns,
        toolCalls: row.tool_calls,
        tokens: {
          input: row.tokens_in,
          output: row.tokens_out,
          cacheRead: row.tokens_cache_read,
          cacheCreate: row.tokens_cache_create,
        },
        diffLines: { added: row.diff_added, removed: row.diff_removed, files: row.diff_files },
        usdEstimate: row.usd_estimate,
      },
      control: noop,
      spawnedAt: row.spawned_at,
      lastActivityTs: row.last_activity_ts,
      endedAt: row.ended_at ?? this.now(),
    };
  }

  /** Workers re-attached via --resume during recovery — surfaced into StatusReport.recovery (Spec
   *  10 §7). The daemon owns the StatusReport and reads this after recover(); see module report for
   *  the one-line daemon wiring it needs. */
  get resumedWorkers(): number {
    return this.resumedWorkerCount;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────────────

  /** Hydrate a {@link NodeRecord} from its row + criteria + deps, threading retry feedback. */
  private hydrateNode(row: NodeRow): NodeRecord {
    const scope: FileScope = JSON.parse(row.scope_json);
    const crit = this.d.store.getCriteriaForNode(row.id);
    const criteria: AcceptanceCriteria = crit
      ? {
          nl: safeJson<string[]>(crit.nl_criteria, []),
          checks: safeJson<string[]>(crit.checks_json, []),
          interfaceContract: crit.interface_contract ?? undefined,
        }
      : { nl: [], checks: [] };
    const feedback: ReviewerFeedback[] = safeJson<ReviewerFeedback[]>(row.feedback_json, []);
    const deps = this.d.store.depsOf(row.id).map((d) => d.depends_on_id);

    // Thread the latest reviewer feedback into the worker brief on a re-dispatch (Spec 04 §8.2).
    let title = row.title;
    if (row.attempts > 0 && feedback.length) {
      title = `${row.title}\n\n${redispatchBrief(feedback[feedback.length - 1]!, "fresh")}`;
    }

    return {
      id: row.id,
      taskId: row.task_id,
      userId: row.user_id,
      title,
      deps,
      scope,
      network: row.network === 1,
      worker: this.nodeExtras.get(row.id)?.assignment,
      branch: row.branch,
      state: row.state,
      criteria,
      attempts: row.attempts,
      feedback,
      lastReviewerId: row.last_reviewer_id ?? undefined,
      criticalPathRank: row.critical_path_rank ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** The worker assignment for a node — from PLAN extras, else the last worker row, else default. */
  private assignmentFor(node: NodeRecord): WorkerAssignment {
    const extra = this.nodeExtras.get(node.id)?.assignment;
    if (extra) return extra;
    const last = this.d.store.liveWorkerForNode(node.id);
    if (last) {
      return { nodeId: node.id, harness: last.harness, model: last.model, effort: last.effort };
    }
    // Recovery fallback for a node never dispatched this run (no persisted assignment column).
    return {
      nodeId: node.id,
      harness: "claude",
      model: this.d.config.harness.claude.default_model,
      effort: "medium",
    };
  }

  /** Park a task awaiting a user reply, restart-rebindable (Spec 05 §4.1). */
  private armAwaitingReply(task: TaskRow, kind: AwaitingReplyRow["kind"], promptMessageId: string): void {
    if (!promptMessageId) return;
    this.d.store.createAwaitingReply({
      id: ulidId("await"),
      kind,
      task_id: task.id,
      pending_action_id: null,
      channel_id: task.channel_id,
      user_id: task.user_id,
      prompt_message_id: promptMessageId,
      buttons_custom_id_prefix: null,
      created_at: this.now(),
      expires_at: this.now() + this.d.config.discord.escalate_after_s * 1000,
    });
  }

  /** Arm an Opus-scheduled check-in for a worker (Spec 03 §3). */
  private armCheckIn(
    worker: Worker,
    trigger: { afterTurns?: number; afterSecs?: number; reason: string },
  ): void {
    const checkIn: CheckIn = {
      id: mintCheckInId(),
      workerId: worker.id,
      nodeId: worker.nodeId,
      createdByDecisionId: "",
      createdAt: this.now(),
      trigger: { afterTurns: trigger.afterTurns, afterSecs: trigger.afterSecs },
      turnsAtCreate: worker.spend.turns,
      reason: trigger.reason,
      state: "pending",
    };
    this.d.supervisor.scheduleCheckIn(checkIn);
  }

  /** Log a finished worker to the learned-model feed (Spec 09 §2.13). */
  private logWorkerOutcome(task: TaskRow, node: NodeRecord, worker: Worker, passed: boolean, aborted: boolean): void {
    const wallS = worker.endedAt ? Math.round((worker.endedAt - worker.spawnedAt) / 1000) : 0;
    const row: WorkerOutcomeRow = {
      id: mintOutcomeId(),
      user_id: task.user_id,
      task_id: task.id,
      node_id: node.id,
      worker_id: worker.id,
      harness: worker.harness,
      model: worker.model,
      task_type: task.task_type ?? "code",
      effort: worker.resourceEnvelope.effort,
      passed: passed ? 1 : 0,
      retries: node.attempts,
      drift_events: this.driftEvents.get(worker.id) ?? 0,
      scope_violations: this.d.store.getWorker(worker.id)?.scope_violations ?? 0,
      turns: worker.spend.turns,
      tool_calls: worker.spend.toolCalls,
      wall_clock_s: wallS,
      diff_added: worker.spend.diffLines.added,
      diff_removed: worker.spend.diffLines.removed,
      files_changed: worker.spend.diffLines.files,
      tokens_in: worker.spend.tokens.input,
      tokens_out: worker.spend.tokens.output,
      aborted: aborted ? 1 : 0,
      created_at: this.now(),
    };
    try {
      this.d.store.logOutcome(row);
    } catch (err) {
      this.log.warn("logOutcome failed", { error: (err as Error).message });
    }
  }

  /** Build a BrainContext with optional memory recall + role fields. */
  private async ctx(recallText?: string, fields: Record<string, unknown> = {}): Promise<BrainContext> {
    let memory: RecallResult | undefined;
    if (recallText) {
      try {
        memory = await this.d.memory.recall({ text: recallText });
      } catch {
        memory = undefined;
      }
    }
    return { persona: "", memory, fields };
  }

  /** A minimal in-memory TaskRecord projection the Brain role prompts consume. */
  private toTaskRecordLite(row: TaskRow) {
    return {
      id: row.id,
      userId: row.user_id,
      channelId: row.channel_id,
      originMsgId: row.origin_msg_id ?? undefined,
      state: row.state,
      taskType: row.task_type ?? undefined,
      prompt: row.prompt,
      assumptions: safeJson<string[]>(row.assumptions_json, []),
      projectBranch: row.project_branch ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Ensure a user row exists (FK target for tasks/nudges/handshakes — Spec 09). */
  private ensureUser(userId: string): void {
    if (this.d.store.getUserByDiscordId(userId)) return;
    const existing = this.d.store.getOwner();
    const now = this.now();
    const row: UserRow = {
      id: userId,
      discord_id: userId,
      display_name: userId,
      is_owner: existing ? 0 : 1, // first user seen becomes the owner (single-box v0)
      chattiness: this.d.config.discord.chattiness,
      created_at: now,
      updated_at: now,
    };
    try {
      this.d.store.upsertUser(row);
    } catch {
      // a concurrent insert is fine
    }
  }

  /** Post to Discord, swallowing transport errors (the gateway queues on its own). */
  private async post(channelId: string, content: string, replyTo?: string): Promise<string> {
    try {
      return await this.d.discord.post(channelId, content, replyTo ? { replyToMessageId: replyTo } : undefined);
    } catch (err) {
      this.log.warn("discord post failed", { channelId, error: (err as Error).message });
      return "";
    }
  }

  private failTask(taskId: string, reason: string): void {
    this.log.error("task failed", { taskId, reason });
    const task = this.d.store.getTask(taskId);
    if (!task) return;
    void this.post(task.channel_id, `I hit a wall on this one: ${reason}`, task.origin_msg_id ?? undefined);
    this.d.store.setTaskState(taskId, TaskState.FAILED);
  }

  /** A short, branch-safe slice of a beckett id (drops the prefix). */
  private shortId(id: string): string {
    return id.replace(/^[a-z]+_/, "");
  }

  private firstLine(s: string): string {
    const line = (s.split(/\r?\n/)[0] ?? s).trim();
    return line.length > 72 ? line.slice(0, 69) + "…" : line || "Beckett task";
  }

  /** Resolve a repo "org/name" slug for the agency from the project repo path. */
  private repoSlug(task: TaskRow): string {
    const root = this.d.repoRoot(task);
    const name = root.split("/").filter(Boolean).pop() ?? "project";
    const account = (this.d.agency as { identity?: { github?: { account?: string } } }).identity?.github?.account;
    return account ? `${account}/${name}` : name;
  }

  private paRow(pa: { id: string }): PendingActionRow {
    return this.d.store.pendingActions().find((p) => p.id === pa.id)!;
  }

  /** Ensure the integration branch exists in the project repo (created from the current HEAD). */
  private async ensureIntegrationBranch(task: TaskRow, projectBranch: string): Promise<void> {
    const repoRoot = this.d.repoRoot(task);
    const exists = (await this.git(["rev-parse", "--verify", "--quiet", projectBranch], repoRoot)).code === 0;
    if (exists) return;
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot);
    if (head.code !== 0) {
      throw new Error(`project repo at ${repoRoot} has no commits to branch from`);
    }
    const r = await this.git(["branch", projectBranch], repoRoot);
    if (r.code !== 0) throw new Error(`git branch ${projectBranch}: ${r.stderr.trim()}`);
  }

  private async git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const p = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code: await p.exited, stdout, stderr };
  }
}

// =======================================================================================
// Pure helpers
// =======================================================================================

/** Flatten a PlanOutput's per-node `dependsOn` into the executor's edge list. */
function planDeps(plan: PlanOutput): NodeDep[] {
  const deps: NodeDep[] = [];
  for (const n of plan.nodes) for (const d of n.dependsOn) deps.push({ nodeId: n.id, dependsOnId: d });
  return deps;
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Build the wired Orchestrator (the daemon's wiring point). */
export function createOrchestrator(deps: OrchestratorDeps): BeckettOrchestrator {
  return new BeckettOrchestrator(deps);
}

/** Compile-time check: BeckettOrchestrator satisfies the frozen Orchestrator contract. */
const _orchestratorCheck: new (d: OrchestratorDeps) => Orchestrator = BeckettOrchestrator;
void _orchestratorCheck;
