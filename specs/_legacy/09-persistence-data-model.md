# Beckett — Spec 09: Persistence & Data Model

> **The durable spine.** Two stores, one contract: **SQLite is current state** (queryable, mutable,
> the source of truth the daemon and CLI read) and an **append-only JSONL event log is immutable
> history** (the audit trail, replay source, and the raw feed behind the learned-worker model). This
> spec owns the full SQLite DDL, the JSONL event schema + taxonomy, the durability/recovery protocol
> that delivers the Spec 00 guarantee (**lose ≤ 1 turn**), the learned-model outcome log, the
> migration approach, the concurrency/transaction model, and the data lifecycle.
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Anchor: [Spec 00 — Overview & Canon](./00-overview.md). Research & rationale:
> [`../my-docs/open-questions.md`](../my-docs/open-questions.md) (esp. §A3 persistence, §A4 durability,
> §G1 learned model, §D4 nudge queue).

---

## 0. Scope & what it defers

This document owns **the bytes on disk**: every table, every column, the event-record shape, the
recovery algorithm, and the migration/concurrency/retention machinery. It does **not** own the *logic*
that produces those rows — only their persisted form.

| Concern | Owner |
|---|---|
| SQLite DDL, JSONL schema, durability/recovery protocol, migrations, retention | **This spec (09)** |
| State *semantics* (what each enum value means, transitions) | [Spec 04 — State Machine](./04-state-machine.md) |
| When to nudge/pause/abort; smoke-alarms; check-in scheduling logic | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| `Worker`/driver fields, spawn/steer/abort, telemetry derivation | [Spec 02 — Worker Abstraction](./02-worker-abstraction.md) |
| Memory file format (md + frontmatter + wikilinks); `memory_index` is only a **mirror** for query | [Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md) |
| Acceptance-criteria *format*, review tiering, GATE pass/fail logic | [Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md) |
| Handshake/action-class *policy* (`pending_actions` is just the persisted record) | [Spec 07 — Identity & Agency](./07-identity-agency.md) |
| DB open mode, WAL, busy_timeout, IPC channel, process model | [Spec 01 — Architecture](./01-architecture.md) |
| CLI read paths over SQLite + JSONL | [Spec 10 — CLI](./10-cli.md) |

Canon honored (Spec 00 §4): **SQLite (state) + JSONL event log (audit)**; durability = persist
`session_id` + node state on change, resume on restart, **lose ≤ 1 turn**; **`user_id` on every
task/nudge/message** (multiplayer design-for, build-later); **no USD ledger** (subscriptions —
tokens stored for telemetry/rate-limit only, never a budget); learned model = **log every gate
outcome from day one**, adaptive staffing later.

---

## 1. Storage map

```
~/.beckett/
  beckett.db            # SQLite (WAL): all tables below — the queryable current state
  beckett.db-wal        # WAL sidecar (auto)              ── single-writer daemon, RO CLI readers
  beckett.db-shm        # shared-memory index (auto)
  events/
    2026-06-27.jsonl    # append-only audit, one file per UTC day (rotation §3.5)
    2026-06-28.jsonl
    …
  memory/               # the markdown KG (Spec 08) — SOURCE; memory_index mirrors it for SQL query
```

- **SQLite** = mutable current state. Every row is the *latest* truth; updates overwrite in place.
- **JSONL** = immutable history. Append-only, never mutated, never deleted in place (only whole files
  rotated/archived). A row in SQLite can be reconstructed by replaying its events; the reverse is not
  true (SQLite discards intermediate states).
- **Driver/library:** the daemon uses **`bun:sqlite`** (bundled with bun 1.3.x on loom-desk, zero
  native-build step) as the primary binding; `better-sqlite3` is the drop-in fallback if a `bun:sqlite`
  API gap appears (both are synchronous, same SQL). All examples below are binding-agnostic SQL +
  thin TS wrappers. ⚠️ Pin the choice in Spec 12 setup; the DAL (§8) is written so the swap is one file.

### 1.1 Connection PRAGMAs (set once at open, Spec 01 §5.1 step 3)

```sql
PRAGMA journal_mode = WAL;        -- concurrent RO readers (CLI) never block the single writer (daemon)
PRAGMA synchronous  = NORMAL;     -- WAL-safe durability; fsync at checkpoint, not every commit
PRAGMA foreign_keys = ON;         -- enforce the FK graph below
PRAGMA busy_timeout = 5000;       -- 5s: ride out transient contention instead of erroring (Spec 01 §6)
PRAGMA wal_autocheckpoint = 1000; -- pages between automatic checkpoints
```

WAL is the canonical choice (Spec 01 §6): the daemon is the **sole writer**; the `beckett` CLI opens
the same file **read-only** and reads consistent WAL snapshots without ever locking out the daemon. See
§7 for the full concurrency model.

---

## 2. SQLite schema (full DDL)

Conventions:
- **IDs** are beckett-minted opaque TEXT (`task_4f3a`, `node_…`, `wk_7f3a`), not autoincrement — they
  are referenced across the JSONL log and CLI, and must be stable + URL-safe.
- **Timestamps** are `INTEGER` epoch **milliseconds** (matches `Date.now()` used throughout Specs 02–04).
- **Enums** are stored as `TEXT` with a `CHECK` constraint enumerating the exact Spec 02/04 values, so
  the DB rejects an out-of-canon state rather than silently storing garbage.
- **Booleans** are `INTEGER` `0|1` with a `CHECK (col IN (0,1))`.
- **JSON blobs** (DAG-adjacent structures, arrays) are `TEXT` holding JSON; columns named `*_json`.
- Every user-attributable table carries `user_id` from day one (Spec 00 multiplayer-ready).

### 2.1 `users` — multiplayer-ready attribution

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- beckett user id; v1 = single row, but FK target everywhere
  discord_id    TEXT UNIQUE,                 -- Discord snowflake of the human (intake attribution, Spec 05)
  display_name  TEXT NOT NULL,
  is_owner      INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),  -- Jason = 1 in v1
  chattiness    TEXT NOT NULL DEFAULT 'sparse' CHECK (chattiness IN ('sparse','normal')), -- per-user (Spec 05)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_users_discord ON users(discord_id);
```

> v1 inserts exactly one owner row at setup. The point of the table existing now is that every other
> table can carry a real `user_id` FK from day one — multiplayer becomes a fast-follow, not a migration
> (Spec 00; open-questions E4).

### 2.2 `tasks` — the TASK FSM record (Spec 04 §2)

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,            -- task_…
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel_id    TEXT NOT NULL,               -- Discord origin channel (ambient model, Spec 05)
  origin_msg_id TEXT,                        -- the mention message id (for reply threading / dedupe)
  state         TEXT NOT NULL CHECK (state IN (
                  'INTAKE','CLARIFY','PLAN','STAFF','EXECUTING',
                  'ESCALATED','DELIVERING','DELIVERED','ABORTED','FAILED')),
  task_type     TEXT,                        -- classifier label (code|email|research|ops|…) → learned model
  prompt        TEXT NOT NULL,               -- original request text
  assumptions_json TEXT NOT NULL DEFAULT '[]', -- reversible-ambiguity choices surfaced at DELIVER (Spec 04 §7)
  project_branch TEXT,                       -- Dag.projectBranch — integration target (Spec 04 §6.5)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL             -- bumped on EVERY persisted transition (durability invariant)
);
CREATE INDEX idx_tasks_state    ON tasks(state);     -- recovery: "all non-terminal tasks"
CREATE INDEX idx_tasks_user     ON tasks(user_id);
CREATE INDEX idx_tasks_channel  ON tasks(channel_id);
```

