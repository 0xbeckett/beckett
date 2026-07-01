# Beckett — Spec 01: Architecture

> Status: **draft v0.1** · 2026-06-27 · Owner: Jason
> Scope: the runtime shape of Beckett — components, process & concurrency model, end-to-end data
> flow, the `config.toml` schema, startup/shutdown/recovery, failure domains, and the CLI↔daemon IPC.
> This is the "how the box is wired" doc. It honors the canon in [Spec 00](./00-overview.md) and
> defers component internals to their own specs.

---

## 1. Component map

Beckett is **one long-lived `bun` process** (the *daemon*) on `loom-desk`, plus N short-lived
**worker subprocesses** (`claude -p` / `codex exec`) it spawns and tails. Everything inside the dotted
box is in-process (modules, one event loop); everything outside is a separate OS process or file.

```
                            ┌─────────────────────────── Discord (cloud) ───────────────────────────┐
                            │   #general, #proj-x …   user types: "@beckett ship the auth fix"       │
                            └───────────────┬───────────────────────────────────▲────────────────────┘
                                            │ gateway ws (discord.js)            │ reply (sparse)
                                            ▼                                    │
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ beckett daemon  (single bun process, async event loop)                          ~/.beckett/         │
│                                                                                                       │
│   ┌──────────────┐     ┌──────────────────────────────────────────────┐                              │
│   │ Discord      │────▶│ Brain                                          │     ┌────────────────────┐ │
│   │ Gateway (05) │◀────│  ├─ Haiku front-door  (intake/ack/deliver)    │────▶│ Memory subsystem   │ │
│   └──────────────┘     │  └─ Opus escalation   (clarify/plan/gate/read) │◀────│  (md KG) (08)      │ │
│          ▲             └───────────────┬──────────────────────▲────────┘     └────────────────────┘ │
│          │                             │ plan (DAG+criteria)   │ decisions                            │
│          │                             ▼                       │                                      │
│   ┌──────┴───────┐         ┌───────────────────────┐   ┌───────┴────────┐    ┌────────────────────┐ │
│   │ Identity /   │         │ Orchestrator /        │──▶│ Scheduler      │    │ Persistence (09)   │ │
│   │ Agency (07)  │◀────────│ DAG-executor (04)     │◀──│ check-ins +    │    │  ├─ SQLite (state) │ │
│   │ gh/gmail     │         └──────────┬────────────┘   │ run-queue (J2) │    │  └─ JSONL (audit)  │ │
│   └──────────────┘                    │ dispatch       └───────┬────────┘    └─────────▲──────────┘ │
│                                       ▼                        │ wake/cap            writes          │
│                            ┌──────────────────────┐           │                        │            │
│                            │ Worker Manager        │◀──────────┘                        │            │
│                            │  spawn/cap/lifecycle  │────────────────────────────────────┘            │
│                            └──────────┬────────────┘                                                  │
│                                       │ owns                                                          │
│                            ┌──────────▼────────────┐         ┌──────────────────────────────────┐    │
│                            │ Harness Drivers (02)  │         │ Supervisor / Tailer (03)         │    │
│                            │  ├─ claude driver     │────────▶│  tails worker JSONL read-only    │    │
│                            │  └─ codex driver      │  stream │  smoke-alarms → Brain(Opus) read │    │
│                            └──────────┬────────────┘         └──────────────────────────────────┘    │
│                                       │ child_process.spawn                                           │
│   ┌──────────────┐                    │                                                               │
│   │ CLI/IPC      │  unix socket       │                                                               │
│   │ endpoint(10) │  ~/.beckett/sock   │                                                               │
│   └──────▲───────┘                    │                                                               │
└──────────┼────────────────────────────┼──────────────────────────────────────────────────────────────┘
           │ commands                   │ stdin (nudge) / stdout (JSONL) / kill
   ┌───────┴────────┐         ┌──────────▼───────────────────────────────────────────┐
   │ `beckett` CLI  │         │ worker subprocesses (claude -p / codex exec)          │
   │ (separate proc)│         │  each in its own git worktree under .beckett/worktrees│
   │  also reads DB │         └───────────────────────────────────────────────────────┘
   │  directly (RO) │
   └────────────────┘
```

