/**
 * Beckett — the canonical persistence repository (`src/persistence/store.ts`)
 * =======================================================================================
 * The {@link Store} implementation over `bun:sqlite` (built-in; do NOT add better-sqlite3,
 * Spec 00 §4) plus the JSONL audit log (`./events.ts`). The daemon is the SOLE writer; the
 * CLI opens the same DB read-only (Spec 09 §7). Every state-changing operation writes the
 * SQLite row(s) AND an {@link EventRecord} inside ONE transaction (Spec 09 §3.4), and
 * durability-critical writes are persist-first (session_id, nudges, check-ins — Spec 09 §4.1).
 *
 * Transactions are short and synchronous — never held across an `await` (Spec 09 §7.2).
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Store,
  Config,
  Paths,
  EventRecord,
  EventInput,
  UserRow,
  TaskRow,
  TaskState,
  NodeRow,
  NodeState,
  NodeDepRow,
  WorkerRow,
  WorkerState,
  WorkerSpend,
  CriteriaRow,
  GateOutcomeRow,
  CheckInRow,
  NudgeRow,
  EscalationRow,
  PendingActionRow,
  AwaitingReplyRow,
  MemoryIndexRow,
  MemoryLinkRow,
  WorkerOutcomeRow,
  RankedWorker,
  MigrationFile,
  PendingActionClass,
} from "../types.ts";
import { TASK_TERMINAL } from "../types.ts";
import { MIGRATIONS } from "./schema.ts";
import { EventWriter, readEvents } from "./events.ts";
import { log } from "../log.ts";

const logger = log.child("store");

/** Options for constructing the store. */
export interface StoreOptions {
  dbPath: string;
  eventsDir: string;
  maxFileBytes?: number;
  /** Migrations to run (defaults to the schema head — overridable for tests). */
  migrations?: MigrationFile[];
}

export class SqliteStore implements Store {
  private db!: Database;
  private events!: EventWriter;
  private readonly migrations: MigrationFile[];