The `Dag` structure (Spec 04 §2) is **decomposed into rows**, not stored as one JSON blob: `nodes` →
`nodes` table, edges → `node_deps`, criteria → `criteria`. This keeps the DAG queryable (the executor's
ready-set scan and the CLI both run SQL, not in-app JSON walks) and lets a single node update be a
one-row write (durability granularity).

### 2.3 `nodes` — the NODE FSM record (Spec 04 §2)

```sql
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,            -- node_…
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,  -- denormalized for outcome queries
  title         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN (
                  'BLOCKED','READY','DISPATCHED','SUPERVISING','NUDGING','PAUSED',
                  'INTEGRATING','REVIEWING','GATING','RE_DISPATCH','NODE_DONE','NODE_FAILED')),
  scope_json    TEXT NOT NULL,               -- FileScope {ownedGlobs, readGlobs, description} (Spec 02 §2)
  branch        TEXT NOT NULL,               -- beckett/<task>/<node> worktree branch (Spec 02 §8.1)
  network       INTEGER NOT NULL DEFAULT 0 CHECK (network IN (0,1)),  -- envelope.network opt-in (Spec 02 §9)
  attempts      INTEGER NOT NULL DEFAULT 0,  -- re-dispatch counter; escalate when > MAX_RETRIES (=3)
  last_reviewer_id TEXT,                      -- resume-vs-fresh reviewer decisioning (Spec 04 §8 / Spec 11)
  feedback_json TEXT NOT NULL DEFAULT '[]',  -- ReviewerFeedback[] threaded across retries (Spec 04 §8.2)
  critical_path_rank INTEGER,                 -- scheduler ordering hint (Spec 04 §6.2 byCriticalPathDesc)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_nodes_task   ON nodes(task_id);
CREATE INDEX idx_nodes_state  ON nodes(state);        -- executor ready-set scan + recovery
CREATE INDEX idx_nodes_task_state ON nodes(task_id, state);
```

### 2.4 `node_deps` — the DAG edges

```sql
CREATE TABLE node_deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,  -- the dependent
  depends_on_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,  -- the upstream that must be NODE_DONE
  PRIMARY KEY (node_id, depends_on_id),
  CHECK (node_id <> depends_on_id)            -- no self-edge; acyclicity enforced at PLAN (Spec 04 §6.3)
);
CREATE INDEX idx_deps_node       ON node_deps(node_id);        -- "what does this node wait on?"
CREATE INDEX idx_deps_depends_on ON node_deps(depends_on_id);  -- "who unblocks when I finish?" (Spec 04 §6.1)
```

> Edge table (not an array on `nodes`) so the executor's two hot queries are plain indexed SQL:
> *readiness* = `NOT EXISTS (SELECT 1 FROM node_deps d JOIN nodes u ON u.id=d.depends_on_id WHERE
> d.node_id=? AND u.state <> 'NODE_DONE')`, and *unblock-on-done* = `SELECT node_id FROM node_deps
> WHERE depends_on_id=?`. Cycle detection (Kahn) runs over this table at PLAN-validation (Spec 04 §6.3).

### 2.5 `workers` — one row per harness instance (Spec 02 §2)

```sql
CREATE TABLE workers (
  id            TEXT PRIMARY KEY,            -- wk_7f3a (beckett-assigned, NOT the harness session id)
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  harness       TEXT NOT NULL CHECK (harness IN ('claude','codex')),
  driver        TEXT NOT NULL CHECK (driver IN ('claude-cli-stream','codex-exec-oneshot')),
  model         TEXT NOT NULL,               -- exact launch model id; SOURCE OF TRUTH for codex (Spec 02 §2)
  effort        TEXT NOT NULL CHECK (effort IN ('low','medium','high','xhigh')),

  -- ── DURABILITY-CRITICAL: persisted the instant it is known, before any stream output (§4) ──
  session_id    TEXT,                        -- claude session_id / codex thread_id; NULL only while spawning
  workspace     TEXT NOT NULL,               -- absolute worktree path (cwd; resume is cwd-scoped, Spec 02 §4.5)
  branch        TEXT NOT NULL,
  is_resume     INTEGER NOT NULL DEFAULT 0 CHECK (is_resume IN (0,1)),  -- spawned fresh vs re-dispatched

  state         TEXT NOT NULL CHECK (state IN (
                  'spawning','running','nudging','paused','review','done','failed','aborted')),

  -- ── telemetry snapshot (WorkerSpend, Spec 02 §2; updated from the stream, NOT a budget) ──
  turns         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
  tokens_cache_create INTEGER NOT NULL DEFAULT 0,
  diff_added    INTEGER NOT NULL DEFAULT 0,
  diff_removed  INTEGER NOT NULL DEFAULT 0,
  diff_files    INTEGER NOT NULL DEFAULT 0,
  usd_estimate  REAL,                        -- claude informational only; NULL for codex (Spec 00: no $ ledger)

  -- ── supervise bookkeeping (Spec 03 §1.3) ──
  scope_violations INTEGER NOT NULL DEFAULT 0,
  stream_offset_bytes INTEGER NOT NULL DEFAULT 0,  -- on-disk transcript offset for restart re-tail (Spec 03 §1.2)
  pid           INTEGER,                     -- live process pid (transient; for orphan reaping, Spec 04 §10.2)

  spawned_at    INTEGER NOT NULL,
  last_activity_ts INTEGER NOT NULL,         -- watchdog input (Spec 02 §9.3) + staleness alarm (Spec 03 A6)
  ended_at      INTEGER
);
CREATE INDEX idx_workers_node    ON workers(node_id);
CREATE INDEX idx_workers_task    ON workers(task_id);
CREATE INDEX idx_workers_state   ON workers(state);    -- recovery: non-terminal workers to re-attach
CREATE INDEX idx_workers_session ON workers(session_id);
```

> A node may have **several** worker rows over its life (initial dispatch + re-dispatches/resumes). The
> *current* live worker for a node is the most-recent non-terminal row; history rows feed the outcome
> log (§5). `nodes.workerId`/`sessionId` in Spec 04 are denormalized convenience pointers to the live
> row — kept in sync but the `workers` table is authoritative.

### 2.6 `criteria` — acceptance criteria per node (logic: Spec 11)

```sql
CREATE TABLE criteria (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,  -- 1:1 with a node
  nl_criteria   TEXT NOT NULL,               -- natural-language "done when…" for the reviewer (Spec 11)
  checks_json   TEXT NOT NULL DEFAULT '[]',  -- executable checks: [{cmd, expectExit}] tests/build/lint
  interface_contract TEXT,                    -- contract for parallel-node integration (Spec 04 §6.5)
  done_schema_path TEXT,                      -- JSON-schema file for the structured done-signal (Spec 02 §6)
  created_at    INTEGER NOT NULL
);
```

> Mandatory per node (Spec 00: "no node without a 'done'"). PLAN writes this row when it writes the
> node; T9's guard (Spec 04) rejects a DAG with a node missing criteria. The *format* of `checks_json`
> / `nl_criteria` and how GATE evaluates them is owned by Spec 11; this spec only persists them.

### 2.7 `gate_outcomes` — per-GATE decision audit (logic: Spec 11)

```sql
CREATE TABLE gate_outcomes (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  worker_id     TEXT REFERENCES workers(id) ON DELETE SET NULL,  -- the worker whose output was gated
  attempt       INTEGER NOT NULL,            -- which re-dispatch cycle (mirrors nodes.attempts at the time)
  checks_passed INTEGER NOT NULL CHECK (checks_passed IN (0,1)),  -- executable checks exit 0
  review_passed INTEGER NOT NULL CHECK (review_passed IN (0,1)),  -- reviewer verdict
  review_tier   TEXT NOT NULL CHECK (review_tier IN ('self','fresh')),  -- Spec 11 tiering
  reviewer_id   TEXT,                         -- worker id of a fresh reviewer, if any
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','fail')),       -- checks_passed AND review_passed
  feedback_json TEXT,                         -- ReviewerFeedback captured on fail (threaded into retry)
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_gate_node ON gate_outcomes(node_id);
```

