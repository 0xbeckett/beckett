# Beckett — Spec 10: CLI

> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Scope: the `beckett` command-line tool — the **canonical off-Discord management surface** for the
> daemon ([Spec 00 §4 — "Mgmt surface = `beckett` CLI"](./00-overview.md#4-canonical-decisions-the-ledger)).
> Every command's args/flags/output, the CLI↔daemon IPC protocol, the id/correlation scheme, exit
> codes, output formats, and safety model. Honors the canon in [Spec 00](./00-overview.md) and the
> two-channel transport contract in [Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon).
> Research: [`../my-docs/open-questions.md`](../my-docs/open-questions.md) (L1 — mgmt surface decision).

---

## 0. Where this sits

Beckett's management lives **off Discord, in a CLI** (canon: *Discord = ambient; management = CLI*).
The `beckett` binary is the operator's window into a running daemon: list what's working, watch a
worker think, steer or stop it, browse memory, check health. It is **canonical** — the Discord slash
commands ([Spec 05](./05-discord-interface.md)) are a thin mirror over the same IPC and DB (§9).

It talks to the daemon two ways, split by read vs. write exactly as [Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon) fixes:

```
  READ  commands  → open beckett.db read-only (WAL snapshot) + read events/*.jsonl directly.
                    No daemon hop. Works even while the daemon is down or recovering.
                    →  ps · status · tasks · tail · logs · mem · doctor(local checks)

  WRITE commands  → connect to the unix socket ~/.beckett/beckett.sock, send one length-prefixed
                    JSON command, get one JSON response. Fails clearly if the daemon is down.
                    →  nudge · pause · resume · abort · ask-plan · reload · daemon stop
```

The write commands map **directly** onto the Spec 03 control-plane primitives
([Spec 03 §5](./03-control-plane-supervise.md#5-intervention-primitives-per-harness)) —
`nudge`/`pause`/`abort`/`ask_plan` — surfacing the **per-harness asymmetry honestly** (Claude
instant-ish, Codex deferred → `queued` vs `delivered`, §5 / §8).

**Boundaries (defer):**
- Daemon internals, process model, the IPC transport contract → **[Spec 01 — Architecture](./01-architecture.md)**.
- The control-plane primitives `nudge/pause/abort/ask_plan` + receipts → **[Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md)**.
- The memory model the `mem` command browses → **[Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md)**.
- SQLite schema + JSONL event shapes the read path queries → **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)**.
- Discord slash-command mirror → **[Spec 05 — Discord Interface](./05-discord-interface.md)**.
- Install, symlink, auth-persistence, the systemd unit → **[Spec 12 — Roadmap & Setup](./12-roadmap-setup.md)**.

---

## 1. Invocation, install & global shape

`beckett` is itself a **bun script** — one TypeScript entrypoint run on bun, the same runtime as the
daemon ([Spec 00 runtime](./00-overview.md#4-canonical-decisions-the-ledger)). It is **not** the
daemon; it's a separate short-lived process (Spec 01 §2) that either reads the DB or pokes the socket
and exits.

```
#!/usr/bin/env bun
// bin/beckett.ts  →  symlinked to /usr/local/bin/beckett  (install → Spec 12)
```

Install/symlink/`PATH` wiring is **deferred to [Spec 12](./12-roadmap-setup.md)**; this spec assumes
`beckett` is on `PATH` and runs as the `beckett` OS user (or a user with read access to `~/.beckett`
and the socket — §9.4).

### 1.1 General form

```
beckett [global-flags] <command> [args] [command-flags]
```

Bare `beckett` (no command) prints help and exits `2`. `beckett help [command]` and
`beckett <command> --help` print usage.

### 1.2 Global flags (accepted by every command)

| Flag | Default | Effect |
|---|---|---|
| `--json` | off | Emit machine-readable JSON instead of the human table. Honored on every read command and every write command's result. (§3) |
| `--no-color` | auto | Disable ANSI color. Also honored: `NO_COLOR` env, and auto-off when stdout is not a TTY. (§3.3) |
| `--color` | auto | Force color even when piped. |
| `--quiet`, `-q` | off | Suppress non-essential chrome (headers, hints); print only data / the result line. |
| `--yes`, `-y` | off | Pre-confirm destructive ops (skip the prompt). (§6) |
| `--socket <path>` | from config | Override the IPC socket path (else `[paths].socket`, default `~/.beckett/beckett.sock`). |
| `--db <path>` | from config | Override the SQLite path (else `[paths].db`). |
| `--timeout <ms>` | `5000` | Socket request timeout for write commands. |
| `--help`, `-h` | — | Usage for the binary or the subcommand. |
| `--version`, `-V` | — | Print CLI + protocol version; exit 0. |

### 1.3 Config & path resolution

The CLI resolves paths the same way the daemon does, with a clear precedence so it works from any
account/cwd:

1. Explicit flag (`--socket`, `--db`).
2. `BECKETT_HOME` env → `$BECKETT_HOME/{beckett.sock,beckett.db,...}`.
3. `~/.beckett/config.toml` `[paths]` block (the canonical source; [Spec 01 §4](./01-architecture.md#4-becketconfigtoml-schema)).
4. Built-in default `~/.beckett/`.

The CLI reads only `[paths]` from `config.toml` (it never needs the behavioral tunables); a missing or
unreadable config is non-fatal for read commands as long as the defaults resolve.

### 1.4 Exit codes (uniform across all commands)

| Code | Meaning |
|---|---|
| `0` | Success. (For `doctor`: all checks `OK` or `WARN`.) |
| `1` | Generic runtime error (DB read failed, malformed event log, unexpected exception). For `doctor`: at least one `FAIL`. |
| `2` | Usage error — bad/missing args, unknown command/flag, unresolvable id syntax. |
| `3` | Daemon unreachable — socket missing/refused on a **write** command. (Read commands never return 3; they work daemon-down.) |
| `4` | Not found — task/node/worker id resolved syntactically but doesn't exist (or isn't live, where liveness is required). |
| `5` | Rejected by daemon — command valid but illegal in the target's current state (e.g. `pause` an already-terminal worker, `nudge` an aborted worker). The daemon's `reason` is printed. |
| `6` | Aborted by user — a confirmation prompt was declined (and `--yes` not given). |
| `7` | Timeout — socket request exceeded `--timeout`. |

---

## 2. Correlation — the id scheme

How a human points at a thing. Three referent kinds, three syntaxes, one resolver. Backed by the
SQLite ids in [Spec 09](./09-persistence-data-model.md).

| Referent | Syntax | Example | Source |
|---|---|---|---|
| **Task** | bare integer | `42` | `tasks.id` (monotonic per daemon) |
| **Node** | `<task>.<n>` | `42.1`, `42.3` | 1-based node index within the task DAG (`nodes.idx`) |
| **Worker** | `w-<base36>` | `w-7f3a` | `workers.short_id` — a stable short handle for one harness *instance* |

### 2.1 Why both node ids and worker ids

A **node** (`42.1`) is a slot in the plan; it is stable across retries. A **worker** (`w-7f3a`) is one
concrete harness instance that ran (or is running) that node. A node that gets re-dispatched after an
abort (retry ≤3, [Spec 04](./04-state-machine.md)) keeps id `42.1` but spawns a *new* worker
`w-9c2d`. So:

- Use a **node id** when you mean "whatever's working node 1 of task 42 right now" — the ergonomic,
  human choice. It resolves to the node's **current live worker**.
- Use a **worker id** when you mean a *specific* instance (e.g. tailing a worker that has since been
  retried, or referring to one of two workers on the same node — rare). Worker ids are what `ps` and
  `tail` print, so copy-paste always works.

### 2.2 The resolver

```
resolve(ref):
  if ref matches ^\d+$            → TASK   ref
  if ref matches ^\d+\.\d+$       → NODE   ref → its current live worker (or its workers, for read)
  if ref matches ^w-[0-9a-z]+$    → WORKER ref
  else                            → exit 2 (usage: "unrecognized id 'foo' — expected 42, 42.1, or w-7f3a")
```

- Ambiguous prefixes are **not** allowed — ids are exact (no fuzzy `4` matching `42`). Tab-completion
  is the ergonomics answer (defer to Spec 12).
- A node ref where **no worker is currently live** (node `queued`, `done`, or between retries):
  - read commands (`tail`, `status`) resolve to the **most recent** worker for that node;
  - write commands (`nudge`, `pause`, `abort`, `ask-plan`) exit `4` with "node 42.1 has no live worker
    (state: queued)" — you can't steer a worker that isn't running.
- A **task ref** on a per-worker write command (`pause`/`resume`/`ask-plan`) is rejected `2` (ambiguous
  — "pick a worker; `beckett ps 42` lists them"). `nudge`/`abort`/`tail` accept task refs with
  fan-out rules in their sections.

---

## 3. Output formats

Every command supports two renderers selected by `--json`.

### 3.1 Human (default)

Column-aligned plain-text tables (the style of the Spec 00 ledger tables, rendered for a terminal).
Headers in bold, right-sized columns, age/duration humanized (`2m`, `1h04m`), a one-line summary
footer unless `--quiet`. Wide tables truncate the least-important column to terminal width; `--json`
or a wider terminal shows it all.

### 3.2 JSON (`--json`)

Stable, scriptable shape. Read commands emit `{ "ok": true, "data": <payload>, "as_of": <epoch_ms> }`
(`as_of` = the WAL snapshot time, so scripts know freshness). Write commands emit the daemon's result
envelope verbatim (§9.2). Errors emit `{ "ok": false, "error": { "code": <exit_code>, "kind": "...",
"message": "..." } }` to **stdout** and set the matching exit code (so `jq` pipelines see structured
errors, and `$?` still works). `--json` implies `--no-color`.

### 3.3 Color

ANSI color on by default when stdout is a TTY; auto-disabled when piped, when `NO_COLOR` is set, or
with `--no-color`. Semantic palette: green = healthy/`delivered`/`OK`, yellow = `queued`/`paused`/
`WARN`/drift, red = `failed`/`aborted`/`FAIL`/error, dim = terminal/`done`/idle. Color is **never**
load-bearing — every state has a text label too.

### 3.4 Streaming (`tail` only)

`tail` does not buffer: it writes lines as they arrive and flushes per line, so it composes with
`| grep`, `| head`, etc. SIGINT (Ctrl-C) exits `0` cleanly. (§4.2)

---

## 4. Command surface — read commands

These open the DB read-only (WAL snapshot) and/or read `events/*.jsonl`. **No daemon required.**

### 4.1 `beckett ps`

**Live operational view** — what's running *now*: active tasks, their nodes, and the workers on them.
The default "what is Beckett doing" glance.

```
beckett ps [task] [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `[task]` | all active | Scope to one task id (shows that task's nodes/workers). |
| `--workers`, `-w` | off | Flat worker-centric list instead of the task→node tree. |
| `--all`, `-a` | off | Include `queued` and recently-terminal nodes (not just `running`). |
| `--watch`, `-W` | off | Redraw every `--interval` (default 2s) until Ctrl-C (read-loop on the DB snapshot; no socket). |
| `--interval <s>` | `2` | Refresh period for `--watch`. |
| `--json` | — | Structured (§3.2). |

**Sample (default tree):**

```
TASK  STATE       NODE   WORKER  HARNESS         STATE     TURNS  DIFF        ACT   WHAT
42    supervising
              └─  42.1   w-7f3a  claude/sonnet   running      16  +812 / 6f    4s   auth: mapping call sites
              └─  42.2   w-9c2d  codex/gpt-5.6   running       7  +120 / 2f   22s   tests: scaffolding suite
              └─  42.3    —       —     —         queued        —   —           —    docs (waits 42.1)
51    supervising
              └─  51.1   w-1a0b  claude/sonnet   paused        9  +1.2k / 11f  5m   refactor: HELD (your pause)
57    planning     —      —       —    —          —             —   —           —    "ship the webhook retry fix"

3 tasks · 4 nodes · 3 workers (2 running, 1 paused) · cap 4 · queue 0
```

- `DIFF` = `+bytes / files` from `WorkerCounters.diffBytes`/`filesChanged` ([Spec 03 §1.3](./03-control-plane-supervise.md#13-the-unified-counter-set-workercounters)).
- `ACT` = age of `lastActivityTs` (a growing value is the first hint of staleness / A6).
- `WHAT` = the node's short label + the worker's freshest `currentPlan`/`todo` summary line (cheap,
  from the counters/last summary — not a fresh model call).
- The footer mirrors the concurrency cap + queue depth ([Spec 01 §2.1](./01-architecture.md#21-the-concurrency-cap--queue)).

**`--workers` sample:**

```
WORKER  TASK  NODE  HARNESS        STATE    TURNS  TOOLS  DIFF        BLOCKED  NUDGES  ACT
w-7f3a  42    42.1  claude/sonnet  running     16     58  +812 / 6f   —        0       4s
w-9c2d  42    42.2  codex/gpt-5.6  running      7     19  +120 / 2f   —        1q      22s
w-1a0b  51    51.1  claude/sonnet  paused       9     31  +1.2k / 11f —        0       5m
```

`NUDGES` shows pending steering: `1q` = 1 queued, `2d` = 2 delivered this run (§5.1). `BLOCKED` shows
`blockedFlag`/`errorFlag` reason if set.

### 4.2 `beckett tail <task|worker>`

**Live prettified worker JSONL stream.** Renders the worker's transcript events (the same JSONL the
Supervisor tails read-only, [Spec 03 §1.2](./03-control-plane-supervise.md#12-two-data-sources-stream-primary))
into human lines, following new events as they land.

```
beckett tail <task|worker> [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `<task\|worker>` | required | Worker ref, node ref (→ its live/last worker), or task ref (→ all the task's live workers, prefixed). |
| `--since <n>` | `20` | Backfill the last N events before following. |
| `--from-start` | off | Replay the whole transcript from byte 0, then follow. |
| `--no-follow`, `-n` | off | Print the backfill/replay and exit (don't stream). |
| `--raw` | off | Emit the unmodified JSONL lines (no prettifying) — for debugging the harness. |
| `--filter <kinds>` | all | Comma list: `text,tool,result,error,plan` — only show those event kinds. |
| `--json` | — | Emit normalized event objects as NDJSON (one per line), still streaming. |

Mechanics: the CLI tails the on-disk transcript file (path from the worker row, [Spec 09](./09-persistence-data-model.md))
from a byte offset, parsing each line and normalizing the two harness vocabularies into one display.
It does **not** connect to the socket — tailing is pure read (and so works during recovery). Unknown/
future JSONL event types are rendered as a dim `· <type>` line rather than dropped or crashing
(forward-compat, mirroring the daemon's parser, [Spec 01 §6](./01-architecture.md#6-failure-domains--isolation)).

**Sample (prettified):**

```
w-7f3a · 42.1 · claude/sonnet · auth-refactor
14:02:11  ▸ turn 15
14:02:12  ◇ tool  Grep  "getSession" (9 files)
14:02:18  ◇ tool  Read  middleware/auth.ts
14:02:24  ▸ assistant  "14 call sites map cleanly; I'll change the shared interface first…"
14:02:31  ▸ turn 16
14:02:48  ◇ tool  Edit  lib/auth/session.ts  (+148 / -22)
14:03:02  ⚑ nudge delivered (cli, jason): "leave the legacy cookie path for a follow-up"
14:03:09  ◇ tool  Edit  lib/auth/session.ts  (+12 / -4)
```

For a **task ref** with multiple live workers, each line is prefixed with the worker id and lines are
interleaved by arrival:

```
[w-7f3a] 14:02:48  ◇ tool  Edit  lib/auth/session.ts (+148/-22)
[w-9c2d] 14:02:49  ◇ tool  Bash  bun test  (exit 1)
```

Nudges/pauses/aborts (from CLI *or* Discord) appear inline as `⚑` control lines, so a tail is a true
record of intervention, not just model output.

### 4.3 `beckett status [task]`

**Detailed snapshot** of one task (or a fleet summary). Heavier than `ps`: shows the DAG, criteria
progress, per-node history, recent supervise decisions, and escalations.

```
beckett status [task] [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `[task]` | fleet summary | A task id for full detail; omitted → one-line-per-task overview (like `ps` but including idle/blocked tasks). |
| `--nodes` | on (when task given) | Show the per-node table. |
| `--decisions <n>` | `5` | Include the last N supervise decisions ([Spec 03 §4.3](./03-control-plane-supervise.md#43-step-③--the-decision-exact-schema)) for the task. |
| `--json` | — | Structured (§3.2). |

**Sample (`beckett status 42`):**

```
Task 42  ·  state: supervising  ·  opened 18m ago by jason  ·  #proj-x
  "ship the auth fix — swap the JWT cookie and run the suite"

DAG (3 nodes)
  NODE   LABEL              WORKER  STATE     CHECKS         RETRIES  WORKER-STATE
  42.1   auth-refactor      w-7f3a  running   pending           0/3   running (16 turns)
  42.2   test-suite         w-9c2d  running   pending           0/3   running (7 turns)
  42.3   docs               —       blocked   —                 0/3   waits on 42.1

Acceptance (42.1)
  ✓ exec   bun run build            (passed 2m ago)
  · exec   bun test auth            (not yet run)
  · nl     "no behavior change to non-JWT callers"   (awaits review)

Recent supervise decisions
  14:03  reschedule  w-7f3a  "2× over turns but mid a legit 14-site refactor; let it cook" (+6t/10m)
  13:58  nudge       w-9c2d  "use the existing test harness, don't roll a new one"

Escalations: none
```

### 4.4 `beckett tasks [--all]`

**Task ledger** — history, not just live work. `ps` is "now"; `tasks` is "everything".

```
beckett tasks [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `--all`, `-a` | off | Include completed/aborted/delivered tasks (default shows only open/active). |
| `--since <when>` | `7d` (with `--all`) | Time window: `30m`, `6h`, `2d`, or ISO date. |
| `--user <id>` | all | Filter by `user_id` (multiplayer-ready attribution, [Spec 00 multiplayer](./00-overview.md#4-canonical-decisions-the-ledger)). |
| `--state <s>` | all | Filter: `planning,supervising,delivered,aborted,escalated,…`. |
| `--limit <n>` | `50` | Cap rows. |
| `--json` | — | Structured (§3.2). |

**Sample (`beckett tasks --all --since 2d`):**

```
TASK  STATE       OPENED     CLOSED     BY      NODES  CHANNEL    SUMMARY
42    supervising 18m ago    —          jason   3      #proj-x    ship the auth fix
51    supervising 2h ago     —          jason   1      #proj-x    refactor the worktree alloc
39    delivered   1d ago     1d ago     jason   2      #general   add the /healthz endpoint
37    aborted     2d ago     2d ago     sam     4      #proj-x    migrate to the new ORM (escalated)

4 tasks (2 active, 1 delivered, 1 aborted)
```

### 4.5 `beckett logs [--since]`

**The JSONL audit stream**, prettified — daemon-wide events (state transitions, dispatches, supervise
decisions, nudges, escalations, errors), read straight from `events/*.jsonl` ([Spec 01 §1](./01-architecture.md), [Spec 09](./09-persistence-data-model.md)). This is the audit log, distinct from `tail` (one worker's
*model* transcript).

```
beckett logs [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `--since <when>` | `15m` | Window: `30m`, `2h`, `1d`, or ISO timestamp. |
| `--follow`, `-f` | off | Stream new events as appended (tails today's `events/*.jsonl`). |
| `--task <id>` | all | Filter to one task's events. |
| `--worker <id>` | all | Filter to one worker. |
| `--kind <k>` | all | Comma list: `state,dispatch,supervise_decision,nudge,abort,escalate,error,daemon`. |
| `--level <l>` | `info` | Minimum level: `debug,info,warn,error`. |
| `--limit <n>` | `200` | Cap (ignored with `-f`). |
| `--json` | — | Emit raw event objects as NDJSON. |

**Sample:**

```
14:01:55  info   daemon          ready (recovered 2 workers, queue 0)
14:02:01  info   dispatch  42.2  w-9c2d  codex/gpt-5.6  worktree .beckett/worktrees/42.2
14:03:02  info   nudge     42.1  w-7f3a  queued→delivered  (cli, jason)
14:03:03  warn   supervise 42.1  w-7f3a  over_envelope + no_diff_progress → reschedule
14:05:10  error  worker    37.4  w-3e1f  exit 1 (non-zero) → re-dispatch 1/3
```

### 4.6 `beckett mem <search|show|list>`

**Browse the knowledge graph** — the markdown memory under `~/.beckett/memory/` (frontmatter +
`[[wikilinks]]` + `MEMORY.md` index, [Spec 08](./08-memory-knowledge-graph.md)). Read-only file
access; **no daemon needed**. The *model* of recall is owned by Spec 08; the CLI is a thin browser.

```
beckett mem list [flags]
beckett mem search <query> [flags]
beckett mem show <name|wikilink> [flags]
```

| Subcommand | Args / flags | Behavior |
|---|---|---|
| `list` | `--tag <t>`, `--kind <people\|projects\|env\|workers>`, `--json` | List memory notes from the index — name, kind/tags, link count, last-modified. |
| `search` | `<query>`, `--limit <n>` (default 10), `--json` | Full-text search across note bodies + frontmatter; ranked snippets with the matching note name. ⚠️ ranking impl (naive grep vs FTS5) deferred to Spec 08/09. |
| `show` | `<name\|[[wikilink]]>`, `--raw`, `--links`, `--json` | Render one note: frontmatter as a header block + body (`--raw` = exact file bytes). `--links` lists outbound `[[wikilinks]]` and backlinks. |

**Sample (`beckett mem search "marketing team"`):**

```
QUERY "marketing team"  ·  3 hits

people/marketing-team.md        people    "…the marketing team: [[Dana]] (lead), [[Priya]]…"
projects/anaconda.md            project   "…go-to-market owned by the [[marketing-team]]…"
people/dana.md                  people    "…Dana runs marketing; prefers Slack over email…"
```

**Sample (`beckett mem show people/marketing-team`):**

```
people/marketing-team.md
  kind: people · tags: [team, gtm] · updated 4d ago · 5 links

# Marketing team
Lead: [[Dana]]. Members: [[Priya]], [[Sam]]. Owns go-to-market for [[anaconda]].
Reachable as marketing@… — Beckett may DRAFT to them; sending is gated (handshake, Spec 07).

→ links: Dana, Priya, Sam, anaconda      ← backlinks: anaconda, q3-launch
```

### 4.7 `beckett doctor`

**Health check.** Verifies the daemon and its dependencies are sound. Mixes **local** checks (run by
the CLI directly — no daemon needed) and **daemon** checks (via a `status` IPC ping; gracefully marked
`SKIP`/`FAIL` if the daemon is down).

```
beckett doctor [flags]
```

| Flag | Default | Meaning |
|---|---|---|
| `--json` | — | Structured per-check results. |
| `--fix` | off | ⚠️ *Defer to Spec 12* — attempt safe auto-remediation (e.g. unlink a stale socket, re-run `claude`/`codex` login). v1: flag reserved, prints "not yet implemented". |

Checks (each → `OK` / `WARN` / `FAIL` + a detail line):

| Check | How | Source |
|---|---|---|
| daemon up | socket connect + `{cmd:"status"}` ping (§9) | IPC |
| daemon health | uptime, queue depth, live workers from the status reply | IPC |
| discord connected | gateway state + last-event age in status reply | [Spec 05](./05-discord-interface.md) |
| claude auth | `claude` on PATH + `~/.claude` creds present/valid (subscription login, zero-reauth goal) | local |
| codex auth | `codex` on PATH + `~/.codex` creds — `WARN`/`SKIP` if `[harness.codex].enabled = false` (v0 Claude-only) | local |
| config valid | parse `config.toml` against schema ([Spec 01 §4](./01-architecture.md#4-becketconfigtoml-schema)) | local |
| db ok | open `beckett.db` RO, `PRAGMA integrity_check`, confirm WAL mode | local |
| disk | free space on `~/.beckett` and `[paths].projects`; `WARN < 10%`, `FAIL < 2%` | local |
| memory | `MEMORY.md` index present + parses | local |

**Sample:**

```
beckett doctor

  ✓ daemon            up · pid 4812 · uptime 3h12m
  ✓ discord           connected · last event 6s ago
  ✓ claude auth       ok · ~/.claude valid · sonnet/opus/haiku reachable
  ⚠ codex auth        disabled in config (harness.codex.enabled = false) — v0 Claude-only
  ✓ config            ~/.beckett/config.toml valid
  ✓ database          beckett.db ok · WAL · integrity ok
  ⚠ disk              ~/.beckett 87% used (4.1G free) — watch worktrees under projects/
  ✓ memory            MEMORY.md · 42 notes indexed

  1 ok to ignore, 0 problems.  →  exit 0
```

Exit: `0` if no `FAIL` (warnings allowed), `1` if any `FAIL`.

---

## 5. Command surface — write/control commands

These connect to the unix socket and enact a daemon-side action (it holds the live worker handles —
[Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon)). Each maps onto a Spec 03
primitive and returns that primitive's receipt. If the daemon is down → exit `3`
("daemon not running — `beckett daemon start`"). The CLI is just the entry; the **daemon validates and
enacts** (a CLI can't corrupt state — [Spec 01 §6](./01-architecture.md#6-failure-domains--isolation)).

### 5.1 `beckett nudge <task|worker> "<msg>"`

Soft steering message to a running worker, delivered at its next safe boundary, context preserved
([Spec 03 §5.1](./03-control-plane-supervise.md#51-nudgeworker-msg--the-default-intervention)). The
default intervention; **not destructive → no confirmation**.

```
beckett nudge <task|worker> "<msg>" [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `<task\|worker>` | required | Worker/node ref → that worker. Task ref → see fan-out below. |
| `"<msg>"` | required | The steering text (quote it). Empty → exit 2. |
| `--all` | off | For a task ref with multiple live workers, broadcast to all of them. |
| `--wait` | off | Block until the receipt flips `queued`→`delivered` (or `--timeout`), so scripts can confirm landing. Without it, returns immediately with the `queued`/`delivered` receipt. |
| `--json` | — | Emit the `NudgeReceipt` (§9.2). |

**Fan-out:** a worker/node ref targets exactly one worker. A **task** ref: if the task has exactly one
live worker → target it; if more than one → exit `5` listing candidates ("task 42 has 2 live workers:
w-7f3a, w-9c2d — pass one, or `--all`") unless `--all`. (CLI is explicit; the *Beckett-decides-which*
behavior lives in Discord's NL path, Spec 05.)

IPC → `WorkerControl.nudge` → enqueued on the per-worker nudge queue ([Spec 03 §6](./03-control-plane-supervise.md#6-the-nudge-queue))
with `source:"cli"`, `userId`. The response is a `NudgeReceipt`.

**The harness asymmetry is surfaced verbatim — never faked** ([Spec 03 §5.1](./03-control-plane-supervise.md#51-nudgeworker-msg--the-default-intervention)):

```
$ beckett nudge 42.1 "leave the legacy cookie path for a follow-up"
✓ nudge w-7f3a (claude) delivered — lands next turn boundary       # claude: fast

$ beckett nudge 42.2 "use the existing test harness"
• nudge w-9c2d (codex) queued — applies at next turn end (resume)  # codex: deferred, honestly labeled
```

`green ✓ delivered` vs `yellow • queued` is the literal `NudgeReceipt.status`. With `--wait`, the CLI
polls the receipt (read path) until `delivered` and updates the line in place.

### 5.2 `beckett pause <worker>`

Freeze a worker at its next safe boundary, capture its diff, hold for a decision
([Spec 03 §5.2](./03-control-plane-supervise.md#52-pauseworker--checkpoint--hold)). **Reversible →
no confirmation.**

```
beckett pause <worker> [--json]
```

- Accepts a worker ref or a node ref (→ live worker). Task ref rejected (`2`, ambiguous).
- IPC → `WorkerControl.pause` → returns a `Checkpoint` (sessionId, diffStat, offset).
- A worker already terminal/queued → exit `5` ("w-7f3a is not running (state: done)").
- Paused workers have their check-ins suspended so they don't trip `stale` (Spec 03 §5.2).

```
$ beckett pause w-1a0b
✓ paused w-1a0b (51.1) — diff captured: 11 files / +1.2k -340 · resume with `beckett resume w-1a0b`
```

### 5.3 `beckett resume <worker>`

Unpause a worker paused via `pause` (or by an Opus decision). The inverse of §5.2; **reversible → no
confirmation.**

```
beckett resume <worker> [--json]
```

- IPC command `resume` → daemon transitions `paused→running` ([Spec 04](./04-state-machine.md)),
  re-arms suspended check-ins, and drains any nudges queued while paused (Claude: feed stdin; Codex:
  next `exec resume`).
- A worker not in `paused` → exit `5`.

```
$ beckett resume w-1a0b
✓ resumed w-1a0b (51.1) — back to running · 0 queued nudges drained
```

### 5.4 `beckett abort <task|worker>`

Hard-stop a worker (or a whole task), capturing partial state — work is never silently discarded
([Spec 03 §5.3](./03-control-plane-supervise.md#53-abortworker-reason--hard-stop--capture)).
**Destructive → confirmation required unless `--yes` (§6).**

```
beckett abort <task|worker> [flags]
```

| Arg/flag | Default | Meaning |
|---|---|---|
| `<task\|worker>` | required | Worker/node ref → that worker. Task ref → aborts **all** live workers on the task and marks the task aborted. |
| `--reason "<text>"` | — | Operator reason, logged + attributed (defaults to `"aborted via CLI by <user>"`). Recorded in `AbortState.reason`. |
| `--yes`, `-y` | off | Skip the confirmation prompt. |
| `--json` | — | Emit the `AbortState[]` (one per worker aborted). |

IPC → `WorkerControl.abort`: kills the process, snapshots `git diff` to the worktree branch, persists
`sessionId` + offset (resurrection/redispatch possible), writes final counters to the outcome log. What
happens *after* (re-dispatch ≤3 vs escalate) is owned by [Spec 04](./04-state-machine.md) — the abort
itself just stops + captures.

```
$ beckett abort 37.4
⚠ Abort w-3e1f (37.4, codex/gpt-5.6, running 22 turns)?
  Partial work (+540 / 7f) is preserved on the branch; the node may re-dispatch (retry 1/3).
  Continue? [y/N] y
✓ aborted w-3e1f — diff preserved on beckett/37.4 · session saved · reason: "aborted via CLI by jason"

$ beckett abort 42 --yes --reason "scope changed, re-planning"
✓ aborted task 42 — 2 workers stopped (w-7f3a, w-9c2d), diffs preserved, task marked aborted
```

Aborting a **task** is higher-blast-radius: the prompt names every worker it will kill, and (unless
`--yes`) requires confirmation even in scripts.

### 5.5 `beckett ask-plan <worker>`

Ask a running worker, mid-flight, for its current plan — the highest-leverage probe
([Spec 03 §5.4](./03-control-plane-supervise.md#54-ask_planworker--first-class-named-op)). A
first-class op, not just a nudge, because the reply is structured input to the next look. **Not
destructive → no confirmation.**

```
beckett ask-plan <worker> [flags]
```

| Flag | Default | Meaning |
|---|---|---|
| `--wait` | off | Wait for the worker's plan reply (Claude: next turn; Codex: see below) and print it, up to `--timeout`. |
| `--json` | — | Emit the receipt + (with `--wait`) the parsed plan. |

The asymmetry, surfaced (Spec 03 §5.4):

```
$ beckett ask-plan w-7f3a --wait
• asked w-7f3a (claude) — reading next turn…
✓ plan (turn 17): "Refactor the shared SessionCookie interface, then update all 14 call sites in one
   pass; run `bun test auth` before handing off. Leaving the legacy cookie path per your nudge."

$ beckett ask-plan w-9c2d
• w-9c2d (codex) can't be queried mid-turn — showing latest observed todo_list (no interruption):
   [x] scaffold auth.test.ts   [ ] cover refresh-token path   [ ] cover logout
   (to force a fresh plan at turn end, add --wait)
```

For Codex, the CLI **prefers harvesting the already-observed `todo_list`** from the stream (free, no
interruption); `--wait` enqueues the plan question for the next resume.

---

## 6. Safety model

| Op | Class | Confirmation |
|---|---|---|
| `ps`, `tail`, `status`, `tasks`, `logs`, `mem`, `doctor`, `daemon status` | read | none |
| `nudge`, `ask-plan` | soft / reversible | none (a nudge is *designed* to be safe; it lands at a boundary, context preserved) |
| `pause`, `resume` | reversible | none |
| `abort`, `daemon stop` | **destructive** | **prompt unless `--yes`** |
| `reload` | config | none (but see §7) |

- **Confirmation prompt:** an interactive `[y/N]` defaulting to **No**. Anything but `y`/`yes` → exit
  `6` (aborted by user). The prompt **always** states the blast radius (which worker(s), how much
  partial work, whether a re-dispatch will follow).
- **Non-TTY safety:** if stdin is not a TTY (script/pipe) and `--yes` is absent on a destructive op,
  the CLI **refuses** and exits `6` ("refusing to abort without confirmation; pass --yes") rather than
  hanging or silently proceeding. Destruction is never implicit.
- **`daemon stop`** confirms because it detaches all live workers (resume-safe, but still a fleet-wide
  action — §8).
- **Attribution:** every write carries `user_id` in the IPC envelope (§9), so the audit log
  ([Spec 09](./09-persistence-data-model.md)) records *who* nudged/aborted what — multiplayer-ready
  from day one even though v1 is single-user.

---

## 7. `beckett reload` (config) and `beckett daemon <start|stop|status>`

### 7.1 `beckett reload`

Ask the running daemon to re-read `config.toml`. IPC write command.

```
beckett reload [--json]
```

> ⚠️ **Hot-reload scope is the gap flagged in [Spec 01 §4](./01-architecture.md#4-becketconfigtoml-schema).**
> v1 contract: `reload` re-reads only the **live-safe** keys and reports which it applied vs which need
> a restart. Live-safe (applied): `[supervise].*` thresholds, `[discord].chattiness`/`escalate_after_s`,
> `[retry].*`, `[concurrency].queue_max`. **Restart-only** (reported, not applied): `[paths].*`,
> `[harness.*].bin`, `[models].*`, `[concurrency].max_workers`, anything that re-wires a live handle.
> Until the scope is finalized, `reload` prints exactly what it changed and what it ignored.

```
$ beckett reload
✓ reloaded config — applied: supervise.no_diff_K (3→4), discord.chattiness (sparse→normal)
  ignored (restart required): concurrency.max_workers (4→6)
```

### 7.2 `beckett daemon <subcommand>`

Lifecycle control for the daemon process itself.

```
beckett daemon start  [--foreground] [--json]
beckett daemon stop   [--yes] [--timeout <ms>] [--json]
beckett daemon status [--json]
```

| Subcommand | Channel | Behavior |
|---|---|---|
| `start` | **local** (not IPC) | Start the daemon. Default: invoke the systemd *user* service (`systemctl --user start beckett`, [Spec 01 §5.3](./01-architecture.md#53-supervision-on-loom-desk)); `--foreground` runs `bun .../daemon.js` attached for dev. No-op (exit 0) with a notice if already up (socket responds). The exact unit/install → [Spec 12](./12-roadmap-setup.md). |
| `stop` | **IPC** (graceful) | Send the `shutdown` command → daemon runs the graceful sequence ([Spec 01 §5.2](./01-architecture.md#52-shutdown-sequence-graceful-on-sigterm)): stop intake, quiesce to turn boundaries, checkpoint `session_id`+state, detach (workers resume-safe), unlink socket. **Confirms unless `--yes`** (§6). If the socket is already gone → falls back to `systemctl --user stop` and reports it. |
| `status` | **IPC** | Ping the socket; print uptime, pid, live worker/queue counts, Discord gateway state, recovery status. If the socket is absent → "daemon: not running" and exit `3` (so scripts can gate on it). This is the same ping `doctor` uses. |

**Sample:**

```
$ beckett daemon status
daemon: running · pid 4812 · uptime 3h12m · bun 1.3.13
  workers   2 running, 1 paused (cap 4)        queue   0
  discord   connected (last event 6s ago)      tasks   2 active
  recovery  clean (last boot re-attached 2 workers)

$ beckett daemon stop
⚠ Stop the daemon? 3 workers will be detached (resume-safe; they re-attach on next start). [y/N] y
✓ daemon stopped gracefully — 3 workers checkpointed, socket unlinked
```

`start` cannot go over the socket (the daemon isn't up yet) — it's the one daemon op that's purely
local. `stop`/`status` are IPC because they need the live process.

---

## 8. IPC protocol (CLI → daemon)

The write/control channel. The transport contract (unix socket, length-delimited JSON, one request per
connection, the split-by-read/write rationale) is fixed by
[Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon); **this section defines the
concrete command set, envelopes, and error handling.**

### 8.1 Transport

- **Socket:** unix-domain socket at `[paths].socket` (default `~/.beckett/beckett.sock`), perms
  `0600`, owned by the `beckett` user. No network exposure (chosen over a TCP port precisely to get OS
  file-perm access control for free, Spec 01 §7).
- **Framing:** one request per connection. **Length-prefixed JSON** — a 4-byte big-endian uint32 byte
  length, then that many bytes of UTF-8 JSON; the response is framed the same way; then the daemon
  closes the connection. (Newline-delimited JSON is an acceptable equivalent for a single-shot exchange;
  the length prefix is preferred so multi-line `reason`/`diff` payloads never need escaping.)
- **Versioning:** every request carries `proto` (currently `1`). The daemon rejects an unknown major
  with `{ok:false, error:{kind:"proto_mismatch"}}` so a stale CLI fails loud, not weird.

### 8.2 Request envelope

```ts
interface IpcRequest {
  proto:      1;
  request_id: string;     // uuid — echoed in the response; correlates in the audit log
  cmd:        IpcCmd;     // see §8.4
  args:       Record<string, unknown>;   // command-specific (resolved ids, message, reason, flags)
  user_id:    string;     // who issued it (audit + multiplayer attribution; Spec 00)
}
```

The CLI resolves human ids → concrete ids **before** sending (so the daemon receives a `workerId`/
`taskId`, not `"42.1"`); resolution failures exit `2`/`4` client-side without a socket round-trip.

### 8.3 Response envelope

```ts
interface IpcResponse {
  proto:      1;
  request_id: string;          // echoes the request
  ok:         boolean;
  data?:      unknown;         // on ok: the primitive's receipt (NudgeReceipt | Checkpoint | AbortState[] | StatusReport | …)
  error?: {                    // on !ok
    kind:    string;           // "not_found" | "illegal_state" | "proto_mismatch" | "internal" | …
    message: string;           // human reason (printed verbatim; e.g. Opus/driver detail)
    exit:    number;           // the exit code the CLI should use (maps to §1.4: 4,5,7,…)
  };
}
```

On `ok:false`, the CLI prints `error.message` to stderr and exits with `error.exit`. This keeps the
daemon the authority on *why* a command was rejected (it knows the worker's real state) while the CLI
stays a thin transport.

### 8.4 Command set

| `cmd` | Maps to | `args` | `data` on success |
|---|---|---|---|
| `nudge` | [Spec 03 §5.1](./03-control-plane-supervise.md#51-nudgeworker-msg--the-default-intervention) | `{workerIds[], text, source:"cli", dedupe}` | `NudgeReceipt[]` |
| `pause` | [Spec 03 §5.2](./03-control-plane-supervise.md#52-pauseworker--checkpoint--hold) | `{workerId}` | `Checkpoint` |
| `resume` | [Spec 04](./04-state-machine.md) transition | `{workerId}` | `{state:"running", drained:n}` |
| `abort` | [Spec 03 §5.3](./03-control-plane-supervise.md#53-abortworker-reason--hard-stop--capture) | `{workerIds[], reason}` | `AbortState[]` |
| `ask_plan` | [Spec 03 §5.4](./03-control-plane-supervise.md#54-ask_planworker--first-class-named-op) | `{workerId, wait}` | `NudgeReceipt` (+ `plan` if `wait`) |
| `reload` | [Spec 01 §4](./01-architecture.md#4-becketconfigtoml-schema) | `{}` | `{applied[], ignored[]}` |
| `status` | daemon introspection | `{}` | `StatusReport` (uptime, pid, counts, discord, recovery) |
| `shutdown` | [Spec 01 §5.2](./01-architecture.md#52-shutdown-sequence-graceful-on-sigterm) | `{}` | `{stopped:true, checkpointed:n}` |

Receipt shapes (`NudgeReceipt`, `Checkpoint`, `AbortState`) are defined canonically in
[Spec 03 §5](./03-control-plane-supervise.md#5-intervention-primitives-per-harness); the CLI renders
them (human) or passes them through (`--json`).

### 8.5 Error handling when the daemon is down

The split design means *read* commands never depend on the daemon:

- **Read command, daemon down:** works normally off the DB/JSONL snapshot. `ps`/`status` print a
  banner (`daemon: not running — data may be stale as of <as_of>`) so you know nothing is advancing,
  but the data is still served. No non-zero exit just for the daemon being down on a read.
- **Write command, daemon down:** socket `connect()` gets `ENOENT` (no socket file) or `ECONNREFUSED`
  (stale socket, no listener). The CLI prints `daemon not running — start it with 'beckett daemon
  start'` and exits **`3`**. It does **not** attempt the action any other way (only the daemon holds
  the live worker handle — a nudge is a write to *that process's* stdin).
- **Stale socket file** (daemon crashed without unlinking): `connect()` → `ECONNREFUSED`; the CLI
  reports it as down (exit `3`). The daemon unlinks a stale socket on next startup
  ([Spec 01 §5.1 step 5](./01-architecture.md#51-startup-sequence)); the CLI never deletes it (that's
  the daemon's file).
- **Timeout:** no response within `--timeout` → exit `7`. The request *may* have been enacted (e.g. a
  slow nudge enqueue) — the CLI says so ("timed out waiting for the daemon; the command may have been
  accepted — check `beckett ps`") and the operator re-checks via the read path. Nudge de-dupe
  ([Spec 03 §6.2](./03-control-plane-supervise.md#62-drain-boundaries--semantics)) makes a retried
  nudge safe.

---

## 9. Relationship to Discord slash commands (Spec 05)

**The CLI is canonical; Discord slash commands are a thin mirror.** Both funnel into the *same* two
channels (DB read / socket write) and the *same* Spec 03 primitives — there is no second control path.

| Aspect | `beckett` CLI | Discord slash (`/beckett …`, [Spec 05](./05-discord-interface.md)) |
|---|---|---|
| Surface | full (every command in this spec) | a **subset** — the glanceable/steering ones: `/beckett status`, `/beckett ps`, `/beckett nudge`, `/beckett abort` |
| Transport | DB read + unix socket | the daemon's in-process Discord handler calls the **same** internal control functions (it *is* the daemon, so it skips the socket) |
| Attribution | `user_id` = OS/CLI user | `user_id` = Discord user id |
| Output | tables / `--json` | compact embeds (Discord-formatted), same underlying data |
| Authority | **canonical** — the complete surface, scriptable | convenience for in-channel steering without leaving Discord |

The asymmetry surfacing (`queued` vs `delivered`, §5.1) is identical in both — a Codex nudge from
Discord shows "queued (applies at next turn end)" exactly as the CLI does, because both read the same
`NudgeReceipt`. Anything not exposed as a slash command (e.g. `tail`, `mem`, `doctor`, `daemon`) is
**CLI-only** by design — deep management lives off Discord (canon).

---

## 10. Open gaps ⚠️

- **⚠️ Socket auth = file perms only.** Single-user box ⇒ `0600` socket + OS user is the whole auth
  story today. The `user_id` in the IPC envelope is *attribution*, not *authentication*. When
  multiplayer / remote CLI lands, `user_id` needs real auth (token/mTLS over the socket or a
  Tailscale-fronted endpoint). Flagged jointly with [Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon).
- **⚠️ `mem search` ranking** (naive substring vs SQLite FTS5 vs the recall ranking Beckett itself
  uses) is owned by [Spec 08](./08-memory-knowledge-graph.md)/[Spec 09](./09-persistence-data-model.md) —
  this spec only fixes the command shape.
- **⚠️ `--watch`/`--follow` on the read path** poll DB/JSONL snapshots (no push from the daemon). For
  v1 that's fine; if it gets heavy, an optional socket *subscribe* channel (daemon→CLI event push)
  could back `tail`/`ps --watch` — deferred, would extend the §8 protocol.
- **⚠️ `daemon start`/`doctor --fix`** lean on the systemd unit + install layout, both owned by
  [Spec 12](./12-roadmap-setup.md). v1 `doctor --fix` is reserved (prints "not yet implemented").
- **⚠️ Node→worker resolution for retried nodes.** A node ref resolving to "current live worker" is
  unambiguous while one worker runs; if a future change ever allows two concurrent workers on one node
  (e.g. dual-provider cross-check, [open-questions B4], deferred), node refs would need a tie-break
  rule — out of scope for v1 (one worker per node).

---

## 11. Cross-links

- **[Spec 00 — Overview & Canon](./00-overview.md)** — mgmt-surface decision, economics (no $), durability, glossary.
- **[Spec 01 — Architecture](./01-architecture.md)** — daemon, process model, the two-channel IPC transport contract, `config.toml` `[paths]`, startup/shutdown the CLI drives.
- **[Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md)** — the `nudge/pause/abort/ask_plan` primitives + `NudgeReceipt`/`Checkpoint`/`AbortState` the write commands return, and the queued-vs-delivered asymmetry the CLI surfaces.
- **[Spec 04 — State Machine](./04-state-machine.md)** — worker/task state transitions (`running/paused/aborted`) the CLI reflects and triggers; post-abort re-dispatch.
- **[Spec 05 — Discord Interface](./05-discord-interface.md)** — the thin slash-command mirror over the same primitives.
- **[Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md)** — the model `beckett mem` browses.
- **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)** — the SQLite tables + JSONL events the read path queries; receipt/event persistence.
- **[Spec 12 — Roadmap & Setup](./12-roadmap-setup.md)** — install/symlink, `PATH`, the systemd unit `daemon start/stop` drive, auth persistence `doctor` checks.