### 1.1 Component table

| # | Component | Responsibility | Detailed in |
|---|---|---|---|
| 1 | **Discord Gateway** | Holds the discord.js ws connection. Receives `@beckett` mentions in any channel, normalizes to an intake event (with `user_id`, `channel_id`, text), routes Brain replies back to the same channel. Enforces sparseness. | [Spec 05](./05-discord-interface.md) |
| 2 | **Brain — Haiku front-door** | Fields every mention; classifies; writes the honest one-line ack; formats the final delivery in Beckett's persona voice. Cheap, always-on path. | [Spec 06](./06-brain-models.md) |
| 3 | **Brain — Opus escalation** | Stateless judgment calls invoked on signal: CLARIFY, PLAN (DAG + per-node criteria), drift-read, GATE, integrate-reconcile, self-halt. Off the clock between looks; continuity comes from SQLite + Memory, not a pinned context. | [Spec 06](./06-brain-models.md) |
| 4 | **Orchestrator / DAG-executor** | Owns a task's lifecycle: walks the state machine, resolves the DAG's ready set, asks Worker Manager to dispatch, drives INTEGRATE/REVIEW/GATE, handles retry≤3 and escalation. The control core. | [Spec 04](./04-state-machine.md) |
| 5 | **Scheduler** | Two jobs: (a) the **run-queue** — admits nodes up to the concurrency cap, queues the rest; (b) **check-ins** — per-worker timers/turn-counters Opus populates ("wake me on team 3 in ~10 min / after N turns"). Also drives rate-limit backoff retries. | [Spec 03](./03-control-plane-supervise.md) (check-ins), this doc §2/§4 (cap) |
| 6 | **Worker Manager** | Creates/tears down workers: allocates the git worktree, builds the resource envelope, selects the driver, enforces the concurrency cap, tracks live worker handles, reaps on exit. | [Spec 02](./02-worker-abstraction.md) |
| 7 | **Harness Drivers** | The two-implementation `nudge/pause/abort/spawn/resume` surface. `claude` driver = `claude -p` over stream-json stdin/stdout; `codex` driver = `codex exec` one-shot + `exec resume`. Parse JSONL → normalized telemetry. | [Spec 02](./02-worker-abstraction.md) |
| 8 | **Supervisor / Tailer** | Read-only observation: tails each worker's stream + on-disk JSONL, computes counters, fires mechanical smoke-alarms (no-progress over K, repeated calls, scope-violation, blocked). Never intervenes — hands signals to the Brain. | [Spec 03](./03-control-plane-supervise.md) |
| 9 | **Persistence** | SQLite (tasks, nodes, workers, events, outcomes, users) for queryable state + append-only JSONL event log for audit. Durability: persist `session_id` + node state on change. | [Spec 09](./09-persistence-data-model.md) |
| 10 | **Memory subsystem** | The markdown knowledge graph (`~/.beckett/memory/`, frontmatter + `[[wikilinks]]` + `MEMORY.md` index). Recall feeds Brain prompts and worker context; learned-worker narratives accrue here. | [Spec 08](./08-memory-knowledge-graph.md) |
| 11 | **Identity / Agency** | Beckett's own GitHub + Gmail identity, action-class gates, delivery handshakes, inbox poller. Reversible work (branch/PR/draft) is free; outbound/irreversible goes through a handshake. | [Spec 07](./07-identity-agency.md) |
| 12 | **CLI / IPC endpoint** | A unix-domain socket the daemon listens on for `beckett` commands (`nudge`, `abort`, `pause`, `status`…); read-only queries (`ps`, `tail`, `logs`) hit SQLite/JSONL directly. | [Spec 10](./10-cli.md), this doc §7 |

---

## 2. Process & concurrency model