  constructor(private readonly opts: StoreOptions) {
    this.migrations = opts.migrations ?? MIGRATIONS;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────

  init(): void {
    mkdirSync(dirname(this.opts.dbPath), { recursive: true });
    this.db = new Database(this.opts.dbPath, { create: true });

    // Connection PRAGMAs (Spec 09 §1.1) — set at open, outside any transaction.
    // auto_vacuum is a no-op on an already-populated DB; harmless on a fresh one.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000;");
    this.db.exec("PRAGMA auto_vacuum = INCREMENTAL;");

    this.events = new EventWriter(this.opts.eventsDir, this.opts.maxFileBytes);
    this.migrate();
  }

  close(): void {
    this.db?.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Forward-only, checksum-locked migration runner (Spec 09 §6). */
  private migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY, name TEXT NOT NULL,
         applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`,
    );
    const appliedRows = this.db
      .query<{ version: number; checksum: string }, []>(
        "SELECT version, checksum FROM schema_migrations",
      )
      .all();
    const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));
    const maxApplied = appliedRows.reduce((m, r) => Math.max(m, r.version), 0);

    const pending = this.migrations
      .filter((m) => !applied.has(m.version))
      .sort((a, b) => a.version - b.version);

    // Immutability guard: an already-applied migration whose file changed → refuse to start.
    for (const m of this.migrations) {
      const prior = applied.get(m.version);
      if (prior !== undefined && prior !== m.checksum) {
        throw new Error(
          `migration ${m.version} (${m.name}) checksum drift — applied history was edited; refusing to start`,
        );
      }
    }

    if (pending.length === 0) return;

    // Cheap insurance: back up the DB before applying pending migrations (Spec 09 §6).
    if (maxApplied > 0 && existsSync(this.opts.dbPath)) {
      const bak = `${this.opts.dbPath}.bak-${maxApplied}`;
      try {
        copyFileSync(this.opts.dbPath, bak);
        logger.info("db backed up before migration", { backup: bak });
      } catch (err) {
        logger.warn("db backup failed (continuing)", { error: (err as Error).message });
      }
    }

    for (const m of pending) {
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.run(
          "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
          [m.version, m.name, Date.now(), m.checksum],
        );
      })();
      logger.info("migration applied", { version: m.version, name: m.name });
    }
  }

  // ── audit append (called INSIDE transactions by the writers below; Spec 09 §3.4) ─────

  appendEvent(e: EventInput): EventRecord {
    return this.events.append(e);
  }

  // ── users (Spec 09 §2.1) ─────────────────────────────────────────────────────────────

  upsertUser(u: UserRow): void {
    this.db.run(
      `INSERT INTO users (id, discord_id, display_name, is_owner, chattiness, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         discord_id=excluded.discord_id, display_name=excluded.display_name,
         is_owner=excluded.is_owner, chattiness=excluded.chattiness, updated_at=excluded.updated_at`,
      [u.id, u.discord_id, u.display_name, u.is_owner, u.chattiness, u.created_at, u.updated_at],
    );
  }

  getUserByDiscordId(discordId: string): UserRow | null {
    return (
      this.db
        .query<UserRow, [string]>("SELECT * FROM users WHERE discord_id = ?")
        .get(discordId) ?? null
    );
  }

  getOwner(): UserRow | null {
    return (
      this.db.query<UserRow, []>("SELECT * FROM users WHERE is_owner = 1 LIMIT 1").get() ?? null
    );
  }

  // ── tasks (Spec 09 §2.2) ─────────────────────────────────────────────────────────────

  createTask(t: TaskRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO tasks (id, user_id, channel_id, origin_msg_id, state, task_type, prompt,
                            assumptions_json, project_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id, t.user_id, t.channel_id, t.origin_msg_id, t.state, t.task_type, t.prompt,
          t.assumptions_json, t.project_branch, t.created_at, t.updated_at,
        ],
      );
      this.appendEvent({
        type: "task.created",
        task_id: t.id,
        user_id: t.user_id,
        payload: { channelId: t.channel_id, state: t.state },
      });
    });
  }

  getTask(id: string): TaskRow | null {
    return this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
  }

  setTaskState(id: string, state: TaskState): void {
    this.transaction(() => {
      this.db.run("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?", [state, Date.now(), id]);
      this.appendEvent({ type: "task.state_changed", task_id: id, payload: { state } });
    });
  }

  updateTask(t: Partial<TaskRow> & { id: string }): void {
    const cols = Object.keys(t).filter((k) => k !== "id");
    if (cols.length === 0) return;
    const set = cols.map((c) => `${c} = ?`).join(", ");
    const vals = cols.map((c) => (t as Record<string, unknown>)[c]) as SQLQueryBindings[];
    this.db.run(`UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), t.id]);
  }

  listActiveTasks(): TaskRow[] {
    return this.tasksWhereStateNotIn(TASK_TERMINAL);
  }

  tasksWhereStateNotIn(terminal: ReadonlySet<TaskState>): TaskRow[] {
    const states = [...terminal];
    if (states.length === 0) return this.db.query<TaskRow, []>("SELECT * FROM tasks").all();
    const placeholders = states.map(() => "?").join(", ");
    return this.db
      .query<TaskRow, string[]>(`SELECT * FROM tasks WHERE state NOT IN (${placeholders})`)
      .all(...states);
  }

  // ── nodes + deps (Spec 09 §2.3/§2.4) ──────────────────────────────────────────────────

  createNode(n: NodeRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO nodes (id, task_id, user_id, title, state, scope_json, branch, network,
                            attempts, last_reviewer_id, feedback_json, critical_path_rank,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          n.id, n.task_id, n.user_id, n.title, n.state, n.scope_json, n.branch, n.network,
          n.attempts, n.last_reviewer_id, n.feedback_json, n.critical_path_rank,
          n.created_at, n.updated_at,
        ],
      );
      this.appendEvent({
        type: "node.created",
        task_id: n.task_id,
        node_id: n.id,
        payload: { title: n.title, state: n.state },
      });
    });
  }

  getNode(id: string): NodeRow | null {
    return this.db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(id) ?? null;
  }

  updateNodeState(id: string, state: NodeState): void {
    this.transaction(() => {
      this.db.run("UPDATE nodes SET state = ?, updated_at = ? WHERE id = ?", [state, Date.now(), id]);
      this.appendEvent({ type: "node.state_changed", node_id: id, payload: { state } });
    });
  }

  updateNode(n: Partial<NodeRow> & { id: string }): void {
    const cols = Object.keys(n).filter((k) => k !== "id");
    if (cols.length === 0) return;
    const set = cols.map((c) => `${c} = ?`).join(", ");
    const vals = cols.map((c) => (n as Record<string, unknown>)[c]) as SQLQueryBindings[];
    this.db.run(`UPDATE nodes SET ${set}, updated_at = ? WHERE id = ?`, [...vals, Date.now(), n.id]);
  }

  listNodesForTask(taskId: string): NodeRow[] {
    return this.db
      .query<NodeRow, [string]>("SELECT * FROM nodes WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
  }

  addNodeDep(dep: NodeDepRow): void {
    this.db.run(
      "INSERT OR IGNORE INTO node_deps (task_id, node_id, depends_on_id) VALUES (?, ?, ?)",
      [dep.task_id, dep.node_id, dep.depends_on_id],
    );
  }

  depsOf(nodeId: string): NodeDepRow[] {
    return this.db
      .query<NodeDepRow, [string]>("SELECT * FROM node_deps WHERE node_id = ?")
      .all(nodeId);
  }

  dependentsOf(nodeId: string): NodeDepRow[] {
    return this.db
      .query<NodeDepRow, [string]>("SELECT * FROM node_deps WHERE depends_on_id = ?")
      .all(nodeId);
  }

  // ── criteria (Spec 09 §2.6) ───────────────────────────────────────────────────────────

  createCriteria(c: CriteriaRow): void {
    this.db.run(
      `INSERT INTO criteria (id, node_id, nl_criteria, checks_json, interface_contract,
                             done_schema_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.node_id, c.nl_criteria, c.checks_json, c.interface_contract, c.done_schema_path, c.created_at],
    );
  }

  getCriteriaForNode(nodeId: string): CriteriaRow | null {
    return (
      this.db
        .query<CriteriaRow, [string]>("SELECT * FROM criteria WHERE node_id = ?")
        .get(nodeId) ?? null
    );
  }

  // ── workers (Spec 09 §2.5; durability-critical) ───────────────────────────────────────

  recordWorker(w: WorkerRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO workers (id, node_id, task_id, user_id, harness, driver, model, effort,
                              session_id, workspace, branch, is_resume, state,
                              turns, tool_calls, tokens_in, tokens_out, tokens_cache_read,
                              tokens_cache_create, diff_added, diff_removed, diff_files, usd_estimate,
                              scope_violations, stream_offset_bytes, pid,
                              spawned_at, last_activity_ts, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          w.id, w.node_id, w.task_id, w.user_id, w.harness, w.driver, w.model, w.effort,
          w.session_id, w.workspace, w.branch, w.is_resume, w.state,
          w.turns, w.tool_calls, w.tokens_in, w.tokens_out, w.tokens_cache_read,
          w.tokens_cache_create, w.diff_added, w.diff_removed, w.diff_files, w.usd_estimate,
          w.scope_violations, w.stream_offset_bytes, w.pid,
          w.spawned_at, w.last_activity_ts, w.ended_at,
        ],
      );
      this.appendEvent({
        type: "worker.spawned",
        task_id: w.task_id,
        node_id: w.node_id,
        worker_id: w.id,
        user_id: w.user_id,
        payload: { harness: w.harness, model: w.model, isResume: w.is_resume },
      });
    });
  }

  getWorker(id: string): WorkerRow | null {
    return this.db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id) ?? null;
  }

  /** Persist session_id + pid the instant they are known → enables --resume (Spec 09 §4.1). */
  persistSessionId(workerId: string, sessionId: string, pid: number): void {
    this.transaction(() => {
      this.db.run("UPDATE workers SET session_id = ?, pid = ?, state = 'running' WHERE id = ?", [
        sessionId, pid, workerId,
      ]);
      this.appendEvent({
        type: "worker.session_captured",
        worker_id: workerId,
        payload: { sessionId, pid },
      });
    });
  }

  setWorkerState(id: string, state: WorkerState): void {
    const endedAt = state === "done" || state === "failed" || state === "aborted" ? Date.now() : null;
    this.db.run("UPDATE workers SET state = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?", [
      state, endedAt, id,
    ]);
  }

  updateWorkerTelemetry(
    id: string,
    spend: WorkerSpend,
    lastActivityTs: number,
    streamOffsetBytes: number,
  ): void {
    this.db.run(
      `UPDATE workers SET turns = ?, tool_calls = ?, tokens_in = ?, tokens_out = ?,
              tokens_cache_read = ?, tokens_cache_create = ?, diff_added = ?, diff_removed = ?,
              diff_files = ?, usd_estimate = ?, last_activity_ts = ?, stream_offset_bytes = ?
       WHERE id = ?`,
      [
        spend.turns, spend.toolCalls, spend.tokens.input, spend.tokens.output,
        spend.tokens.cacheRead, spend.tokens.cacheCreate, spend.diffLines.added,
        spend.diffLines.removed, spend.diffLines.files, spend.usdEstimate,
        lastActivityTs, streamOffsetBytes, id,
      ],
    );
  }

  /** The most-recent non-terminal worker for a node (the live one, Spec 09 §2.5). */
  liveWorkerForNode(nodeId: string): WorkerRow | null {
    return (
      this.db
        .query<WorkerRow, [string]>(
          `SELECT * FROM workers
           WHERE node_id = ? AND state NOT IN ('done','failed','aborted')
           ORDER BY spawned_at DESC LIMIT 1`,
        )
        .get(nodeId) ?? null
    );
  }

  nonTerminalWorkers(): WorkerRow[] {
    return this.db
      .query<WorkerRow, []>("SELECT * FROM workers WHERE state NOT IN ('done','failed','aborted')")
      .all();
  }

  // ── nudges (Spec 09 §2.9; persist-first) ──────────────────────────────────────────────

  enqueueNudge(n: NudgeRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO nudges (id, worker_id, node_id, user_id, text, source, status, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        [n.id, n.worker_id, n.node_id, n.user_id, n.text, n.source, n.enqueued_at],
      );
      this.appendEvent({
        type: "nudge.enqueued",
        worker_id: n.worker_id,
        node_id: n.node_id,
        user_id: n.user_id,
        payload: { nudgeId: n.id, source: n.source },
      });
    });
  }

  markNudgeDelivered(id: string): void {
    this.transaction(() => {
      this.db.run("UPDATE nudges SET status = 'delivered', delivered_at = ? WHERE id = ?", [
        Date.now(), id,
      ]);
      this.appendEvent({ type: "nudge.delivered", payload: { nudgeId: id } });
    });
  }

  markNudgeFailed(id: string, reason: string): void {
    this.transaction(() => {
      this.db.run("UPDATE nudges SET status = 'failed', fail_reason = ? WHERE id = ?", [reason, id]);
      this.appendEvent({ type: "nudge.failed", payload: { nudgeId: id, reason } });
    });
  }

  queuedNudges(workerId: string): NudgeRow[] {
    return this.db
      .query<NudgeRow, [string]>(
        "SELECT * FROM nudges WHERE worker_id = ? AND status = 'queued' ORDER BY enqueued_at",
      )
      .all(workerId);
  }

  allQueuedNudges(): NudgeRow[] {
    return this.db
      .query<NudgeRow, []>("SELECT * FROM nudges WHERE status = 'queued' ORDER BY enqueued_at")
      .all();
  }

  // ── check-ins (Spec 09 §2.8) ──────────────────────────────────────────────────────────

  insertCheckIn(c: CheckInRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO check_ins (id, worker_id, node_id, created_by_decision_id, after_turns,
                                after_secs, at_turn_abs, turns_at_create, fire_at, reason, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id, c.worker_id, c.node_id, c.created_by_decision_id, c.after_turns, c.after_secs,
          c.at_turn_abs, c.turns_at_create, c.fire_at, c.reason, c.state, c.created_at,
        ],
      );
      this.appendEvent({
        type: "supervise.checkin_scheduled",
        worker_id: c.worker_id,
        node_id: c.node_id,
        payload: { checkInId: c.id, reason: c.reason },
      });
    });
  }

  setCheckInState(id: string, state: CheckInRow["state"]): void {
    this.db.run("UPDATE check_ins SET state = ? WHERE id = ?", [state, id]);
  }

  pendingCheckIns(workerId?: string): CheckInRow[] {
    if (workerId) {
      return this.db
        .query<CheckInRow, [string]>(
          "SELECT * FROM check_ins WHERE state = 'pending' AND worker_id = ?",
        )
        .all(workerId);
    }
    return this.db
      .query<CheckInRow, []>("SELECT * FROM check_ins WHERE state = 'pending'")
      .all();
  }

  // ── escalations (Spec 09 §2.10) ───────────────────────────────────────────────────────

  raiseEscalation(e: EscalationRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO escalations (id, task_id, node_id, origin, reason, options_json, posted_msg_id,
                                  state, resolution, raised_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.id, e.task_id, e.node_id, e.origin, e.reason, e.options_json, e.posted_msg_id,
          e.state, e.resolution, e.raised_at, e.resolved_at,
        ],
      );
      this.appendEvent({
        type: "escalation.raised",
        task_id: e.task_id,
        node_id: e.node_id,
        payload: { escalationId: e.id, origin: e.origin },
      });
    });
  }

  resolveEscalation(id: string, resolution: string): void {
    this.transaction(() => {
      this.db.run(
        "UPDATE escalations SET state = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?",
        [resolution, Date.now(), id],
      );
      this.appendEvent({ type: "escalation.resolved", payload: { escalationId: id, resolution } });
    });
  }

  openEscalations(): EscalationRow[] {
    return this.db
      .query<EscalationRow, []>("SELECT * FROM escalations WHERE state = 'open'")
      .all();
  }

  // ── pending actions / handshakes (Spec 09 §2.11) ──────────────────────────────────────

  createPendingAction(p: PendingActionRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO pending_actions (id, task_id, user_id, action_class, payload_json, prompt_text,
                                      posted_msg_id, status, decided_by, created_at, decided_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id, p.task_id, p.user_id, p.action_class, p.payload_json, p.prompt_text,
          p.posted_msg_id, p.status, p.decided_by, p.created_at, p.decided_at, p.expires_at,
        ],
      );
      this.appendEvent({
        type: "handshake.posted",
        task_id: p.task_id,
        user_id: p.user_id,
        payload: { pendingActionId: p.id, actionClass: p.action_class },
      });
    });
  }

  setPendingActionStatus(
    id: string,
    status: PendingActionRow["status"],
    decidedBy?: string,
  ): void {
    const evType =
      status === "approved"
        ? "handshake.approved"
        : status === "rejected"
          ? "handshake.rejected"
          : status === "executed"
            ? "handshake.executed"
            : status === "expired"
              ? "handshake.expired"
              : "handshake.posted";
    this.transaction(() => {
      this.db.run(
        "UPDATE pending_actions SET status = ?, decided_by = COALESCE(?, decided_by), decided_at = ? WHERE id = ?",
        [status, decidedBy ?? null, Date.now(), id],
      );
      this.appendEvent({ type: evType, payload: { pendingActionId: id, status } });
    });
  }

  pendingActions(): PendingActionRow[] {
    return this.db
      .query<PendingActionRow, []>("SELECT * FROM pending_actions WHERE status = 'pending'")
      .all();
  }

  // ── awaiting replies (Spec 05 §4.1) ───────────────────────────────────────────────────

  createAwaitingReply(a: AwaitingReplyRow): void {
    this.db.run(
      `INSERT INTO awaiting_replies (id, kind, task_id, pending_action_id, channel_id, user_id,
                                     prompt_message_id, buttons_custom_id_prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id, a.kind, a.task_id, a.pending_action_id, a.channel_id, a.user_id,
        a.prompt_message_id, a.buttons_custom_id_prefix, a.created_at, a.expires_at,
      ],
    );
  }

  deleteAwaitingReply(id: string): void {
    this.db.run("DELETE FROM awaiting_replies WHERE id = ?", [id]);
  }

  openAwaitingReplies(): AwaitingReplyRow[] {
    return this.db.query<AwaitingReplyRow, []>("SELECT * FROM awaiting_replies").all();
  }

  // ── gate + learned model (Spec 09 §2.7/§2.13/§5) ──────────────────────────────────────

  logGateOutcome(g: GateOutcomeRow): void {
    this.transaction(() => {
      this.db.run(
        `INSERT INTO gate_outcomes (id, node_id, worker_id, attempt, checks_passed, review_passed,
                                    review_tier, reviewer_id, verdict, feedback_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.id, g.node_id, g.worker_id, g.attempt, g.checks_passed, g.review_passed,
          g.review_tier, g.reviewer_id, g.verdict, g.feedback_json, g.created_at,
        ],
      );
      this.appendEvent({
        type: g.verdict === "pass" ? "gate.pass" : "gate.fail",
        node_id: g.node_id,
        worker_id: g.worker_id,
        payload: { attempt: g.attempt, verdict: g.verdict },
      });
    });
  }

  logOutcome(o: WorkerOutcomeRow): void {
    this.db.run(
      `INSERT INTO worker_outcomes (id, user_id, task_id, node_id, worker_id, harness, model,
                                    task_type, effort, passed, retries, drift_events, scope_violations,
                                    turns, tool_calls, wall_clock_s, diff_added, diff_removed,
                                    files_changed, tokens_in, tokens_out, aborted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        o.id, o.user_id, o.task_id, o.node_id, o.worker_id, o.harness, o.model,
        o.task_type, o.effort, o.passed, o.retries, o.drift_events, o.scope_violations,
        o.turns, o.tool_calls, o.wall_clock_s, o.diff_added, o.diff_removed,
        o.files_changed, o.tokens_in, o.tokens_out, o.aborted, o.created_at,
      ],
    );
  }

  /** The STAFF capability ranking query (Spec 09 §5.2). */
  rankWorkers(taskType: string, since: number, minSamples: number): RankedWorker[] {
    return this.db
      .query<RankedWorker, [string, number, number]>(
        `SELECT harness, model,
                COUNT(*)              AS samples,
                AVG(passed)           AS pass_rate,
                AVG(retries)          AS avg_retries,
                AVG(drift_events)     AS avg_drift,
                AVG(wall_clock_s)     AS avg_wall_s,
                AVG(turns)            AS avg_turns,
                SUM(scope_violations) AS total_scope_viol
         FROM worker_outcomes
         WHERE task_type = ? AND created_at > ?
         GROUP BY harness, model
         HAVING samples >= ?
         ORDER BY pass_rate DESC, avg_retries ASC, avg_wall_s ASC`,
      )
      .all(taskType, since, minSamples);
  }

  /** Count supervise.look events for a worker from the JSONL log (Spec 09 §5.1). */
  countLooks(workerId: string): number {
    return readEvents(this.opts.eventsDir, { workerId, types: ["supervise.look"] }).length;
  }

  // ── memory mirror (Spec 09 §2.12) ─────────────────────────────────────────────────────

  upsertMemoryIndex(rows: MemoryIndexRow[], links: MemoryLinkRow[]): void {
    this.transaction(() => {
      // The mirror is rebuildable; replace wholesale for simplicity + correctness.
      this.db.run("DELETE FROM memory_links");
      this.db.run("DELETE FROM memory_index");
      for (const r of rows) {
        this.db.run(
          `INSERT INTO memory_index (id, path, title, kind, tags_json, summary, content_hash, mtime, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.id, r.path, r.title, r.kind, r.tags_json, r.summary, r.content_hash, r.mtime, r.updated_at],
        );
      }
      for (const l of links) {
        this.db.run("INSERT OR IGNORE INTO memory_links (src_id, dst_path) VALUES (?, ?)", [
          l.src_id, l.dst_path,
        ]);
      }
      this.appendEvent({ type: "memory.indexed", payload: { nodes: rows.length, links: links.length } });
    });
  }

  searchMemory(kind?: string): MemoryIndexRow[] {
    if (kind) {
      return this.db
        .query<MemoryIndexRow, [string]>("SELECT * FROM memory_index WHERE kind = ?")
        .all(kind);
    }
    return this.db.query<MemoryIndexRow, []>("SELECT * FROM memory_index").all();
  }
}

/** Convenience factory: build a store from resolved paths + config (Spec 01/09). */
export function createStore(paths: Paths, config: Config): SqliteStore {
  return new SqliteStore({
    dbPath: paths.db,
    eventsDir: paths.eventsDir,
    maxFileBytes: config.events.max_file_mb * 1024 * 1024,
  });
}

/** Open the DB read-only for the CLI (WAL snapshot reader, Spec 09 §7). */
export function openReadOnly(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Compile-time check: SqliteStore satisfies the frozen Store contract. */
const _storeCheck: new (o: StoreOptions) => Store = SqliteStore;
void _storeCheck;

export type { Store } from "../types.ts";
