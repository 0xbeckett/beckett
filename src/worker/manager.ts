/**
 * Beckett — Worker Manager (`src/worker/manager.ts`)
 * =======================================================================================
 * Component 6 (Spec 01 §1 / §3 step 6; Spec 02): creates and tears down workers. For each
 * dispatched DAG node it allocates a git worktree+branch, builds the resource envelope,
 * selects the harness driver from the registry, ENFORCES the global concurrency cap with a
 * simple FIFO queue, tracks live handles, reaps on exit, and persists the worker row +
 * session_id (durability-critical, Spec 09 §4.1).
 *
 * The manager owns *mechanism around* a worker; it never parses a CLI itself — it holds a
 * {@link HarnessDriver} (Spec 02 §3) obtained from the injected {@link DriverRegistry} and
 * calls the typed control primitives. Scope enforcement is wired here too: the worktree gets
 * a `.claude/settings.json` registering the PreToolUse scope-guard hook (Spec 02 §8.2) and a
 * `.beckett/done-schema.json` for the structured done-signal (Spec 02 §6).
 *
 * Concurrency cap (Spec 01 §2.1): `concurrency.max_workers` bounds globally how many workers
 * hold a harness slot (states spawning|running|nudging|paused). When a worker frees its slot
 * (→review or a terminal state) the queue is pumped. Over-deep queues are rejected at
 * `concurrency.queue_max`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  WorkerManager,
  DispatchRequest,
  Worker,
  WorkerControl,
  WorkerState,
  WorkerSpend,
  WorkerEvent,
  WorkerRow,
  NodeRecord,
  ResourceEnvelope,
  Effort,
  Harness,
  DriverKind,
  HarnessDriver,
  SpawnSpec,
  Checkpoint,
  AbortState,
  Config,
  Paths,
  Store,
  Logger,
  AcceptanceCriteria,
} from "../types.ts";
import { WORKER_TERMINAL } from "../types.ts";
import { workerId as mintWorkerId } from "../ids.ts";
import { log } from "../log.ts";
import {
  createWorktree,
  removeWorktree,
  readDiff,
  readDiffStat,
  excludeFromGit,
} from "./worktree.ts";
import { scopeGuardSettings } from "../hooks/scope-guard.ts";
import { loadAndFormatSkills } from "../skills/index.ts";
import { initBaselineHooks } from "../hooks/registry.ts";

// =======================================================================================
// Injected collaborators
// =======================================================================================

/**
 * The driver factory the daemon wires (dependency inversion — the concrete ClaudeDriver /
 * CodexDriver live in their own module, Spec 02 §3/§4/§5). Given a driver kind and the
 * worker it staffs, return a ready (un-spawned) {@link HarnessDriver}.
 */
export interface DriverRegistry {
  create(kind: DriverKind, worker: Worker): HarnessDriver;
}

/** Construction dependencies for the WorkerManager. */
export interface WorkerManagerDeps {
  store: Store;
  config: Config;
  paths: Paths;
  drivers: DriverRegistry;
  /**
   * Resolve the absolute git repo root for a node's worktree. v0 single-node uses one project
   * root (NodeRecord/TaskRecord carry no project path in the frozen contract — see report).
   */
  resolveRepoRoot: (node: NodeRecord) => string;
  logger?: Logger;
  /** Absolute path to the scope-guard hook script; defaults to the colocated one. */
  scopeGuardPath?: string;
  /** Clock injection for tests. */
  now?: () => number;
}

/** A tracked live worker: its record, its driver, and bookkeeping. */
interface Handle {
  worker: Worker;
  driver: HarnessDriver;
  repoRoot: string;
  baseRef: string;
  unsubscribe: () => void;
}

/** A queued dispatch awaiting a free slot. */
interface QueuedDispatch {
  req: DispatchRequest;
  resolve: (w: Worker) => void;
  reject: (e: unknown) => void;
}