**One daemon, many ephemeral children.** Beckett is a single long-lived `bun` process running an async
event loop (discord.js ws events, worker stdout/stderr streams, scheduler timers, the IPC socket, and
SQLite calls all multiplex onto it). It never blocks the loop on a worker — every worker is a
`child_process` whose stdout/stderr is consumed asynchronously line-by-line.

```
OS processes at peak:
  1 × beckett daemon (bun)
  + 1 × beckett CLI    (only while a command runs; transient)
  + N × worker subprocesses, N ≤ concurrency_cap   (claude -p / codex exec)
  + each worker may itself spawn its own tool subprocesses (bash, git, test runners)
        ↳ those live under the worker's process tree, not Beckett's direct concern
```

So at a cap of 4 the steady-state footprint Beckett directly manages is **1 + (≤4) = 5 processes**,
plus whatever each worker forks internally. loom-desk is 8c/31GB, comfortably sized for 4 concurrent
harness instances; the cap exists because each harness instance is heavy (its own model context, tool
subprocesses, file I/O), not because of a hard kernel limit.

### 2.1 The concurrency cap + queue

- `concurrency.max_workers` (default **4**, configurable — see §4) bounds **globally** how many workers
  run at once, across all tasks and all DAGs.
- The **Scheduler** keeps a FIFO-ish run-queue of *ready* nodes (DAG dependencies satisfied). When a
  worker slot frees (a worker reaches a terminal state), the next admissible node is admitted.
- Admission is not strictly FIFO: the Scheduler may prefer nodes that unblock the most downstream work,
  and respects per-harness availability (see rate-limit failover). Ordering policy detail → [Spec 03](./03-control-plane-supervise.md).
- A node that cannot be admitted (cap full, or its harness is rate-limited and no failover fits) stays
  `queued`; its task stays live. Queue depth is observable via the CLI.

### 2.2 How rate-limit failover interacts

Per canon (Spec 00: *Rate limits = failover*), the cap and the queue interact with subscription limits:

1. A worker's driver surfaces a rate-limit/quota signal (Claude `result` error subtype, or Codex
   `turn.failed`/transport error mapped by the driver).
2. The Orchestrator marks that **harness** as throttled with a cooldown, and asks STAFF whether the
   node is portable to the other harness. If yes → re-dispatch on the other harness (this is why Codex
   is pulled in slightly earlier than a pure v0; see Spec 00 §8).
3. If neither harness fits, the node returns to the Scheduler's queue with exponential backoff; the
   Scheduler retries when the cooldown elapses. The user is notified **only** if blocked a meaningfully
   long time (threshold below; sparseness still applies).
4. **v0 caveat:** Claude-only, so failover degenerates to **queue + backoff** — there is no second
   harness to route to until the Codex driver lands.

> ⚠️ The exact rate-limit *detection* heuristic per harness (which JSONL signals map to "throttled")
> is owned by the drivers in [Spec 02](./02-worker-abstraction.md); this doc only specifies that the
> Scheduler treats a throttled harness as temporarily unavailable for admission.

---

## 3. End-to-end data flow (one task, mention → delivery)

This traces the happy path and names the owning component at each hop. It does **not** re-specify the
state machine — see [Spec 04](./04-state-machine.md) and the Spec 00 §3 table for the canonical states.