> `gate_outcomes` is the **decision record** (one row per GATE evaluation, audit-grade). `worker_outcomes`
> (§5) is the **denormalized learned-model feed** (one row per finished worker, joining gate result +
> telemetry). They are distinct on purpose: the gate audit cascades away with its task; the learned
> model must outlive task retention (§5, §9).

### 2.8 `check_ins` — Opus self-scheduled looks (Spec 03 §3)

```sql
CREATE TABLE check_ins (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_by_decision_id TEXT,               -- the SuperviseDecision that scheduled it (Spec 03 §4.3)
  after_turns   INTEGER,                     -- relative turn trigger (nullable)
  after_secs    INTEGER,                     -- relative time trigger (nullable)
  at_turn_abs   INTEGER,                     -- absolute turn trigger (nullable; reschedule)
  turns_at_create INTEGER NOT NULL,          -- snapshot so after_turns is relative (Spec 03 §3.1)
  fire_at       INTEGER,                     -- precomputed epoch ms for after_secs/at-time (timer re-arm)
  reason        TEXT NOT NULL,               -- Opus's note to its future self
  state         TEXT NOT NULL CHECK (state IN ('pending','fired','cancelled','superseded')),
  created_at    INTEGER NOT NULL,
  CHECK (after_turns IS NOT NULL OR after_secs IS NOT NULL OR at_turn_abs IS NOT NULL)  -- ≥1 trigger (Spec 03 §3.1)
);
CREATE INDEX idx_checkins_pending ON check_ins(worker_id, state);  -- rearmOnRestart + checkOnTurn (Spec 03 §3.2)
```

### 2.9 `nudges` — the persisted nudge queue (Spec 03 §6; open-questions D4)

```sql
CREATE TABLE nudges (
  id            TEXT PRIMARY KEY,            -- nudgeId
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,  -- attribution (Spec 03 §6)
  text          TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('opus_decision','cli','discord','ask_plan')),
  status        TEXT NOT NULL CHECK (status IN ('queued','delivered','failed')),
  fail_reason   TEXT,                         -- e.g. 'worker_aborted' (never silently dropped, Spec 03 §6.2)
  enqueued_at   INTEGER NOT NULL,
  delivered_at  INTEGER
);
CREATE INDEX idx_nudges_drain ON nudges(worker_id, status);  -- db.queuedNudges(workerId): status='queued' FIFO
```

> **Persist-first** is the rule (Spec 03 §6.1): a nudge is written here with `status='queued'` *before*
> it is enqueued in memory, so a crash between the two never loses it. On restart `db.queuedNudges()`
> repopulates the in-memory FIFOs before any worker resumes (§4). Claude flips `queued→delivered` on the
> `--replay-user-messages` echo; Codex on the next `exec resume` (all pending joined into one resume).

### 2.10 `escalations` — the three escalation points (Spec 04 §9)

```sql
CREATE TABLE escalations (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id       TEXT REFERENCES nodes(id) ON DELETE SET NULL,  -- NULL for CLARIFY-origin
  origin        TEXT NOT NULL CHECK (origin IN ('CLARIFY','SUPERVISE','GATE')),
  reason        TEXT NOT NULL,               -- first-person account (pillar: owns its decisions)
  options_json  TEXT NOT NULL DEFAULT '[]',  -- EscalationOption[] "tried 3×, A/B/C" (Spec 11 format)
  posted_msg_id TEXT,                         -- Discord message awaiting reply (Spec 05)
  state         TEXT NOT NULL CHECK (state IN ('open','resolved')),
  resolution    TEXT,                         -- chosen option key + effect (resume|replan|decline|abort)
  raised_at     INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_escalations_open ON escalations(state, task_id);  -- recovery: re-bind open escalations
```

### 2.11 `pending_actions` — delivery handshakes (record only; policy: Spec 07)

```sql
CREATE TABLE pending_actions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_class  TEXT NOT NULL CHECK (action_class IN (
                  'merge_pr','send_email','force_push','external_post','other')),  -- irreversible classes (Spec 07)
  payload_json  TEXT NOT NULL,               -- the staged irreversible op: {pr_url}|{draft_id,to}|…
  prompt_text   TEXT NOT NULL,               -- the handshake question ("PR's up — review or merge?")
  posted_msg_id TEXT,                         -- Discord message carrying the handshake (Spec 05)
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  expires_at    INTEGER                       -- optional TTL; expiry → status='expired' (never auto-acts)
);
CREATE INDEX idx_pending_status ON pending_actions(status, task_id);
```

