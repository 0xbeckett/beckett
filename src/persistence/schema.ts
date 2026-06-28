/**
 * Beckett — SQLite schema as versioned migrations (`src/persistence/schema.ts`)
 * =======================================================================================
 * The full DDL from Spec 09 §2, expressed as a forward-only, checksum-locked migration list
 * (Spec 09 §6). Each migration is a numbered SQL string; the runner in `store.ts` applies
 * them in order inside a transaction each and records `schema_migrations` rows.
 *
 * Connection PRAGMAs (WAL, synchronous, foreign_keys, busy_timeout, auto_vacuum) are set at
 * OPEN time in `store.ts` (they must run outside a transaction), NOT here — Spec 09 §1.1.
 *
 * Enum CHECK constraints below mirror the Spec 02/04 unions exactly, so the DB rejects an
 * out-of-canon state rather than silently storing garbage (Spec 09 §2 conventions).
 *
 * Note: `awaiting_replies` (Spec 05 §4.1 — "Persisted in SQLite (Spec 09)") is included here
 * so a restart can re-bind outstanding clarify/handshake/escalation questions; Spec 09's DDL
 * list narrates it under recovery but does not print the table — implemented faithfully.
 */

import { createHash } from "node:crypto";
import type { MigrationFile } from "../types.ts";