```
1. MENTION    Discord Gateway     "@beckett ship the auth fix" in #proj-x → intake event
                                   {user_id, channel_id, msg_id, text}. Persisted as a task row.
2. INTAKE     Brain/Haiku         Classify + write honest one-line ack ("on it — branching off main,
                                   I'll wire the JWT swap and run the suite"). Posted to #proj-x.
3. CLARIFY?   Brain/Opus          Enough to plan? Reversible ambiguity → proceed (note assumptions at
                                   delivery). Irreversible → ONE question back via Gateway. (often skipped)
4. PLAN       Brain/Opus          Emit DAG (nodes + deps) + per-node acceptance criteria (exec checks
                                   + NL). Written to SQLite. Memory recall injected into the prompt.
5. STAFF      Brain/Opus          Assign each node (harness, model, effort) from the capability table.
6. DISPATCH   Orchestrator        Resolve ready set → hand nodes to Worker Manager via the Scheduler
              + Scheduler          (respecting the cap). 
              + Worker Manager     Worker Manager allocates a git worktree+branch per node, builds the
                                   resource envelope, picks the driver.
7. RUN        Harness Driver       Spawn `claude -p --input-format stream-json …` (or `codex exec …`).
                                   session_id persisted the instant it's known (durability).
8. SUPERVISE  Supervisor/Tailer    Tail JSONL read-only → counters. Smoke-alarm OR a Scheduler check-in
              ⇄ Brain/Opus         pulls Opus in to read → decide nudge / pause / abort. Nudge =
              ⇄ Scheduler          driver-specific write (Claude stdin / Codex queued-for-resume).
9. INTEGRATE  Orchestrator         Worker(s) done → git-merge worktree branches; on conflict, spawn an
              + Brain/Opus         integration worker (Opus) with both diffs + the interface contract.
10. REVIEW    Brain/Opus or        Run executable checks; self-review (simple) or fresh adversarial
              fresh reviewer       reviewer (critical) against the NL criteria.
11. GATE      Brain/Opus           checks==0 AND review pass → advance / next node / DELIVER.
                                   Fail → re-dispatch with feedback (retry ≤3) → else escalate w/ options.
12. DELIVER   Brain/Haiku          Final message in #proj-x in persona voice: what was done, known
              + Identity/Agency     limits, the artifact + the handshake ("PR's up — review or merge?").
                                   Irreversible step (merge/send) gated by Identity/Agency.
```

Every transition writes a row to SQLite and an event to the JSONL log (so the CLI and recovery can
reconstruct state). Outcome rows `(harness, model, task_type) → {passed, retries, drift_events, turns}`
are logged at GATE for the future learned model.

---

## 4. `~/.beckett/config.toml` schema

Single config file, TOML, loaded once at startup and re-readable via a CLI `reload` (⚠️ hot-reload
scope TBD — see note). Every tunable below has a default so Beckett boots on an empty config. Secrets
do **not** live here — they live in `~/.beckett/.env` (see Spec 00 §5).