> A handshake is the gate on every **irreversible/outbound** step (Spec 00 agency boundary: reversible
> work is free; merge/send asks). This table persists the *staged* action so a restart re-surfaces the
> pending question rather than silently dropping or silently executing it. The *decision policy*
> (action classes, what's always-ask) is Spec 07; this spec only guarantees durable record + that
> `expired` never implies executed.

### 2.12 `memory_index` — SQL mirror of the markdown KG (source: Spec 08)

```sql
CREATE TABLE memory_index (
  id            TEXT PRIMARY KEY,            -- stable slug/path-derived id
  path          TEXT NOT NULL UNIQUE,        -- relative path under ~/.beckett/memory/ (the SOURCE of truth)
  title         TEXT NOT NULL,               -- frontmatter title
  kind          TEXT NOT NULL,               -- frontmatter type: person|project|env|worker_note|pref|…
  tags_json     TEXT NOT NULL DEFAULT '[]',  -- frontmatter tags
  summary       TEXT,                         -- one-line index entry (mirrors MEMORY.md line)
  content_hash  TEXT NOT NULL,               -- detect drift between the md file and this mirror
  mtime         INTEGER NOT NULL,            -- file mtime; reindex when it changes
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_memory_kind ON memory_index(kind);
CREATE INDEX idx_memory_tags ON memory_index(tags_json);   -- coarse; FTS optional (§ note)

-- wikilink edges between memory files (the [[link]] graph), mirrored for graph queries
CREATE TABLE memory_links (
  src_id        TEXT NOT NULL REFERENCES memory_index(id) ON DELETE CASCADE,
  dst_path      TEXT NOT NULL,               -- link target path (may be unresolved → dangling link report)
  PRIMARY KEY (src_id, dst_path)
);
CREATE INDEX idx_memlinks_dst ON memory_links(dst_path);
```

> **The markdown files under `~/.beckett/memory/` remain the source of truth** (Spec 08); this table is
> a derived, rebuildable **mirror** so the brain/CLI can run `SELECT … WHERE kind='worker_note'` instead
> of grepping files. It is regenerated by a reindex pass that walks the md tree (on file change /
> daemon start). `content_hash`/`mtime` detect staleness. Dropping and rebuilding this table is always
> safe — it holds no original data. Full-text search (FTS5 virtual table over `summary`+body) is an
> optional later add; ⚠️ not in v1 (kept out to keep the mirror trivially rebuildable).

### 2.13 `worker_outcomes` — the learned-model log (Spec 00 §4 learned model; logic: Spec 11)

```sql
CREATE TABLE worker_outcomes (
  id            TEXT PRIMARY KEY,
  -- ── attribution (denormalized so the row SURVIVES task retention pruning — §9) ──
  user_id       TEXT,                        -- NOT a hard FK (survives user deletion); informational
  task_id       TEXT,                        -- denormalized id only, no FK cascade (§9)
  node_id       TEXT,
  worker_id     TEXT,

  -- ── the capability-table key (Spec 00 glossary; Spec 06 STAFF) ──
  harness       TEXT NOT NULL CHECK (harness IN ('claude','codex')),
  model         TEXT NOT NULL,
  task_type     TEXT NOT NULL,               -- copied from tasks.task_type (code|email|research|ops|…)
  effort        TEXT NOT NULL CHECK (effort IN ('low','medium','high','xhigh')),

  -- ── the outcome (written at GATE — Spec 11 — for the worker that produced the gated work) ──
  passed        INTEGER NOT NULL CHECK (passed IN (0,1)),  -- did this worker's work pass GATE?
  retries       INTEGER NOT NULL DEFAULT 0,  -- node.attempts at gate time
  drift_events  INTEGER NOT NULL DEFAULT 0,  -- smoke-alarms that fired a look on this worker (Spec 03)
  scope_violations INTEGER NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  wall_clock_s  INTEGER NOT NULL DEFAULT 0,  -- ended_at - spawned_at, seconds
  diff_added    INTEGER NOT NULL DEFAULT 0,
  diff_removed  INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  aborted       INTEGER NOT NULL DEFAULT 0 CHECK (aborted IN (0,1)),  -- ended via SUPERVISE abort?
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_outcomes_key  ON worker_outcomes(harness, model, task_type);  -- the STAFF lookup (§5.2)
CREATE INDEX idx_outcomes_time ON worker_outcomes(created_at);
```

> **No FK cascade by design.** This is the one table that must outlive everything else: completed tasks
> get pruned (§9) but the learned model is the accrued asset (open-questions G1 — "the most its-own-stuff
> asset"). Attribution columns are denormalized id strings, not FKs, so deleting a task never deletes
> its history here. Written **once per finished worker, at GATE** (§5.1).

### 2.14 `schema_migrations` — versioning (§6)

```sql
CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,         -- monotonic; forward-only
  name          TEXT NOT NULL,
  applied_at    INTEGER NOT NULL,
  checksum      TEXT NOT NULL                -- sha256 of the migration SQL; mismatch = refuse-to-start
);
```

---

## 3. The JSONL event log

### 3.1 Why two stores

SQLite answers *"what is the state right now?"* (and is mutated in place, so it forgets the path it
took). The JSONL log answers *"what happened, in order, immutably?"* — it is the audit trail Beckett
narrates from ("I aborted worker 3 because…"), the replay source if SQLite is ever lost or doubted, and
the raw firehose the learned model and `beckett tail`/`logs` (Spec 10) read. The two are written in the
**same transaction boundary** for state-changing operations (§3.4) so they never diverge by more than
the in-flight turn.

### 3.2 Record schema

One JSON object per line, newline-terminated, append-only. The schema is intentionally small and
stable (forward-compatible: unknown `type` is skipped, never fatal — matches the driver's JSONL
discipline, Spec 02 §7).

```ts
interface EventRecord {
  id:        string;            // ev_… (ULID — monotonic, sortable by time, collision-free across restarts)
  seq:       number;            // per-daemon-run monotonic counter (gap-detection within a file)
  ts:        number;            // epoch ms (UTC)
  type:      EventType;         // dotted taxonomy (§3.3)
  // ── correlation keys (any may be null depending on the event's scope) ──
  task_id:   string | null;
  node_id:   string | null;
  worker_id: string | null;
  user_id:   string | null;     // who, when human-attributable (intake/nudge/handshake) — multiplayer
  // ── the body: shape depends on `type`; never reshaped after write ──
  payload:   Record<string, unknown>;
}
```

A line is exactly: `JSON.stringify(record) + "\n"`. ULID `id` gives global ordering even across daily
file boundaries and daemon restarts; `seq` is a cheap within-run integrity check (a gap means a lost
write — surfaced by `beckett doctor`, Spec 10).

### 3.3 Event type taxonomy (dotted `domain.event`)

| Domain | Types | Emitted by / cross-ref |
|---|---|---|
| **daemon** | `daemon.start`, `daemon.ready`, `daemon.stop`, `daemon.recover` | Spec 01 §5 lifecycle |
| **task** | `task.created`, `task.state_changed`, `task.clarify_asked`, `task.clarify_answered`, `task.delivered` | Spec 04 TASK FSM |
| **plan** | `plan.built` (DAG+criteria), `plan.staffed` | Spec 04 T9/T11 |
| **node** | `node.created`, `node.state_changed`, `node.dep_done` | Spec 04 NODE FSM |
| **worker** | `worker.spawned`, `worker.session_captured`, `worker.turn_completed`, `worker.tool_call`, `worker.file_change`, `worker.finished` | Spec 02 §7 WorkerEvent |
| **supervise** | `supervise.smoke_alarm`, `supervise.checkin_scheduled`, `supervise.checkin_fired`, `supervise.look`, `supervise.decision`, `supervise.scope_violation` | Spec 03 (`decision` = §4.4 audit) |
| **nudge** | `nudge.enqueued`, `nudge.delivered`, `nudge.failed` | Spec 03 §6 |
| **integrate** | `integrate.merge_clean`, `integrate.merge_conflict`, `integrate.resolved`, `integrate.failed` | Spec 04 §6.5 |
| **gate** | `gate.review_complete`, `gate.pass`, `gate.fail` | Spec 11 |
| **escalation** | `escalation.raised`, `escalation.resolved` | Spec 04 §9 |
| **handshake** | `handshake.posted`, `handshake.approved`, `handshake.rejected`, `handshake.executed`, `handshake.expired` | Spec 07 |
| **identity** | `identity.branch_pushed`, `identity.pr_opened`, `identity.email_drafted`, `identity.email_sent` | Spec 07 |
| **rate_limit** | `rate_limit.hit`, `rate_limit.failover`, `rate_limit.backoff` | Spec 01 §2.2 |
| **memory** | `memory.indexed`, `memory.note_written` (learned-worker narrative) | Spec 08 |

> The log is **not** the per-line worker telemetry firehose. High-frequency stream lines (token deltas,
> every `assistant_text`) stay in the worker's own on-disk transcript (`~/.claude/projects/…` /
> `~/.codex/sessions/…`, Spec 02 §4.5/§5.4) — Beckett's event log records **boundary** events
> (`turn_completed`, `tool_call`, `file_change`, decisions), not deltas, so it stays narratable and
> small. The raw transcript is the system-of-record slice Opus reads on a look (Spec 03 §1.2).

### 3.4 Relationship to SQLite — written together

Every state-changing operation writes **both** stores inside one logical step:

```
beginTxn()
  UPDATE/INSERT the SQLite row(s)        ── new current state
  append EventRecord to today's JSONL    ── immutable history of the change
commitTxn()
```

The SQLite write is the transactional anchor (it's ACID); the JSONL append is fsync-batched and
ordered after the SQLite commit so the log never claims a change that SQLite rolled back. If the daemon
dies *between* the commit and the append, recovery (§4) detects it: SQLite is ahead by one event, which
is reconciled by re-deriving the missing event from state on next boot (the event log is allowed to
lag by ≤1 record — the same "≤1 turn" budget). The JSONL append-only file needs **no locking** (single
writer, O_APPEND) and is the durable fallback if a SQLite write is ever lost (Spec 01 §6).

### 3.5 Rotation & retention

- **Rotation:** one file per **UTC day**, `events/YYYY-MM-DD.jsonl`. The daemon opens/creates the
  current day's file at boot and rolls at the UTC midnight boundary (and on `SIGHUP`). Files are never
  rewritten in place.
- **Size guard:** if a single day exceeds `events.max_file_mb` (default **256 MB**), it rolls to
  `YYYY-MM-DD.NN.jsonl` (sequence suffix) — keeps individual files `tail`-able and `mmap`-able.
- **Retention:** files older than `events.retain_days` (default **90**) are **gzip-archived** to
  `events/archive/` (not deleted) — the audit trail is cheap and load-bearing for the learned model and
  "what did Beckett do last month?" recall. A separate `events.archive_retain_days` (default **365**)
  governs eventual deletion of the gzips. Both are config-tunable; defaults bias toward keeping history.
- See §9 for how this interlocks with SQLite pruning (the log is pruned **after** its rows have been
  distilled into `worker_outcomes`, never before).

---

## 4. Durability & recovery protocol

**The guarantee (Spec 00 §4):** on any crash, restart resumes in-flight work and **loses at most one
in-flight turn.** This is bought by persisting the right things at the right moments.

### 4.1 What is persisted WHEN (the durability ledger)

| Event | Persisted write | Why this moment |
|---|---|---|
| Worker process launched, `session_id` known | `workers.session_id` + `state='running'` + `node.sessionId` | **The instant** the init line / `thread.started` arrives, **before** consuming any stream output (Spec 02 §2, Spec 04 N4). This is what makes every worker resumable. |
| Any task transition | `tasks.state` + `tasks.updated_at` + `task.state_changed` event | Recovery reads task state as truth (Spec 04 §9 invariant: persist before acting). |
| Any node transition | `nodes.state` + `nodes.updated_at` + `node.state_changed` event | Granular: one node = one row write. |
| Turn boundary | `workers.turns`, token/diff counters, `last_activity_ts`, `stream_offset_bytes` | Counters/offset on change → restart re-tails from the offset, recomputing ≤1 turn (Spec 03 §1.3). |
| Nudge enqueued | `nudges` row `status='queued'` (**persist-first**, before in-mem) | A crash between persist and in-mem enqueue never drops it (Spec 03 §6.1). |
| Check-in scheduled | `check_ins` row `state='pending'` (before arming the timer) | Restart re-arms from the table (Spec 03 §3.2 `rearmOnRestart`). |
| Pending action staged | `pending_actions` row `status='pending'` | Restart re-surfaces the handshake; never auto-executes (Spec 07). |
| Escalation raised | `escalations` row `state='open'` | Restart re-binds to the posted Discord message. |
| Worker finished + gated | `worker_outcomes` row | Written at GATE so the learned model captures every finished worker (§5.1). |

> **Invariant (Spec 04 §4):** every state-changing transition **persists `state` + `updated_at` before
> taking the side-effecting action**; post-write side effects are idempotent on replay. That is what
> makes "re-run the phase after a crash" (INTEGRATE/REVIEW/GATE) safe.

### 4.2 Durable vs transient (recovery matrix)

| Datum | Durable? | Recovery |
|---|---|---|
| task/node/worker `state`, `session_id`, `attempts`, `feedback`, `assumptions`, criteria, DAG (rows) | **yes** (SQLite) | source of truth |
| queued nudges, pending check-ins, open escalations, pending actions | **yes** (SQLite) | reload + re-arm |
| `stream_offset_bytes` | **yes** (SQLite) | re-tail the transcript from the offset |
| live process handles, stdin pipes, tailer subscriptions, in-mem queues/timers | **no** | re-established (re-attach/re-arm) |
| in-flight turn output not yet on the worker's on-disk transcript | **no** | **lost (≤1 turn)** — re-driven by `--resume` |
| `memory_index` mirror, smoke-alarm counters | rebuildable | reindex / recompute from transcript |

### 4.3 The restart recovery algorithm (pseudocode)

This is the Spec 01 §5.1 step-6 hook, expanded; it composes Spec 04 §10's `recoverDag` with Spec 02's
resume mechanics and Spec 03's re-arming.

```ts
async function recover(db: Dal): Promise<void> {
  logEvent('daemon.recover', {});

  // 0. Reload the in-memory control structures from durable tables FIRST,
  //    so nothing is dropped before workers resume (Spec 03 §6.2 restart recovery).
  nudgeQueue.hydrate(db.allQueuedNudges());        // status='queued' → in-mem FIFOs
  scheduler.rearmCheckIns(db.pendingCheckIns());   // re-arm timers / turn-watchers (Spec 03 §3.2)

  // 1. Walk every NON-terminal task (Spec 04 §10.2).
  for (const task of db.tasksWhereStateNotIn(TASK_TERMINAL)) {
    switch (task.state) {
      case 'INTAKE': case 'CLARIFY': case 'ESCALATED':
        rebindAwaitingUser(task);                  // re-listen on Discord; no worker to resume
        break;
      case 'PLAN': case 'STAFF':
        replayCheapOpusStep(task);                 // idempotent — just re-run it
        break;
      case 'DELIVERING':
        replayDelivery(task);                      // idempotent on posted_msg_id
        break;
      case 'EXECUTING':
        await recoverDag(db.loadDag(task.id));     // the interesting case ↓
        break;
    }
  }
  logEvent('daemon.ready', {});
}

async function recoverDag(dag: Dag): Promise<void> {
  for (const node of dag.nodes) {
    switch (node.state) {
      // ── a worker was live: re-attach via the persisted session (Spec 02 §4.5/§5.4) ──
      case 'DISPATCHED': case 'SUPERVISING': case 'NUDGING': case 'PAUSED': {
        const w = db.liveWorkerForNode(node.id);          // the non-terminal workers row
        if (w?.session_id) {
          // claude --resume <session_id>  /  codex exec resume <thread_id>  — SAME cwd (the worktree)
          const driver = await reattachWorker(w);          // Spec 02: relaunch resume invocation
          driver.onEvent(e => supervisor.ingest(w, e));    // re-attach read-only tail (Spec 03 §1)
          supervisor.rearmAlarms(w, w.stream_offset_bytes);// recompute counters from the offset
          nudgeQueue.drainOnNextBoundary(w);               // un-drained nudges land next turn/resume
          db.setNodeState(node.id, 'SUPERVISING');         // re-enter supervise (Spec 04 N5)
        } else {
          db.setNodeState(node.id, 'READY');               // no session → let the executor re-dispatch
        }
        break;
      }
      // ── idempotent phases: no live worker → just re-run from the persisted branch (Spec 04 §10.2) ──
      case 'INTEGRATING': case 'REVIEWING': case 'GATING':
        replayNodePhase(node);                              // re-merge (guarded "merged?") / re-check / re-gate
        break;
      case 'RE_DISPATCH':
        db.setNodeState(node.id, 'READY');                 // executor re-dispatches with persisted feedback
        break;
      // BLOCKED / READY / NODE_DONE / NODE_FAILED: nothing — tick() handles them.
    }
  }
  reapOrphans(dag);    // any surviving worker process not re-adopted → kill (Spec 04 §10.2 ⚠️ Spec 01)
  tick(dag);           // resume scheduling — pure over persisted state (Spec 04 §6.2)
}
```

Key guarantees this delivers:
- **Every running worker is resumable** because `session_id` was persisted before any output (4.1) —
  so a worker mid-turn at crash loses only that turn (`--resume` continues from the last committed turn
  boundary).
- **No dropped steering:** queued nudges + pending check-ins are reloaded *before* any worker resumes.
- **No silent re-execution:** INTEGRATE/REVIEW/GATE are idempotent (git merge guarded by a "merged?"
  check; checks/gate are pure functions of branch+criteria), so re-running them is safe.
- **No auto-acting on irreversibles:** `pending_actions` re-surface as questions, never executed on
  recovery (Spec 07).

---

## 5. Learned-model outcome logging

The learned-worker model is **design-for, build-later** (Spec 00 §4; open-questions G1): v1 staffs from
a static capability table, but **logs every gate outcome from day one** so adaptive staffing can turn
on later from real data. The log lives in `worker_outcomes` (§2.13).

### 5.1 Written at every GATE (Spec 11)

When a node reaches GATE (Spec 04 N18/N19/N20, logic in Spec 11), Beckett writes one
`worker_outcomes` row for the worker whose output was gated, joining the GATE verdict with the worker's
final telemetry:

```ts
// called from the GATE step (Spec 11) for the worker that produced the gated work
function logWorkerOutcome(db: Dal, node: NodeRecord, worker: WorkerRow,
                          gate: GateOutcomeRow, task: TaskRow): void {
  db.insertWorkerOutcome({
    id: ulid(),
    user_id: task.user_id, task_id: task.id, node_id: node.id, worker_id: worker.id,  // denormalized ids
    harness: worker.harness, model: worker.model, task_type: task.task_type ?? 'unknown',
    effort: worker.effort,
    passed: gate.verdict === 'pass' ? 1 : 0,
    retries: node.attempts,
    drift_events: db.countLooks(worker.id),            // supervise.look events for this worker (Spec 03)
    scope_violations: worker.scope_violations,
    turns: worker.turns, tool_calls: worker.tool_calls,
    wall_clock_s: Math.round(((worker.ended_at ?? Date.now()) - worker.spawned_at) / 1000),
    diff_added: worker.diff_added, diff_removed: worker.diff_removed, files_changed: worker.diff_files,
    tokens_in: worker.tokens_in, tokens_out: worker.tokens_out,
    aborted: worker.state === 'aborted' ? 1 : 0,
    created_at: Date.now(),
  });
}
```

This fires for **every** finished worker — pass or fail, completed or aborted — so the model sees the
full distribution, not just successes (a worker that's aborted for drift is a *signal*, not noise).

### 5.2 The STAFF ranking query (Spec 06 capability table)

STAFF (Spec 04/06) picks a `(harness, model)` for a node of a given `task_type` by ranking accrued
outcomes. The query that becomes the **learned capability table**:

```sql
-- "For this task_type, which (harness, model) should STAFF prefer?"
SELECT harness, model,
       COUNT(*)                              AS samples,
       AVG(passed)                           AS pass_rate,          -- 0..1
       AVG(retries)                          AS avg_retries,
       AVG(drift_events)                     AS avg_drift,
       AVG(wall_clock_s)                     AS avg_wall_s,
       AVG(turns)                            AS avg_turns,
       SUM(scope_violations)                 AS total_scope_viol
FROM worker_outcomes
WHERE task_type = ?1
  AND created_at > ?2                          -- recency window (e.g. last 90d) so the model tracks drift
GROUP BY harness, model
HAVING samples >= ?3                           -- min support before trusting (else fall back to static table)
ORDER BY pass_rate DESC, avg_retries ASC, avg_wall_s ASC;
```

Until a `(harness, model, task_type)` cell clears `?3` (min-support, e.g. 5), STAFF uses the **static**
capability table (Spec 06); above it, the learned ranking overrides. `learned_staffing` (config flag,
Spec 01 §4) gates whether the override is active — logging is always on, staffing override is off in v1.

### 5.3 The aggregation that becomes "Codex over-engineers data layers"

The narrative learned-worker note (Spec 00 pillar 2; surfaced into memory per Spec 08) is Opus
summarizing an aggregation like this — a *pattern* across outcomes, not a single row:

```sql
-- Signal: on data-layer nodes, does codex churn more diff / more turns for the SAME pass rate?
SELECT harness,
       COUNT(*)                  AS n,
       AVG(passed)               AS pass_rate,
       AVG(diff_added + diff_removed) AS avg_diff_lines,   -- "over-engineering" proxy
       AVG(files_changed)        AS avg_files,
       AVG(turns)                AS avg_turns
FROM worker_outcomes
WHERE task_type = 'data-layer'
GROUP BY harness;
-- If codex shows ~equal pass_rate but markedly higher avg_diff_lines/avg_files/avg_turns than claude,
-- that IS the evidence behind the note.
```

The flow (open-questions G1): the daemon periodically (or at retro time) runs these aggregations →
hands the result table to Opus → Opus narrates it into a **`worker_note` memory file** under
`~/.beckett/memory/` (e.g. `worker-note-codex-data-layers.md`, frontmatter `kind: worker_note`), which
the `memory_index` mirror (§2.12) then picks up. So: **structured log → aggregation → Opus narration →
markdown KG → indexed for recall.** The note ("Codex over-engineers data layers; prefer Claude for the
persistence DAG, or scope Codex tighter") is what STAFF/PLAN read back as context. Memory file *format*
is Spec 08; this spec owns the SQL that feeds it.

---

## 6. Migrations — versioned, forward-only

A deliberately simple scheme (no down-migrations — Spec 00 favors loud-fail over clever rollback):

- Migrations are numbered `.sql` files, `migrations/NNN_name.sql`, applied in ascending order.
- `schema_migrations` (§2.14) records each applied `version`, `name`, `applied_at`, and a `checksum`
  (sha256 of the file). At boot the runner:
  1. reads `MAX(version)` from `schema_migrations` (0 if the table/db is new — it creates the DB +
     `users` seed + `schema_migrations` as migration `001`);
  2. applies every file with `version > current`, **each inside its own transaction**, recording the
     row in the same transaction (so a failed migration leaves the DB at the prior version, not
     half-applied);
  3. **refuses to start** (loud, Spec 01 §4) if an *already-applied* migration's on-disk checksum no
     longer matches the recorded checksum (someone edited history) — forward-only means applied files
     are immutable.

```ts
function migrate(db: Dal, files: MigrationFile[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY, name TEXT NOT NULL,
             applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
  const applied = db.appliedMigrations();                       // Map<version, checksum>
  for (const f of files.sort(byVersion)) {
    const prior = applied.get(f.version);
    if (prior) {
      if (prior !== f.checksum) throw new Error(            // immutability guard
        `migration ${f.version} (${f.name}) checksum drift — applied history was edited; refusing to start`);
      continue;                                                 // already applied, unchanged
    }
    db.transaction(() => {                                      // each migration is atomic
      db.exec(f.sql);
      db.run(`INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES (?,?,?,?)`,
             [f.version, f.name, Date.now(), f.checksum]);
    });
    logEvent('daemon.recover', { migration: f.version, name: f.name }); // audit the schema change
  }
}
```

> Forward-only + checksum-locked history is the right tradeoff for a single-box single-writer daemon:
> the cost of a bad migration is a restore-from-backup (the DB is one file — copy it before migrating),
> not a fragile auto-rollback. The runner copies `beckett.db` → `beckett.db.bak-<version>` before
> applying any pending migration (cheap insurance; pruned by §9).

---

## 7. Concurrency model

### 7.1 Single writer, many read-only readers

Canon (Spec 00 §4; Spec 01 §6/§7): **the daemon is the sole writer**; the `beckett` CLI is a
**read-only** reader. WAL (§1.1) makes this clean:

```
        ┌──────────────────────────┐  WRITE (exclusive logical writer)
        │ beckett daemon (1 proc)  │───────────────▶ beckett.db  (WAL)
        │  - all INSERT/UPDATE      │                     ▲
        │  - all JSONL appends      │                     │ RO WAL snapshots
        └──────────────────────────┘                     │ (never block the writer)
        ┌──────────────────────────┐  READ-ONLY          │
        │ beckett CLI (transient)  │─────────────────────┘
        │  ps / tail / status / logs (opens db with mode=ro; reads events/*.jsonl directly)
        └──────────────────────────┘
```

- The CLI opens with `?mode=ro` (or `SQLITE_OPEN_READONLY`) and reads consistent WAL snapshots — it
  **cannot lock out or corrupt** the daemon (Spec 01 §6/§7). Mutating CLI commands (`nudge`, `abort`,
  `pause`) do **not** write the DB directly; they go through the unix-socket IPC to the daemon, which
  performs the write as the single writer (Spec 01 §7).
- `busy_timeout=5000` rides out the rare WAL-checkpoint contention; a genuine `SQLITE_BUSY` past the
  timeout buffers the event in memory and retries, with the append-only JSONL as the durable fallback
  (Spec 01 §6).

### 7.2 Transaction boundaries

The writer is single-threaded (one bun event loop, synchronous `bun:sqlite` calls), so contention is
not the concern — **atomicity of a logical transition** is. Rules:

- **One transition = one transaction.** A state change writes its row update **and** its JSONL event
  reference under one `db.transaction(() => …)` (§3.4). Either both land or neither.
- **Keep transactions tiny and synchronous.** Never hold a transaction open across an `await` (no
  network/subprocess I/O inside a txn) — gather data first, then write in a short synchronous block.
  This keeps the WAL checkpoint cheap and readers always fast.
- **Multi-row transitions are batched:** e.g. `gate_pass` writes `nodes.state='NODE_DONE'`, the
  `gate_outcomes` row, the `worker_outcomes` row, and fires `dep_done` updates to dependents — all in
  one transaction so a crash can't leave a node "done" without its dependents unblocked.
- **Persist-first ordering** (nudges, check-ins, session_id) is itself the durability contract (§4.1):
  the DB write precedes the in-memory/side-effect action, never the reverse.

---

## 8. Data-access layer (TS types)

A thin synchronous DAL over `bun:sqlite` (prepared statements; `better-sqlite3` is API-compatible).
Row types mirror the DDL; the orchestrator/control-plane never write raw SQL.

```ts
import { Database } from "bun:sqlite";   // or: import Database from "better-sqlite3";

// ── row types (1:1 with the tables; enums are the Spec 02/04 unions) ──
type TaskRow = {
  id: string; user_id: string; channel_id: string; origin_msg_id: string | null;
  state: TaskState; task_type: string | null; prompt: string;
  assumptions_json: string; project_branch: string | null;
  created_at: number; updated_at: number;
};
type NodeRow = {
  id: string; task_id: string; user_id: string; title: string; state: NodeState;
  scope_json: string; branch: string; network: 0 | 1; attempts: number;
  last_reviewer_id: string | null; feedback_json: string; critical_path_rank: number | null;
  created_at: number; updated_at: number;
};
type WorkerRow = {
  id: string; node_id: string; task_id: string; user_id: string;
  harness: Harness; driver: DriverKind; model: string; effort: Effort;
  session_id: string | null; workspace: string; branch: string; is_resume: 0 | 1;
  state: WorkerState; turns: number; tool_calls: number;
  tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_create: number;
  diff_added: number; diff_removed: number; diff_files: number; usd_estimate: number | null;
  scope_violations: number; stream_offset_bytes: number; pid: number | null;
  spawned_at: number; last_activity_ts: number; ended_at: number | null;
};
type NudgeRow = {
  id: string; worker_id: string; node_id: string; user_id: string; text: string;
  source: 'opus_decision' | 'cli' | 'discord' | 'ask_plan';
  status: 'queued' | 'delivered' | 'failed'; fail_reason: string | null;
  enqueued_at: number; delivered_at: number | null;
};
type WorkerOutcomeRow = {
  id: string; user_id: string | null; task_id: string | null; node_id: string | null; worker_id: string | null;
  harness: Harness; model: string; task_type: string; effort: Effort;
  passed: 0 | 1; retries: number; drift_events: number; scope_violations: number;
  turns: number; tool_calls: number; wall_clock_s: number;
  diff_added: number; diff_removed: number; files_changed: number;
  tokens_in: number; tokens_out: number; aborted: 0 | 1; created_at: number;
};

class Dal {
  constructor(private db: Database) {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; " +
            "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // ── durability-critical writes (persist-first; §4.1) ──
  setWorkerSession(id: string, sessionId: string, pid: number): void {
    this.transaction(() => {
      this.db.run(`UPDATE workers SET session_id=?, pid=?, state='running' WHERE id=?`, [sessionId, pid, id]);
      this.appendEvent({ type: 'worker.session_captured', worker_id: id, payload: { sessionId, pid } });
    });
  }
  setNodeState(id: string, state: NodeState): void {
    this.transaction(() => {
      this.db.run(`UPDATE nodes SET state=?, updated_at=? WHERE id=?`, [state, Date.now(), id]);
      this.appendEvent({ type: 'node.state_changed', node_id: id, payload: { state } });
    });
  }
  enqueueNudge(n: NudgeRow): void {              // persist BEFORE in-mem (Spec 03 §6.1)
    this.transaction(() => {
      this.db.run(`INSERT INTO nudges (id,worker_id,node_id,user_id,text,source,status,enqueued_at)
                   VALUES (?,?,?,?,?,?, 'queued', ?)`,
                  [n.id, n.worker_id, n.node_id, n.user_id, n.text, n.source, n.enqueued_at]);
      this.appendEvent({ type: 'nudge.enqueued', worker_id: n.worker_id, node_id: n.node_id,
                         user_id: n.user_id, payload: { nudgeId: n.id, source: n.source } });
    });
  }

  // ── recovery reads (§4.3) ──
  tasksWhereStateNotIn(terminal: ReadonlySet<TaskState>): TaskRow[] { /* SELECT … WHERE state NOT IN (…) */ }
  liveWorkerForNode(nodeId: string): WorkerRow | null { /* latest non-terminal workers row */ }
  allQueuedNudges(): NudgeRow[] { /* SELECT * FROM nudges WHERE status='queued' ORDER BY enqueued_at */ }
  pendingCheckIns(workerId?: string): CheckInRow[] { /* state='pending' [AND worker_id=?] */ }

  // ── learned-model (§5) ──
  insertWorkerOutcome(o: WorkerOutcomeRow): void { /* INSERT … */ }
  rankWorkers(taskType: string, since: number, minSamples: number): RankedWorker[] { /* §5.2 query */ }

  // ── the audit append (§3.4) — called INSIDE a transaction by the writers above ──
  private appendEvent(partial: Partial<EventRecord> & { type: EventType }): void {
    const rec: EventRecord = {
      id: ulid(), seq: this.nextSeq(), ts: Date.now(),
      task_id: null, node_id: null, worker_id: null, user_id: null, payload: {}, ...partial,
    };
    this.eventWriter.append(JSON.stringify(rec) + "\n");   // O_APPEND, fsync-batched (§3.4/§3.5)
  }
}
```

---

## 9. Data lifecycle (retention, rotation, vacuum)

The discipline: **distill, then prune.** Operational rows (tasks/nodes/workers and their children) are
pruned once terminal and aged out — but only **after** their durable value has been captured in
`worker_outcomes` (the learned model) and the JSONL log (the audit trail). The two stores that *grow
forever by design* are `worker_outcomes` and the (archived) event log; everything else is bounded.

| Data | Retention default | Mechanism |
|---|---|---|
| **Completed tasks** (`tasks` + cascaded `nodes`/`node_deps`/`workers`/`criteria`/`gate_outcomes`/`nudges`/`check_ins`/`escalations`/`pending_actions`) | `retention.task_days` = **30** after a TASK terminal state (`DELIVERED`/`ABORTED`/`FAILED`) | nightly prune: `DELETE FROM tasks WHERE state IN (terminal) AND updated_at < now-30d` → FK `ON DELETE CASCADE` removes children. Runs only after the GATE step has written `worker_outcomes` for those tasks (guaranteed by §5.1, which fires at gate time, long before prune). |
| **`worker_outcomes`** | **kept indefinitely** (the accrued asset) | never cascade-deleted (no task FK); the learned model is the point (open-questions G1). Optional cap `retention.outcomes_max_rows` only if it ever grows pathologically — defaults off. |
| **Event log (JSONL)** | `events.retain_days` = **90** then gzip-archive; `events.archive_retain_days` = **365** then delete | daily rotation + size-roll (§3.5). Pruned **after** the task's outcomes are distilled; biased toward keeping (cheap, narratable). |
| **`memory_index`/`memory_links`** | follows the md files | rebuildable mirror; pruned when its source md is deleted (Spec 08). |
| **Migration backups** (`beckett.db.bak-<v>`) | keep last `retention.db_backups` = **3** | rotated by the migration runner (§6). |

### 9.1 Vacuuming

WAL accumulates free pages as rows are pruned. To reclaim disk:

- **Incremental, online:** `PRAGMA auto_vacuum = INCREMENTAL` set at DB creation (migration 001), and a
  nightly `PRAGMA incremental_vacuum;` after the prune pass — reclaims freed pages **without** the
  whole-file lock a full `VACUUM` takes.
- **Periodic full `VACUUM`:** monthly (or on `beckett doctor --vacuum`, Spec 10), during a quiet window
  — it briefly takes an exclusive lock, so it is scheduled when no workers are live. Defragments and
  shrinks the file.
- **WAL checkpoint:** `PRAGMA wal_checkpoint(TRUNCATE)` after a full vacuum to shrink the `-wal` sidecar.

All lifecycle jobs run **inside the daemon** (the single writer) on a low-frequency timer, log a
`daemon.*` event, and are config-tunable (`[retention]` / `[events]` blocks, Spec 01 §4). Nothing here
ever touches `worker_outcomes` or un-distilled history — the asset and the audit are sacrosanct.

---

## 10. Open gaps ⚠️

| Gap | Status |
|---|---|
| `bun:sqlite` vs `better-sqlite3` final pin | ⚠️ DAL is binding-agnostic; pin in Spec 12 setup after verifying `bun:sqlite` covers `transaction()` + RO open on loom-desk's bun 1.3.13. |
| FTS5 full-text over `memory_index` | ⚠️ deferred; v1 uses `kind`/`tags` indexes + the md files. Add an FTS virtual table when recall needs it (Spec 08). |
| Event-log ↔ SQLite divergence window | ⚠️ bounded to ≤1 record by §3.4 ordering; the exact re-derivation of a missing trailing event on boot is sketched, not fully specified — pin with Spec 04 recovery. |
| `task_type` taxonomy | ⚠️ free TEXT in v1 (classifier output, Spec 06); the learned-model queries (§5) assume stable labels — settle the enum with Spec 06/11 before `learned_staffing` turns on. |
| Multi-daemon / multi-project DB sharing | ⚠️ out of scope: one daemon, one `beckett.db` (Spec 01 §2). Cross-project learned-model sync (open-questions G3) would need a separate shared outcomes store — later. |
| `pending_actions` TTL/expiry policy | ⚠️ column exists; the actual expiry behavior + re-prompt cadence is Spec 07. |
| Min-support `?3` + recency window for STAFF ranking | ⚠️ first-guess constants (§5.2); calibrate against real `worker_outcomes` volume before trusting the override. |

---

## 11. Cross-links

- **[Spec 00 — Overview & Canon](./00-overview.md)** — persistence decision, durability (lose ≤1 turn), no-USD economics, multiplayer-ready, learned-model "log from day one."
- **[Spec 01 — Architecture](./01-architecture.md)** — Persistence component, WAL/busy_timeout, single-writer + RO CLI, startup recovery hook, `config.toml` `[paths]`/`[retention]`.
- **[Spec 02 — Worker Abstraction](./02-worker-abstraction.md)** — `Worker`/`WorkerSpend` fields persisted in `workers`; `session_id` capture; transcript paths for re-tail; resume mechanics.
- **[Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md)** — `check_ins`/`nudges`/`stream_offset` persistence; smoke-alarm/look events; `supervise.decision` audit; drain-on-restart.
- **[Spec 04 — State Machine](./04-state-machine.md)** — the enums in every `state` CHECK; the DAG decomposed into `nodes`/`node_deps`; `recoverDag` composed in §4.3.
- **[Spec 06 — Brain & Models](./06-brain-models.md)** — STAFF reads the §5.2 ranking; `task_type` classification; Opus narrating §5.3 aggregations.
- **[Spec 07 — Identity & Agency](./07-identity-agency.md)** — `pending_actions` policy (handshakes, action classes, expiry).
- **[Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md)** — md KG is the source; `memory_index`/`memory_links` are the mirror; worker-note narratives land here.
- **[Spec 10 — CLI](./10-cli.md)** — read-only DB/JSONL access for `ps`/`tail`/`status`/`logs`; `beckett doctor` (vacuum, seq-gap check).
- **[Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md)** — `criteria`/`gate_outcomes` format; the GATE step that writes `worker_outcomes` (§5.1).

---

## 12. Summary

1. **Two stores, one contract:** SQLite (WAL) is mutable **current state** (the source of truth the
   daemon writes and the CLI reads read-only); the per-day JSONL log is **immutable history** (audit +
   replay + learned-model feed). State changes write both in one transaction (§3.4).
2. **Full DDL** for `users`, `tasks`, `nodes`, `node_deps`, `workers`, `criteria`, `gate_outcomes`,
   `check_ins`, `nudges`, `escalations`, `pending_actions`, `memory_index`(+`memory_links`),
   `worker_outcomes`, `schema_migrations` — every Spec 02/04 enum is a `CHECK`, every table carries
   `user_id` (multiplayer-ready), the DAG is decomposed into queryable rows.
3. **Durability = persist `session_id` + node/task state on change, persist-first for nudges/check-ins,**
   and an idempotent restart algorithm (§4.3) that re-attaches live workers via `--resume`/`exec resume`,
   re-arms check-ins, replays un-drained nudges, and re-runs idempotent phases — **losing ≤ 1 turn.**
4. **Learned model:** one `worker_outcomes` row per finished worker at GATE (§5.1, denormalized so it
   outlives task pruning); the STAFF ranking query (§5.2) and the "Codex over-engineers data layers"
   aggregation (§5.3) → Opus narration → `worker_note` memory file (Spec 08).
5. **Migrations** are forward-only, checksum-locked, one-transaction-each, with a pre-migration DB
   backup; **concurrency** is single-writer-daemon + RO-CLI over WAL, one-transition-per-transaction,
   never holding a txn across an `await`.
6. **Lifecycle:** distill-then-prune — terminal tasks pruned after 30d (cascade), event log archived at
   90d / deleted at 365d, `worker_outcomes` kept forever; incremental online vacuum nightly, full vacuum
   monthly during a quiet window. **The accrued asset (learned model) and the audit trail are never
   pruned before they've captured their value.**

**Flagged inconsistencies / forks:** see §10 — chiefly the `bun:sqlite`/`better-sqlite3` pin, the
free-text `task_type` taxonomy (needs Spec 06/11 to stabilize before `learned_staffing`), the bounded
event-log↔SQLite divergence window, and deferred FTS. None contradict the Spec 00 ledger. **One
cross-spec note:** Spec 01 §4 `[paths]` uses absolute `/home/beckett/.beckett/...`, while Spec 00 §5
and this spec use `~/.beckett/...`; these resolve to the same location for OS user `beckett` — flagging
so the path constants are written once and shared, not duplicated.
