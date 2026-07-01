# Beckett — Spec 01: Runtime

> **SUPERSEDED:** This v2 design spec describes the retired parent/MCP/watcher architecture. Current build agents should start with [`docs/V3.md`](../../docs/V3.md).


> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> The runtime shape of v2: the thin bun **shell**, the **parent agent** it supervises, the
> process model, config, and startup/shutdown/recovery. Honors [Spec 00](./00-overview.md);
> defers worker mechanics to [Spec 04](./04-workers-and-hooks.md) and the tool surface to
> [Spec 05](./05-tools-mcp.md).

---

## 1. Component map

Three layers: the **shell** (thin TS plumbing), the **parent agent** (`claude -p`, the brain),
and **N child workers**. Everything the shell does is plumbing the agent can't do for itself.

```
                       Discord (cloud)  — @beckett in any channel
                              │ gateway ws (discord.js)          ▲ sparse reply
                              ▼                                  │
┌──────────────────────────────────────────────────────────────────────────────────┐
│ beckett SHELL  (bun, thin)                                          ~/.beckett/     │
│                                                                                     │
│  ┌──────────────┐   inject user msg   ┌───────────────────────────────────────┐    │
│  │ Discord pump │────────────────────▶│ Parent supervisor                     │    │
│  │ (gateway)    │◀────────────────────│  spawns `claude -p` (streaming-input), │    │
│  └──────────────┘   parent's reply    │  persists session_id, resumes on crash│    │
│         ▲                              └──────────────────┬────────────────────┘    │
│         │                                 stdin (events/signals) │ stdout (text)    │
│  ┌──────┴───────┐   inject signal     ┌──────────────────▼────────────────────┐    │
│  │ Watcher      │────────────────────▶│  BECKETT PARENT  (claude -p, Opus)     │    │
│  │ tails worker │                     │   Skills · CLAUDE.md doctrine+persona  │    │
│  │ logs → alarms│◀──── reads digests ─│   Tools: beckett-control MCP (in-proc) │    │
│  └──────┬───────┘   via worker_status └──────────────────┬────────────────────┘    │
│         │ reads                          spawn/observe/steer │ (MCP tool calls)     │
└─────────┼───────────────────────────────────────────────────┼─────────────────────┘
          │ ~/.beckett/workers/<id>/{events.jsonl,status.json} │ child_process.spawn
          │           ▲ written by worker hooks                ▼
          │   ┌────────┴──────────────────────────────────────────────────┐
          └───│ worker subprocesses (claude -p own driver | codex/pi via   │
              │ sandcastle), each in a git worktree, PreToolUse scope-guard│
              └────────────────────────────────────────────────────────────┘
```

### 1.1 The three shell jobs

| Job | Module | Responsibility |
|---|---|---|
| **Discord pump** | `src/shell/discord-pump.ts` | Hold the discord.js ws (salvaged `src/discord/gateway.ts`). Turn each `@beckett` mention into a user message injected on the parent's stdin. Route the parent's outbound text (via `discord_reply` tool) back to the originating channel. Enforce sparseness. |
| **Parent supervisor** | `src/shell/parent-supervisor.ts` | Spawn the parent `claude -p` in streaming-input mode; capture + persist its `session_id`; restart + `--resume` on crash. Owns the parent's stdin pipe (the one channel everything funnels into). |
| **Watcher** | `src/shell/watcher.ts` | Tail each worker's `events.jsonl` + session JSONL, compute smoke-alarms ([Spec 04 §4](./04-workers-and-hooks.md)), and inject compact **signals** ("worker wk_7f3a: no diff progress 3 turns") onto the parent's stdin. Fire self-scheduled check-ins the same way. |

Everything else — planning, staffing, deciding nudge/abort, writing the delivery message — is
the **parent agent's** job, done by reasoning + Skills, not shell code.

### 1.2 In-process MCP server

`beckett-control` ([Spec 05](./05-tools-mcp.md)) runs **inside the shell** and is handed to the
parent via `--mcp-config`. It wraps the salvaged libraries (`drivers/claude.ts`,
`worker/worktree.ts`, the Discord gateway, agency) and sandcastle. The parent calls its tools;
the shell executes them. This is how the agent's reasoning reaches real subprocess control.