```toml
# ~/.beckett/config.toml — all keys optional; defaults shown.

[concurrency]
max_workers      = 4        # int  — global cap on simultaneous worker subprocesses (Spec 00 J2)
queue_max        = 256      # int  — max queued-but-not-running nodes before intake pushes back
per_task_soft    = 4        # int  — soft cap on workers one task may hold (fairness; not hard)

[retry]
max_redispatch   = 3        # int  — re-dispatch cycles per node before escalate (canon: ≤3)
backoff_base_ms  = 2000     # int  — rate-limit/transient backoff base
backoff_max_ms   = 300000   # int  — backoff ceiling (5 min)

[supervise]
drift_no_progress_turns = 3 # int  — K: no-diff-progress over K turns → smoke-alarm (canon "drift K=3")
repeated_tool_calls_n   = 4 # int  — N near-identical tool calls → smoke-alarm
overrun_factor          = 1.5 # float — spend/turns > factor × node estimate → smoke-alarm
checkin_default_s       = 600 # int  — default Opus self-check-in horizon if it doesn't specify
tail_mode               = "stream+disk"  # "stream" | "disk" | "stream+disk" (canon: both, stream primary)

[models]
# Brain routing (Spec 06 owns prompt detail; this is just the model ids + tiers).
front_door   = "claude-haiku-4-6"   # intake / ack / deliver voice
judgment     = "claude-opus-4-9"    # clarify / plan / drift-read / gate / integrate
reviewer     = "claude-opus-4-9"    # fresh adversarial reviewer (critical nodes)

[harness.claude]
enabled          = true
bin              = "claude"
default_model    = "claude-sonnet-5-1"   # default worker model unless STAFF overrides
permission_mode  = "acceptEdits"         # within-scope autonomy; bypassPermissions per node if needed
extra_flags      = ["--verbose", "--replay-user-messages", "--include-hook-events"]

[harness.codex]
enabled          = false                 # v0 = Claude-only; flip on when the codex driver lands
bin              = "codex"
default_model    = "gpt-5.6-codex"
sandbox_mode     = "workspace-write"     # writes scoped to worktree
approval_policy  = "never"               # never block on a human prompt
network_default  = false                 # opt-in per node (Spec 00: network opt-in)

[paths]
home        = "/home/beckett"                  # Beckett's OS home
beckett_dir = "/home/beckett/.beckett"         # config + memory + db + logs root
projects    = "/home/beckett/projects"         # repos Beckett works in
db          = "/home/beckett/.beckett/beckett.db"
events_dir  = "/home/beckett/.beckett/events"  # *.jsonl audit log
logs_dir    = "/home/beckett/.beckett/logs"
memory_dir  = "/home/beckett/.beckett/memory"
socket      = "/home/beckett/.beckett/beckett.sock"  # CLI↔daemon IPC

[discord]
# token comes from .env (DISCORD_TOKEN); these are behavioral tunables.
reply_channel_mode   = "same"   # always reply in the channel the mention came from (canon: ambient)
escalate_after_s     = 1800     # only notify "still blocked" after this long blocked (sparseness)
chattiness           = "sparse" # "sparse" | "normal"  — per-user override planned (multiplayer)

[identity]
github_user      = "beckett-bot"     # Beckett's own GH login (PAT in .env)
gmail_address    = "beckett@…"       # Beckett's own inbox (auth in .env)
poll_inbox_s     = 120               # email poller interval (0 = off)
auto_merge       = false             # standing auto-merge grant (canon: off until trust; handshake)

[features]
# feature flags — design-for / build-later toggles, all default to the v1 posture.
codex_failover     = false   # turn on once codex driver is wired (rate-limit failover)
fresh_reviewer     = true    # tiered review: fresh adversarial reviewer for critical nodes
learned_staffing   = false   # adaptive capability model (log always-on; staffing off in v1)
multiplayer        = false   # concurrent multi-user tasks (user_id tracked regardless)
email_agency       = false   # inbox poll + draft/triage (gated send always)
app_server_codex   = false   # codex app-server turn/steer instead of exec (v2 steering upgrade)
```

Type/validation rule: the loader parses with a schema (zod-style) and **refuses to start** on an
unknown-typed or out-of-range value rather than silently coercing — config errors should be loud at
boot, never mid-task.

> ⚠️ **Hot-reload scope is a genuine gap.** Some keys (e.g. `discord.chattiness`, `supervise.*`) are
> safe to re-read live; others (`paths.*`, `harness.*.bin`) are boot-only. Spec 10 should define which
> keys `beckett reload` honors vs. require a restart. Until then: treat all of `config.toml` as
> boot-time and restart to apply.

---

## 5. Startup & shutdown

### 5.1 Startup sequence

```
1. Load env       read ~/.beckett/.env  (DISCORD_TOKEN, GITHUB_PAT, GMAIL_*, …); fail fast if missing required.
2. Load config    parse config.toml against schema; abort on invalid (loud).
3. Open DB        open SQLite (WAL mode, busy_timeout set — see §6); run migrations to head.
4. Open audit     open/append the day's events/*.jsonl; write a `daemon.start` event.
5. Bind IPC       create the unix socket at paths.socket (unlink stale socket if present; see §7).
6. Recover        RECOVERY HOOK → re-attach/resume in-flight workers, re-enter SUPERVISE. (Spec 09)
7. Connect        open the Discord gateway ws; mark presence online.
8. Resume sched   rehydrate the run-queue + check-in timers from persisted node/worker state.
9. Ready          write `daemon.ready`; begin processing mentions + draining the queue.
```