/** States that hold a harness slot toward the concurrency cap (Spec 01 §2.1). */
function consumesSlot(state: WorkerState): boolean {
  return !(WORKER_TERMINAL.has(state) || state === "review");
}

/** Driver kind for a harness (Spec 02 §2). */
function driverKindFor(harness: Harness): DriverKind {
  return harness === "claude" ? "claude-cli-stream" : "codex-exec-oneshot";
}

/** The structured done-signal JSON schema (Spec 02 §6). Written per-worker for the driver. */
const DONE_SCHEMA = {
  type: "object",
  required: ["status", "summary", "filesChanged"],
  properties: {
    status: { type: "string", enum: ["complete", "blocked", "partial"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    checksRun: { type: "array", items: { type: "string" } },
    blockedReason: { type: "string" },
  },
  additionalProperties: false,
} as const;

/**
 * Map effort → (turnCap, wallClockS) for the resource envelope (Spec 02 §9). PLAN authors a
 * per-node {@link NodeEnvelopeEstimate} (turnTarget/wallClockSecs) but that estimate is not
 * persisted on NodeRecord in the frozen contract (see report) — so the manager derives a
 * sane envelope from effort here. `network` comes from the node's opt-in (Spec 02 §6.3).
 */
function buildEnvelope(node: NodeRecord, effort: Effort): ResourceEnvelope {
  const byEffort: Record<Effort, { turnCap: number; wallClockS: number }> = {
    low: { turnCap: 15, wallClockS: 600 },
    medium: { turnCap: 30, wallClockS: 1200 },
    high: { turnCap: 60, wallClockS: 2400 },
    xhigh: { turnCap: 100, wallClockS: 3600 },
  };
  const { turnCap, wallClockS } = byEffort[effort];
  return { effort, turnCap, wallClockS, network: node.network };
}

/** Zeroed spend for a fresh worker. */
function zeroSpend(): WorkerSpend {
  return {
    turns: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    diffLines: { added: 0, removed: 0, files: 0 },
    usdEstimate: null,
  };
}

/** The businesslike worker-persona / scope / criteria system append (Spec 02 §4.3). */
function buildSystemAppend(scopeDesc: string, ownedGlobs: string[], criteria: AcceptanceCriteria): string {
  const owned = ownedGlobs.length ? ownedGlobs.join(", ") : "(your whole worktree)";
  const nl = criteria.nl.length ? criteria.nl.map((c) => `  - ${c}`).join("\n") : "  - (none specified)";
  const checks = criteria.checks.length
    ? `These checks must pass (each must exit 0):\n${criteria.checks.map((c) => `  - ${c}`).join("\n")}\n`
    : "";
  const skillsBlock = loadAndFormatSkills();
  const skillsPart = skillsBlock ? `\n\n${skillsBlock}\n` : "";

  return (
    `You are an autonomous worker. Scope: you own and may modify ONLY: ${owned}.\n` +
    `Treat everything else as read-only context. Do not edit files outside your scope; if you ` +
    `believe you must, stop and say so instead.\n` +
    (scopeDesc ? `Scope in plain terms: ${scopeDesc}.\n` : "") +
    `Acceptance criteria (you are done when ALL hold):\n${nl}\n` +
    checks +
    `When finished, emit the structured done-signal matching the provided schema.` +
    skillsPart
  );
}

/** The initial task brief handed to the worker (Spec 02 §4.1 prompt). */
function buildPrompt(node: NodeRecord, criteria: AcceptanceCriteria): string {
  const nl = criteria.nl.length ? `\n\nAcceptance criteria:\n${criteria.nl.map((c) => `- ${c}`).join("\n")}` : "";
  return `${node.title}${nl}`;
}

// =======================================================================================
// WorkerManager implementation
// =======================================================================================

export class DefaultWorkerManager implements WorkerManager {
  private readonly handles = new Map<string, Handle>();
  private readonly queue: QueuedDispatch[] = [];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly scopeGuardPath: string;

  constructor(private readonly deps: WorkerManagerDeps) {
    this.logger = deps.logger ?? log.child("worker-manager");
    this.now = deps.now ?? Date.now;
    this.scopeGuardPath = deps.scopeGuardPath ?? join(import.meta.dir, "../hooks/scope-guard.ts");
    // Additive: initialize registry with baseline scope guard (no behavior change)
    initBaselineHooks(`bun ${JSON.stringify(this.scopeGuardPath)}`);
  }

  // ── public surface (WorkerManager contract) ──────────────────────────────────────────

  /**
   * Allocate + dispatch a worker for a node. Enforces the global cap: if no slot is free the
   * request is queued (rejected past `queue_max`) and the returned promise resolves once the
   * worker actually starts.
   */
  async dispatch(req: DispatchRequest): Promise<Worker> {
    if (this.slotsInUse() < this.deps.config.concurrency.max_workers) {
      return this.startWorker(req);
    }
    if (this.queue.length >= this.deps.config.concurrency.queue_max) {
      throw new Error(
        `worker queue full (queue_max=${this.deps.config.concurrency.queue_max}); refusing dispatch for node ${req.node.id}`,
      );
    }
    this.logger.info("worker queued (cap reached)", {
      nodeId: req.node.id,
      inUse: this.slotsInUse(),
      cap: this.deps.config.concurrency.max_workers,
      queueDepth: this.queue.length + 1,
    });
    return new Promise<Worker>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
    });
  }

  get(workerId: string): Worker | undefined {
    return this.handles.get(workerId)?.worker;
  }

  /** Workers currently holding a harness slot (Spec 01 §2.1). */
  live(): Worker[] {
    return [...this.handles.values()].map((h) => h.worker).filter((w) => consumesSlot(w.state));
  }

  liveCount(): number {
    return this.slotsInUse();
  }

  /** Hard-stop a worker: kill via the driver, capture the partial diff, free the slot (Spec 03 §5.3). */
  async abort(workerId: string, reason: string): Promise<AbortState> {
    const h = this.mustGet(workerId);
    await h.driver.abort(reason);
    const partial = await this.captureState(h);
    h.worker.state = "aborted";
    h.worker.endedAt = this.now();
    this.deps.store.setWorkerState(workerId, "aborted");
    this.persistTelemetry(h, partial.counters);
    this.logger.warn("worker aborted", { workerId, reason });
    this.pumpQueue();
    return {
      workerId,
      reason,
      sessionId: h.worker.sessionId ?? "",
      diff: partial.diff,
      diffStat: partial.diffStat,
      lastTranscriptOffset: partial.lastTranscriptOffset,
      counters: partial.counters,
      killedAt: this.now(),
    };
  }

  /** Checkpoint a worker: quiesce via the driver, capture the diff, keep the session (Spec 03 §5.2). */
  async pause(workerId: string): Promise<Checkpoint> {
    const h = this.mustGet(workerId);
    await h.driver.pause();
    const snap = await this.captureState(h);
    h.worker.state = "paused";
    this.deps.store.setWorkerState(workerId, "paused");
    this.persistTelemetry(h, snap.counters);
    this.logger.info("worker paused", { workerId });
    return {
      workerId,
      at: this.now(),
      sessionId: h.worker.sessionId ?? "",
      diff: snap.diff,
      diffStat: snap.diffStat,
      lastTranscriptOffset: snap.lastTranscriptOffset,
      counters: snap.counters,
    };
  }

  /** Re-attach a paused worker (Spec 02 §4.5). */
  async resume(workerId: string): Promise<void> {
    const h = this.mustGet(workerId);
    await h.driver.resume();
    h.worker.state = "running";
    h.worker.lastActivityTs = this.now();
    this.deps.store.setWorkerState(workerId, "running");
    this.logger.info("worker resumed", { workerId });
  }

  /** Tear down a terminal/review worker's worktree (its diff already captured/merged, Spec 02 §8.1). */
  async reap(workerId: string): Promise<void> {
    const h = this.handles.get(workerId);
    if (!h) return;
    if (consumesSlot(h.worker.state)) {
      this.logger.warn("reaping a worker that still holds a slot; aborting it first", { workerId });
      await this.abort(workerId, "reaped while live");
    }
    h.unsubscribe();
    await removeWorktree(h.repoRoot, h.worker.workspace);
    this.handles.delete(workerId);
    this.logger.info("worker reaped", { workerId });
    this.pumpQueue();
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  /** Count workers currently holding a harness slot. */
  private slotsInUse(): number {
    let n = 0;
    for (const h of this.handles.values()) if (consumesSlot(h.worker.state)) n++;
    return n;
  }

  private mustGet(workerId: string): Handle {
    const h = this.handles.get(workerId);
    if (!h) throw new Error(`unknown worker ${workerId}`);
    return h;
  }

  /** Admit the next queued dispatch(es) while slots are free. */
  private pumpQueue(): void {
    while (this.queue.length > 0 && this.slotsInUse() < this.deps.config.concurrency.max_workers) {
      const next = this.queue.shift()!;
      this.startWorker(next.req).then(next.resolve, next.reject);
    }
  }

  /** The real allocation+spawn path (cap already checked by the caller). */
  private async startWorker(req: DispatchRequest): Promise<Worker> {
    const { node, assignment } = req;
    const harness = assignment.harness;
    const driverKind = driverKindFor(harness);
    const repoRoot = this.deps.resolveRepoRoot(node);

    // On a recovery --resume we reattach to the SAME worker row + worktree as the crashed run, so
    // the session resumes in its original cwd and we lose ≤1 turn — never a fresh re-dispatch
    // (Spec 09 §4.1/§4.3). A fresh dispatch mints a new id + worktree path.
    const prior = req.isResume ? this.deps.store.liveWorkerForNode(node.id) : null;
    const id = prior?.id ?? mintWorkerId();
    const workspace = prior?.workspace ?? join(repoRoot, ".beckett", "worktrees", id);
    const envelope = buildEnvelope(node, assignment.effort);
    const criteria = this.loadCriteria(node);
    const criteriaRow = this.deps.store.getCriteriaForNode(node.id);

    // claude resume relaunches with --resume <sessionId>; a fresh claude gets a caller-minted UUID
    // so we own resume identity from t=0 (Spec 02 §4.1). codex captures its thread_id (undefined).
    const preMintSession =
      harness === "claude"
        ? req.isResume
          ? req.resumeSessionId ?? prior?.session_id ?? undefined
          : randomUUID()
        : undefined;

    // Build the Worker record first (state=spawning) so control/driver can bind to it. On resume we
    // carry the prior telemetry forward so the supervisor's counters don't re-trip on reattach.
    const worker: Worker = {
      id,
      nodeId: node.id,
      taskId: node.taskId,
      userId: node.userId,
      harness,
      driver: driverKind,
      model: assignment.model,
      sessionId: preMintSession ?? null,
      scope: node.scope,
      workspace,
      branch: node.branch,
      resourceEnvelope: envelope,
      criteriaRef: criteriaRow?.id ?? "",
      state: "spawning",
      spend: prior ? spendFromRow(prior) : zeroSpend(),
      control: undefined as unknown as WorkerControl, // bound below once the driver exists
      spawnedAt: prior?.spawned_at ?? this.now(),
      lastActivityTs: this.now(),
      endedAt: null,
    };

    const driver = this.deps.drivers.create(driverKind, worker);
    worker.control = this.bindControl(driver);

    // Persist the row up-front. For a FRESH claude worker the row carries the pre-minted session_id
    // + is_resume BEFORE spawn, so a crash between spawn and init still leaves a resumable id
    // (Spec 09 §4.1 "the instant known"). On resume the row already exists → just re-mark spawning.
    if (prior) {
      this.deps.store.setWorkerState(id, "spawning");
    } else {
      this.deps.store.recordWorker(this.toRow(worker, req.isResume));
    }

    // Track the handle + subscribe to the stream for reap-on-exit (read-only; supervise owns the rest).
    const unsubscribe = driver.onEvent((e) => this.onDriverEvent(id, e));
    this.handles.set(id, { worker, driver, repoRoot, baseRef: req.baseRef, unsubscribe });

    try {
      // Layer-1 isolation: the git worktree + branch (Spec 02 §8.1). On resume the worktree is
      // reused in place — its pre-crash working tree is the durable checkpoint (Spec 09 §4.2).
      await createWorktree({
        repoRoot,
        workspace,
        branch: node.branch,
        baseRef: req.baseRef,
        reuseIfExists: req.isResume,
      });

      // Per-worker meta (kept out of the worker's diff via the worktree exclude).
      await excludeFromGit(workspace, [".claude/", ".beckett/"]);
      const doneSchemaPath = this.writeWorkerMeta(workspace, node.scope.ownedGlobs);

      const spec: SpawnSpec = {
        workerId: id,
        prompt: buildPrompt(node, criteria),
        systemAppend: buildSystemAppend(node.scope.description, node.scope.ownedGlobs, criteria),
        workspace,
        scope: node.scope,
        envelope,
        model: assignment.model,
        sessionId: preMintSession,
        doneSchemaPath,
      };

      if (req.isResume && worker.sessionId) {
        // Crash recovery: relaunch the harness with `--resume <session_id>` in the same cwd rather
        // than a fresh `--session-id` run (Spec 09 §4.3; acceptance: lose ≤1 turn). The frozen
        // HarnessDriver has no cold-start resume seam — resume() replays the SpawnSpec captured by
        // spawn(), which a freshly-created driver lacks — so we hand the rebuilt spec + session to
        // the driver, then call its existing resume(). (See module report: a HarnessDriver.attach
        // (spec) seam would replace this one bridge.)
        primeDriverForResume(driver, spec, worker.sessionId);
        await driver.resume();
        worker.state = "running";
        worker.lastActivityTs = this.now();
        this.deps.store.persistSessionId(id, worker.sessionId, resumePid(driver));
        this.logger.info("worker resumed via --resume", {
          workerId: id,
          nodeId: node.id,
          sessionId: worker.sessionId,
          workspace,
        });
        return worker;
      }

      const result = await driver.spawn(spec);
      worker.sessionId = result.sessionId;
      worker.state = "running";
      worker.lastActivityTs = this.now();
      // Durability-critical: persist session_id + pid the instant they are known (Spec 09 §4.1).
      this.deps.store.persistSessionId(id, result.sessionId, result.pid);
      this.logger.info("worker dispatched", {
        workerId: id,
        nodeId: node.id,
        harness,
        model: assignment.model,
        sessionId: result.sessionId,
        workspace,
      });
      return worker;
    } catch (err) {
      // Spawn/resume failed: mark failed, free the slot. Drop the worktree only on a FRESH spawn —
      // on a resume the worktree holds the crashed run's work and must survive for a later retry.
      worker.state = "failed";
      worker.endedAt = this.now();
      this.deps.store.setWorkerState(id, "failed");
      unsubscribe();
      this.handles.delete(id);
      if (!req.isResume) {
        try {
          await removeWorktree(repoRoot, workspace);
        } catch {
          /* best-effort cleanup */
        }
      }
      this.logger.error("worker dispatch failed", { workerId: id, nodeId: node.id, error: (err as Error).message });
      this.pumpQueue();
      throw err;
    }
  }

  /** Bind the 3+1 driver control primitives onto a worker (Spec 02 §2). */
  private bindControl(driver: HarnessDriver): WorkerControl {
    return {
      nudge: (msg) => driver.sendNudge(msg),
      pause: () => driver.pause(),
      resume: () => driver.resume(),
      abort: (reason) => driver.abort(reason),
      askPlan: () => driver.sendNudge("What's your current plan? List your remaining steps and what's left to do."),
    };
  }

  /**
   * React to the driver's normalized stream for lifecycle only (reap-on-exit). The Supervisor
   * (Spec 03) owns the rich read-only tail; here we just free the slot and snapshot final
   * telemetry when the process finishes, and backstop session capture.
   */
  private onDriverEvent(workerId: string, e: WorkerEvent): void {
    const h = this.handles.get(workerId);
    if (!h) return;
    h.worker.lastActivityTs = e.ts;

    if (e.kind === "session_started" && h.worker.sessionId == null) {
      h.worker.sessionId = e.sessionId;
    } else if (e.kind === "finished") {
      const spend = safeTelemetry(h.driver);
      const next: WorkerState = e.status === "success" ? "review" : "failed";
      h.worker.state = next;
      h.worker.endedAt = e.ts;
      h.worker.spend = spend;
      this.deps.store.setWorkerState(workerId, next);
      this.persistTelemetry(h, spend);
      this.logger.info("worker finished", { workerId, status: e.status, next });
      this.pumpQueue();
    }
  }

  /** Capture diff + telemetry for a pause/abort snapshot (Spec 03 §5.2/§5.3). */
  private async captureState(h: Handle): Promise<{
    diff: string;
    diffStat: { files: number; bytes: number };
    lastTranscriptOffset: number;
    counters: WorkerSpend;
  }> {
    const diff = await safeDiff(h.worker.workspace, h.baseRef);
    const stat = await safeDiffStat(h.worker.workspace, h.baseRef);
    const counters = safeTelemetry(h.driver);
    counters.diffLines = { added: stat.added, removed: stat.removed, files: stat.files };
    const row = this.deps.store.getWorker(h.worker.id);
    return {
      diff,
      diffStat: { files: stat.files, bytes: Buffer.byteLength(diff) },
      lastTranscriptOffset: row?.stream_offset_bytes ?? 0,
      counters,
    };
  }

  /** Persist a telemetry snapshot for a worker (keeps the row's counters current). */
  private persistTelemetry(h: Handle, spend: WorkerSpend): void {
    const row = this.deps.store.getWorker(h.worker.id);
    this.deps.store.updateWorkerTelemetry(h.worker.id, spend, h.worker.lastActivityTs, row?.stream_offset_bytes ?? 0);
  }

  /** Load a node's acceptance criteria from the store, falling back to the node's inline copy. */
  private loadCriteria(node: NodeRecord): AcceptanceCriteria {
    const row = this.deps.store.getCriteriaForNode(node.id);
    if (!row) return node.criteria;
    try {
      return {
        nl: JSON.parse(row.nl_criteria) as string[],
        checks: JSON.parse(row.checks_json) as string[],
        interfaceContract: row.interface_contract ?? undefined,
      };
    } catch {
      return node.criteria;
    }
  }

  /**
   * Write per-worker meta into the worktree: the scope-guard hook settings (`.claude/settings.json`,
   * auto-loaded by claude from cwd — Spec 02 §8.2) and the done-signal schema
   * (`.beckett/done-schema.json` — Spec 02 §6). Returns the done-schema path for the SpawnSpec.
   */
  private writeWorkerMeta(workspace: string, ownedGlobs: string[]): string {
    const settingsPath = join(workspace, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(scopeGuardSettings(this.scopeGuardPath, workspace, ownedGlobs), null, 2),
    );

    const doneSchemaPath = join(workspace, ".beckett", "done-schema.json");
    mkdirSync(dirname(doneSchemaPath), { recursive: true });
    writeFileSync(doneSchemaPath, JSON.stringify(DONE_SCHEMA, null, 2));
    return doneSchemaPath;
  }

  /** Project an in-memory Worker to its persisted row (Spec 09 §2.5). */
  private toRow(w: Worker, isResume: boolean): WorkerRow {
    return {
      id: w.id,
      node_id: w.nodeId,
      task_id: w.taskId,
      user_id: w.userId,
      harness: w.harness,
      driver: w.driver,
      model: w.model,
      effort: w.resourceEnvelope.effort,
      session_id: w.sessionId,
      workspace: w.workspace,
      branch: w.branch,
      // is_resume reflects HOW this worker was dispatched (fresh vs --resume), NOT merely whether a
      // session id is known — a fresh claude worker now carries its pre-minted id pre-spawn (§4.1).
      is_resume: isResume ? 1 : 0,
      state: w.state,
      turns: w.spend.turns,
      tool_calls: w.spend.toolCalls,
      tokens_in: w.spend.tokens.input,
      tokens_out: w.spend.tokens.output,
      tokens_cache_read: w.spend.tokens.cacheRead,
      tokens_cache_create: w.spend.tokens.cacheCreate,
      diff_added: w.spend.diffLines.added,
      diff_removed: w.spend.diffLines.removed,
      diff_files: w.spend.diffLines.files,
      usd_estimate: w.spend.usdEstimate,
      scope_violations: 0,
      stream_offset_bytes: 0,
      pid: null,
      spawned_at: w.spawnedAt,
      last_activity_ts: w.lastActivityTs,
      ended_at: w.endedAt,
    };
  }
}

// =======================================================================================
// Safe wrappers — telemetry/diff capture must never throw out of pause/abort/reap
// =======================================================================================

function safeTelemetry(driver: HarnessDriver): WorkerSpend {
  try {
    return driver.getTelemetry();
  } catch {
    return zeroSpend();
  }
}

async function safeDiff(workspace: string, baseRef: string): Promise<string> {
  try {
    return await readDiff(workspace, baseRef);
  } catch {
    return "";
  }
}

async function safeDiffStat(workspace: string, baseRef: string) {
  try {
    return await readDiffStat(workspace, baseRef);
  } catch {
    return { files: 0, added: 0, removed: 0 };
  }
}

/** Project a persisted worker row's telemetry back into a WorkerSpend (resume reattach, §4.3). */
function spendFromRow(r: WorkerRow): WorkerSpend {
  return {
    turns: r.turns,
    toolCalls: r.tool_calls,
    tokens: {
      input: r.tokens_in,
      output: r.tokens_out,
      cacheRead: r.tokens_cache_read,
      cacheCreate: r.tokens_cache_create,
    },
    diffLines: { added: r.diff_added, removed: r.diff_removed, files: r.diff_files },
    usdEstimate: r.usd_estimate,
  };
}

/**
 * Cold-start resume bridge (Spec 09 §4.3). The frozen {@link HarnessDriver} exposes resume() but no
 * way to seed a freshly-created driver with the {@link SpawnSpec}/session it needs to relaunch
 * `--resume` after a daemon restart (those are normally captured inside spawn(), which we must NOT
 * call for a resume because it would start a fresh `--session-id` run). We hand the rebuilt spec +
 * session to the concrete driver here, then call its public resume(). Reported as the one place that
 * would be cleaner with a `HarnessDriver.attach(spec)` contract seam.
 */
function primeDriverForResume(driver: HarnessDriver, spec: SpawnSpec, sessionId: string): void {
  const d = driver as unknown as { spec: SpawnSpec | null; sessionId: string | null };
  d.spec = spec;
  d.sessionId = sessionId;
}

/** Best-effort read of a relaunched driver's pid for orphan-reaping bookkeeping (Spec 09 §2.5). */
function resumePid(driver: HarnessDriver): number {
  const d = driver as unknown as { pid?: number | null };
  return typeof d.pid === "number" ? d.pid : -1;
}

/** Convenience factory matching the rest of the codebase's `createX` style. */
export function createWorkerManager(deps: WorkerManagerDeps): DefaultWorkerManager {
  return new DefaultWorkerManager(deps);
}

/** Compile-time check: DefaultWorkerManager satisfies the frozen WorkerManager contract. */
const _managerCheck: new (d: WorkerManagerDeps) => WorkerManager = DefaultWorkerManager;
void _managerCheck;