---

## 2. Process & concurrency model

```
OS processes at peak:
  1 × beckett shell (bun)                       — Discord pump + parent supervisor + watcher + MCP
  1 × parent agent  (claude -p, long-lived)     — the brain
  N × worker subprocesses, N ≤ concurrency cap  — claude -p (own driver) / codex|pi (sandcastle)
  + each worker forks its own tool subprocesses (bash, git, tests) under its own tree
```

- **One parent, many ephemeral workers.** The shell never blocks on a worker; all worker I/O is
  async line-by-line into `~/.beckett/workers/<id>/`.
- **Concurrency cap** (`concurrency.max_workers`, default **2** in v0, **4** at v1) bounds live
  workers globally. The **parent** decides how many to run within the cap (discretion); the
  shell enforces the ceiling when executing `spawn_worker`.
- **Parent context discipline.** The parent is long-lived but must not drown in logs. It reads
  **digests** (`worker_status`), not raw transcripts, and only `read_worker_log` on a signal.
  Claude Code auto-compaction + persisted `session_id` keep the session bounded and resumable.

---

## 3. The parent agent invocation

The supervisor spawns the parent roughly as (exact flags ratified in build):

```bash
claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-hook-events \
  --session-id "$PARENT_SESSION_ID" \
  --permission-mode acceptEdits \
  --mcp-config "$BECKETT_CONTROL_MCP" \
  --append-system-prompt "$DOCTRINE"      # or rely on project CLAUDE.md
  # NOT --bare: the parent MUST load .claude/skills + .claude/hooks + CLAUDE.md
```

- **Streaming-input mode** keeps the parent alive; the shell writes user-message NDJSON lines
  for every Discord mention, watcher signal, and check-in.
- **Not `--bare`** — the parent depends on auto-discovery of its skills, hooks, and CLAUDE.md.
- The parent's own tools are the `beckett-control` MCP tools + Read/Write/Bash/Grep (for memory
  files, git, and running CLIs). Its cwd is the Beckett project root (or a project repo).
- **Signals vs mentions** are both user messages but tagged so the parent can tell a human
  instruction from a system observation (e.g. prefix `[signal]` / `[discord @user #chan]`).

---

## 4. `~/.beckett/config.toml`

Single TOML file, loaded by the shell at startup, validated against a schema (refuse to start on
invalid). Secrets live in `.env`, not here. All keys optional with defaults.

```toml
[concurrency]
max_workers   = 2          # global live-worker cap (v0=2, v1=4)

[parent]
model         = "claude-opus-4-8"
idle_resume   = true       # auto --resume on crash

[supervise]                 # watcher thresholds (Spec 04 §4)
no_diff_K            = 3
over_turn_factor     = 1.5
over_wall_factor     = 1.5
repeated_tool_N      = 3
stale_secs           = 180
alarm_cooldown_secs  = 120
checkin_default_s    = 600

[harness.claude]
enabled       = true
bin           = "claude"
default_model = "claude-sonnet-4-5"   # default worker model unless the parent overrides

[harness.codex]               # via sandcastle
enabled       = false         # v0 = Claude-only; flip on when wired
bin           = "codex"
default_model = "gpt-5.1-codex"
network       = false         # opt-in per worker

[review]
check_timeout_s     = 600
diff_lines_critical = 150
files_critical      = 8
reviewer_model      = "claude-opus-4-8"

[retry]
max_redispatch  = 3
backoff_base_ms = 2000
backoff_max_ms  = 300000

[discord]
reply_channel_mode = "same"   # reply in the channel the mention came from
escalate_after_s   = 1800     # only "still blocked" after this long
chattiness         = "sparse"

[paths]
home        = "/home/beckett"
beckett_dir = "/home/beckett/.beckett"
projects    = "/home/beckett/projects"
db          = "/home/beckett/.beckett/beckett.db"
memory_dir  = "/home/beckett/.beckett/memory"
workers_dir = "/home/beckett/.beckett/workers"

[identity]
github_user  = "beckett-bot"
gmail_address = "beckett@…"
poll_inbox_s  = 120
auto_merge    = false

[features]
codex_failover     = false
fresh_reviewer     = true
cross_provider     = false
learned_staffing   = false
multiplayer        = false
email_agency       = false
```