The **recovery hook (step 6)** is the durability contract from canon (*resume, lose ≤ current turn*):
for every worker row in a non-terminal state with a persisted `session_id`, re-attach via
`claude --resume <id>` / `codex exec resume <id>` from the **same cwd** (the worktree), re-open its
stream, and resume SUPERVISE. Workers with no recoverable session are re-dispatched from their node.
Full recovery semantics and the exact "what's resumable" matrix live in
[Spec 09](./09-persistence-data-model.md).

### 5.2 Shutdown sequence (graceful, on SIGTERM)

```
1. Stop intake    stop accepting new mentions / new IPC dispatch commands.
2. Quiesce        let in-flight worker turns reach a turn boundary where cheap; persist node state.
3. Checkpoint     for each live worker, ensure session_id + last node state are flushed to SQLite.
4. Detach         leave workers' on-disk JSONL intact (resumable); close streams. (Optionally let
                  short workers finish; long ones are abandoned-but-resumable.)
5. Close          flush JSONL audit (`daemon.stop`), checkpoint SQLite (WAL), close DB, unlink socket.
6. Disconnect     close Discord gateway; exit 0.
```

Shutdown is **resume-safe by design**: a hard `SIGKILL` mid-turn is also acceptable — recovery loses at
most the single in-flight turn because `session_id` + node state were persisted on change, not on exit.

### 5.3 Supervision on loom-desk

Beckett runs as a **systemd *user* service** under the `beckett` OS account (so it owns `~/.beckett` and
`~/.claude`/`~/.codex` auth without root, and Claude `bypassPermissions` is allowed — it refuses to run
as root). Proposed unit (setup steps → [Spec 12](./12-roadmap-setup.md)):