const MIGRATION_001_INITIAL = /* sql */ `
-- ── users (multiplayer-ready attribution, Spec 09 §2.1) ──
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  discord_id    TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  is_owner      INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
  chattiness    TEXT NOT NULL DEFAULT 'sparse' CHECK (chattiness IN ('sparse','normal')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_users_discord ON users(discord_id);

-- ── tasks (TASK FSM, Spec 09 §2.2) ──
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel_id    TEXT NOT NULL,
  origin_msg_id TEXT,
  state         TEXT NOT NULL CHECK (state IN (
                  'INTAKE','CLARIFY','PLAN','STAFF','EXECUTING',
                  'ESCALATED','DELIVERING','DELIVERED','ABORTED','FAILED')),
  task_type     TEXT,
  prompt        TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  project_branch TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_state   ON tasks(state);
CREATE INDEX idx_tasks_user    ON tasks(user_id);
CREATE INDEX idx_tasks_channel ON tasks(channel_id);

-- ── nodes (NODE FSM, Spec 09 §2.3) ──
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN (
                  'BLOCKED','READY','DISPATCHED','SUPERVISING','NUDGING','PAUSED',
                  'INTEGRATING','REVIEWING','GATING','RE_DISPATCH','NODE_DONE','NODE_FAILED')),
  scope_json    TEXT NOT NULL,
  branch        TEXT NOT NULL,
  network       INTEGER NOT NULL DEFAULT 0 CHECK (network IN (0,1)),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_reviewer_id TEXT,
  feedback_json TEXT NOT NULL DEFAULT '[]',
  critical_path_rank INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_nodes_task       ON nodes(task_id);
CREATE INDEX idx_nodes_state      ON nodes(state);
CREATE INDEX idx_nodes_task_state ON nodes(task_id, state);

-- ── node_deps (DAG edges, Spec 09 §2.4) ──
CREATE TABLE node_deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, depends_on_id),
  CHECK (node_id <> depends_on_id)
);
CREATE INDEX idx_deps_node       ON node_deps(node_id);
CREATE INDEX idx_deps_depends_on ON node_deps(depends_on_id);

-- ── workers (one row per harness instance, Spec 09 §2.5) ──
CREATE TABLE workers (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  harness       TEXT NOT NULL CHECK (harness IN ('claude','codex')),
  driver        TEXT NOT NULL CHECK (driver IN ('claude-cli-stream','codex-exec-oneshot')),
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL CHECK (effort IN ('low','medium','high','xhigh')),
  session_id    TEXT,
  workspace     TEXT NOT NULL,
  branch        TEXT NOT NULL,
  is_resume     INTEGER NOT NULL DEFAULT 0 CHECK (is_resume IN (0,1)),
  state         TEXT NOT NULL CHECK (state IN (
                  'spawning','running','nudging','paused','review','done','failed','aborted')),
  turns         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
  tokens_cache_create INTEGER NOT NULL DEFAULT 0,
  diff_added    INTEGER NOT NULL DEFAULT 0,
  diff_removed  INTEGER NOT NULL DEFAULT 0,
  diff_files    INTEGER NOT NULL DEFAULT 0,
  usd_estimate  REAL,
  scope_violations INTEGER NOT NULL DEFAULT 0,
  stream_offset_bytes INTEGER NOT NULL DEFAULT 0,
  pid           INTEGER,
  spawned_at    INTEGER NOT NULL,
  last_activity_ts INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_workers_node    ON workers(node_id);
CREATE INDEX idx_workers_task    ON workers(task_id);
CREATE INDEX idx_workers_state   ON workers(state);
CREATE INDEX idx_workers_session ON workers(session_id);

-- ── criteria (1:1 with a node, Spec 09 §2.6) ──
CREATE TABLE criteria (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
  nl_criteria   TEXT NOT NULL,
  checks_json   TEXT NOT NULL DEFAULT '[]',
  interface_contract TEXT,
  done_schema_path TEXT,
  created_at    INTEGER NOT NULL
);

-- ── gate_outcomes (per-GATE decision audit, Spec 09 §2.7) ──
CREATE TABLE gate_outcomes (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  worker_id     TEXT REFERENCES workers(id) ON DELETE SET NULL,
  attempt       INTEGER NOT NULL,
  checks_passed INTEGER NOT NULL CHECK (checks_passed IN (0,1)),
  review_passed INTEGER NOT NULL CHECK (review_passed IN (0,1)),
  review_tier   TEXT NOT NULL CHECK (review_tier IN ('self','fresh','cross','panel')),
  reviewer_id   TEXT,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  feedback_json TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_gate_node ON gate_outcomes(node_id);

-- ── check_ins (Opus self-scheduled looks, Spec 09 §2.8) ──
CREATE TABLE check_ins (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_by_decision_id TEXT,
  after_turns   INTEGER,
  after_secs    INTEGER,
  at_turn_abs   INTEGER,
  turns_at_create INTEGER NOT NULL,
  fire_at       INTEGER,
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','fired','cancelled','superseded')),
  created_at    INTEGER NOT NULL,
  CHECK (after_turns IS NOT NULL OR after_secs IS NOT NULL OR at_turn_abs IS NOT NULL)
);
CREATE INDEX idx_checkins_pending ON check_ins(worker_id, state);

-- ── nudges (persisted nudge queue, Spec 09 §2.9) ──
CREATE TABLE nudges (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  text          TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('opus_decision','cli','discord','ask_plan')),
  status        TEXT NOT NULL CHECK (status IN ('queued','delivered','failed')),
  fail_reason   TEXT,
  enqueued_at   INTEGER NOT NULL,
  delivered_at  INTEGER
);
CREATE INDEX idx_nudges_drain ON nudges(worker_id, status);

-- ── escalations (the three points, Spec 09 §2.10) ──
CREATE TABLE escalations (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id       TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('CLARIFY','SUPERVISE','GATE')),
  reason        TEXT NOT NULL,
  options_json  TEXT NOT NULL DEFAULT '[]',
  posted_msg_id TEXT,
  state         TEXT NOT NULL CHECK (state IN ('open','resolved')),
  resolution    TEXT,
  raised_at     INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_escalations_open ON escalations(state, task_id);

-- ── pending_actions (delivery handshakes, Spec 09 §2.11) ──
CREATE TABLE pending_actions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_class  TEXT NOT NULL CHECK (action_class IN (
                  'merge_pr','send_email','force_push','external_post','other')),
  payload_json  TEXT NOT NULL,
  prompt_text   TEXT NOT NULL,
  posted_msg_id TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  expires_at    INTEGER
);
CREATE INDEX idx_pending_status ON pending_actions(status, task_id);

-- ── awaiting_replies (outstanding questions, Spec 05 §4.1 / Spec 09 recovery) ──
CREATE TABLE awaiting_replies (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('clarify','handshake','self_halt','escalation_choice')),
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  pending_action_id TEXT REFERENCES pending_actions(id) ON DELETE SET NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prompt_message_id TEXT NOT NULL,
  buttons_custom_id_prefix TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_awaiting_channel_user ON awaiting_replies(channel_id, user_id);
CREATE INDEX idx_awaiting_prompt       ON awaiting_replies(prompt_message_id);

-- ── memory_index + memory_links (SQL mirror of the md KG, Spec 09 §2.12) ──
CREATE TABLE memory_index (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  summary       TEXT,
  content_hash  TEXT NOT NULL,
  mtime         INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_memory_kind ON memory_index(kind);
CREATE INDEX idx_memory_tags ON memory_index(tags_json);

CREATE TABLE memory_links (
  src_id        TEXT NOT NULL REFERENCES memory_index(id) ON DELETE CASCADE,
  dst_path      TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_path)
);
CREATE INDEX idx_memlinks_dst ON memory_links(dst_path);

-- ── worker_outcomes (learned-model log; NO FK cascade — outlives tasks, Spec 09 §2.13) ──
CREATE TABLE worker_outcomes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  task_id       TEXT,
  node_id       TEXT,
  worker_id     TEXT,
  harness       TEXT NOT NULL CHECK (harness IN ('claude','codex')),
  model         TEXT NOT NULL,
  task_type     TEXT NOT NULL,
  effort        TEXT NOT NULL CHECK (effort IN ('low','medium','high','xhigh')),
  passed        INTEGER NOT NULL CHECK (passed IN (0,1)),
  retries       INTEGER NOT NULL DEFAULT 0,
  drift_events  INTEGER NOT NULL DEFAULT 0,
  scope_violations INTEGER NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  wall_clock_s  INTEGER NOT NULL DEFAULT 0,
  diff_added    INTEGER NOT NULL DEFAULT 0,
  diff_removed  INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  aborted       INTEGER NOT NULL DEFAULT 0 CHECK (aborted IN (0,1)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_outcomes_key  ON worker_outcomes(harness, model, task_type);
CREATE INDEX idx_outcomes_time ON worker_outcomes(created_at);
`;

/** Raw (version, name, sql) tuples in ascending order. Append new migrations; never edit. */
const RAW_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "initial", sql: MIGRATION_001_INITIAL },
];

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** The compiled migration list with checksums (Spec 09 §6). Consumed by the store runner. */
export const MIGRATIONS: MigrationFile[] = RAW_MIGRATIONS.map((m) => ({
  version: m.version,
  name: m.name,
  sql: m.sql,
  checksum: checksum(m.sql),
}));

/** The head schema version (highest migration). */
export const SCHEMA_HEAD: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