The salvaged `src/config.ts` loader (zod-validated) carries forward, trimmed to these keys.

---

## 5. Startup, shutdown, recovery

### 5.1 Startup
```
1. Load .env + config.toml (fail fast on missing required / invalid).
2. Open SQLite (WAL) — slim schema (outcomes, pending_actions, users). Run migrations.
3. Start beckett-control MCP server in-process.
4. RECOVER (§5.3): re-attach in-flight workers; rebuild watcher state from workers/<id>/.
5. Spawn the parent agent: --resume the persisted parent session if present, else fresh.
6. Connect Discord; mark presence online; start the pump + watcher.
7. Ready: begin injecting mentions/signals into the parent.
```

### 5.2 Shutdown (graceful, SIGTERM)
```
1. Stop the Discord pump (no new mentions).
2. Let the parent reach a quiescent point where cheap; persist its session_id.
3. Detach workers — leave their session JSONL + worktrees intact (resumable). Do NOT kill.
4. Flush watcher state, checkpoint SQLite (WAL), disconnect Discord, exit 0.
```
A hard `SIGKILL` is also acceptable: the parent session, worker session ids, and pending
actions are persisted on change, so recovery loses at most one in-flight turn.

### 5.3 Recovery (the durability contract)
On restart the shell:
- **Parent:** `claude -p --resume <parent_session_id>` from the same cwd — full prior context
  restored; lose ≤ the last in-flight turn.
- **Workers:** for each `workers/<id>/status.json` in a non-terminal state, re-attach the
  driver via `claude --resume <id>` / sandcastle resume from the worktree, re-open the event
  stream, rebuild watcher counters. Workers with no recoverable session are reported to the
  parent as a signal so it can re-dispatch from the node.
- **Pending actions** (handshakes) rehydrate from SQLite `(type, ctx)` — see
  [Spec 06](./06-identity-memory.md).

### 5.4 Supervision on loom-desk
Runs as a **systemd *user* service** under the `beckett` account (owns `~/.beckett`,
`~/.claude`, `~/.codex`; never root). `loginctl enable-linger beckett` keeps it alive across
logout/reboot; `Restart=on-failure` + recovery means a crash self-heals with ≤1 turn lost.
Unit detail → [Spec 07](./07-roadmap.md).

---

## 6. Failure domains

| Failure | Blast radius | Behavior |
|---|---|---|
| **A worker crashes** | one node | Driver/sandcastle detects exit; watcher signals the parent; the parent re-dispatches (retry ≤3, resume where possible) or escalates. Other workers + parent unaffected. |
| **Worker hangs** | one node | Watcher smoke-alarm → signal → parent reads digest → nudge/pause/abort. Never an auto-kill. |
| **Parent agent crashes** | the brain, recoverably | Supervisor restarts + `--resume`. In-flight workers keep running (they don't depend on the parent process); the parent re-attaches via recovery. |
| **Discord drops** | the interface, not the work | discord.js auto-reconnects; workers keep running; queued replies flush on reconnect. |
| **Rate limit** | one harness | Parent fails over to the other harness if portable; else queue + backoff; notify only if blocked > `escalate_after_s`. |
| **Shell crashes** | everything, recoverably | systemd restarts → §5.3 recovery re-attaches parent + workers; ≤1 turn lost. |

**Isolation guarantees:** workers can't write outside their worktree (worktree + scope-guard
hook / OS sandbox); a worker can't take down the shell or parent (separate processes, async
I/O, all log parsing wrapped in try/catch with forward-compat skipping of unknown event types);
the parent can't be drowned by logs (digest-first observation, auto-compaction).

---

## 7. Cross-references
- Worker spawn/steer/abort, worktree, hooks, smoke-alarms → [Spec 04](./04-workers-and-hooks.md)
- The `beckett-control` tool contract → [Spec 05](./05-tools-mcp.md)
- The parent's decision doctrine → [Spec 02](./02-doctrine.md); its skills → [Spec 03](./03-skills.md)
- Identity, agency gates, memory → [Spec 06](./06-identity-memory.md)
- loom-desk setup + systemd unit → [Spec 07](./07-roadmap.md)