```ini
# ~beckett/.config/systemd/user/beckett.service   (enable lingering so it runs without an active login)
[Unit]
Description=Beckett agentic coworker daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bun /home/beckett/beckett/dist/daemon.js
Restart=on-failure
RestartSec=5
# graceful stop → SIGTERM → §5.2; give recovery room before SIGKILL
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

`loginctl enable-linger beckett` keeps it alive across logouts/reboots; `Restart=on-failure` + the
recovery hook means a crash self-heals with ≤1 turn lost. Detailed install/auth-persistence checklist
is deferred to [Spec 12](./12-roadmap-setup.md).

---

## 6. Failure domains & isolation

Each failure is contained to the smallest blast radius and degrades rather than crashes the daemon.

| Failure | Blast radius | Behavior / degradation |
|---|---|---|
| **A worker crashes / exits non-zero** | one node | Driver detects exit; Orchestrator marks the node failed, captures partial state from the worktree + JSONL, and re-dispatches (retry ≤3) — resuming via `session_id` where possible, else fresh. After 3 → escalate with options. Other workers and the daemon are unaffected (workers are isolated child processes in isolated worktrees). |
| **Worker hangs (no progress)** | one node | Supervisor smoke-alarm (`drift_no_progress_turns`) → Opus reads → nudge / pause / abort. Not an automatic kill. |
| **Discord gateway drops** | the interface, not the work | discord.js auto-reconnects with backoff. Workers keep running (they don't depend on the ws). Acks/deliveries that couldn't be posted are **queued in SQLite** and flushed on reconnect, so no delivery is lost. If down a long time, work still completes and is delivered late. |
| **Opus call fails / errors** | one decision | Brain retries the call with backoff (it's stateless — safe to retry). PLAN/GATE failures that won't clear → the task pauses and escalates to Discord ("I can't reach my planning step right now") rather than dispatching blind. Workers already running keep running under read-only SUPERVISE. |
| **Rate limit hit (subscription cap)** | one harness | Failover to the other harness if the node is portable; else queue + backoff (§2.2). v0 = queue + backoff. Notify only if blocked > `escalate_after_s`. |
| **SQLite locked / busy** | a write, briefly | DB opened in **WAL mode** with a `busy_timeout` (e.g. 5s) so concurrent reads (CLI) never block writes and transient contention auto-retries. Writes are short single-row transactions. The CLI reads are read-only and use WAL snapshots, so they can't lock out the daemon. A genuine `SQLITE_BUSY` past timeout → the event is buffered in memory and retried; the JSONL audit log (append-only, no locking) is the durable fallback record. |
| **Disk full / worktree alloc fails** | one node (or daemon if `~/.beckett` is full) | Worker Manager fails the dispatch and escalates; if `~/.beckett` itself can't be written, the daemon logs to stderr (journald) and refuses new tasks rather than corrupting state. |
| **Daemon crash** | everything in-flight, recoverably | systemd restarts; recovery hook re-attaches workers via `--resume`; ≤1 turn lost. |

**Isolation guarantees:** workers can't write outside their worktree (worktree + PreToolUse hook deny /
Codex `workspace-write`, per Spec 00); a worker can't take down the daemon (separate process, async I/O,
all parsing wrapped in try/catch with forward-compat skipping of unknown JSONL types); the CLI can't
corrupt state (writes go through the socket → daemon; direct DB access is read-only).

---

## 7. IPC — how `beckett` talks to the daemon

Two channels, split by read vs. write (canon: *CLI over SQLite + JSONL*):

```
                    ┌─────────────────────────────────────────────────────┐
  beckett ps        │ READS  → open beckett.db read-only (WAL snapshot) +  │
  beckett tail      │          read events/*.jsonl directly. No daemon hop.│
  beckett logs      │          Works even if the daemon is down.           │
  beckett status    └─────────────────────────────────────────────────────┘
                    ┌─────────────────────────────────────────────────────┐
  beckett nudge     │ WRITES → connect to unix socket paths.socket;        │
  beckett abort     │          send a length-prefixed JSON command; daemon │
  beckett pause     │          validates, enacts (e.g. drives a driver     │
  beckett resume    │          nudge), returns a JSON result. Fails clearly│
  beckett reload    │          with "daemon not running" if socket absent. │
                    └─────────────────────────────────────────────────────┘
```

- **Transport:** a unix-domain socket at `~/.beckett/beckett.sock` (filesystem perms restrict to the
  `beckett` user — no network exposure). Chosen over a TCP/HTTP port to avoid binding a port on a
  Tailscale-reachable box and to get OS-level access control for free.
- **Wire format:** newline-/length-delimited JSON request → JSON response. One request per connection
  (simple), command envelope `{cmd, args, user_id, request_id}`.
- **Why split:** queries are high-frequency and benefit from going straight to the DB (no daemon load,
  works during recovery); mutations must funnel through the daemon because it holds the live worker
  handles (a nudge to a Claude worker is a write to *that process's* stdin — only the daemon has it).
- The concrete command surface, flags, and output formats are owned by [Spec 10](./10-cli.md); this doc
  only fixes the **two-channel transport contract** and the socket path.

> ⚠️ Auth on the socket is currently just unix file perms (single-user box). When multiplayer/remote
> CLI lands, the command envelope's `user_id` will need real authentication — flagged for Spec 10.

---

## 8. Cross-references

- State machine & DAG execution detail → [Spec 04](./04-state-machine.md)
- Worker struct, drivers, spawn/steer/abort, scope enforcement → [Spec 02](./02-worker-abstraction.md)
- Smoke-alarms, check-in scheduler, nudge/pause/abort mechanics → [Spec 03](./03-control-plane-supervise.md)
- SQLite schema, JSONL event format, recovery matrix → [Spec 09](./09-persistence-data-model.md)
- CLI command surface + IPC command set → [Spec 10](./10-cli.md)
- Brain routing & prompts → [Spec 06](./06-brain-models.md); Memory → [Spec 08](./08-memory-knowledge-graph.md);
  Identity/Agency → [Spec 07](./07-identity-agency.md); Discord → [Spec 05](./05-discord-interface.md);
  loom-desk setup & roadmap → [Spec 12](./12-roadmap-setup.md).
```
