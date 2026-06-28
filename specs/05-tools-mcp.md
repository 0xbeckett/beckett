# Beckett — Spec 05: Tools & MCP

> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> The surface the parent agent acts through: the **`beckett-control`** MCP server (in-process in
> the shell, [Spec 01 §1.2](./01-runtime.md)) plus the **memory** and **identity** CLIs. These
> wrap the salvaged libraries + sandcastle so the agent's reasoning reaches real subprocess
> control. This replaces the v0.1 CLI/IPC controller surface.

---

## 1. `beckett-control` MCP server

Runs inside the bun shell; handed to the parent via `--mcp-config`. Each tool is a thin wrapper
over a salvaged lib or sandcastle. All tools return JSON; errors are structured (never throw at
the agent). Source: `src/mcp/beckett-control.ts`.

### Tool contract

| Tool | Input | Returns | Wraps |
|---|---|---|---|
| `spawn_worker` | `{harness, task, scope:{ownedGlobs,readGlobs?,description}, criteria, envelope, branch?}` | `{workerId, sessionId, branch, workspace}` | claude driver (claude) / sandcastle (codex,pi) + `worktree.ts` |
| `worker_status` | `{workerId}` or `{}` for all | `WorkerDigest[]` (see §1.1) | watcher counters |
| `read_worker_log` | `{workerId, lastTurns?:n, grep?}` | `{slice: WorkerEvent[]}` | worker session JSONL |
| `nudge_worker` | `{workerId, text}` | `{receipt: "delivered"\|"queued", at}` | driver stdin / sandcastle resume queue |
| `abort_worker` | `{workerId, reason}` | `{state: "aborted", sessionId}` | driver/sandcastle kill |
| `integrate` | `{workerIds[], targetBranch?}` | `{merged:bool, conflicts?:[…], checkResults?}` | git / sandcastle branch-merge |
| `discord_reply` | `{channelId?, text, replyToMsgId?}` | `{posted:bool, messageId}` | Discord gateway |
| `schedule_checkin` | `{workerId, afterTurns?, afterSecs?, reason}` | `{checkInId}` | watcher timers |

### 1.1 The worker digest (what the parent reads instead of logs)
```ts
interface WorkerDigest {
  workerId: string; harness: string; state: string;
  turns: number; toolCalls: number;
  lastAction: string;                 // "Edit src/auth/jwt.ts" — one line
  diff: { added: number; removed: number; files: number };
  alarms: { kind: string; firedAt: number; detail: string }[];
  criteriaSummary: string;            // what "done" is, condensed
  envelope: { turnCap; wallClockS; over: boolean };
  blocked?: string;                   // what it's stuck on, if anything
}
```
Compact by construction — this is the context-discipline mechanism from
[Spec 02 §5](./02-doctrine.md). `read_worker_log` is the escape hatch for a closer look.

### 1.2 Concurrency + admission
`spawn_worker` enforces the global `concurrency.max_workers` cap: over the cap it returns
`{queued:true, position}` rather than spawning, and the watcher signals the parent when a slot
frees. The **parent** decides priority among queued nodes (discretion); the shell only enforces
the ceiling.

### 1.3 Why MCP (not a unix socket CLI like v0.1)
The v0.1 design split read (direct SQLite) vs write (unix socket) for an *external* `beckett`
CLI driving a separate daemon. In v2 the *agent itself* is the controller, so the natural
surface is **tools it calls in its own loop**. MCP gives typed, in-context tools with structured
errors — the agent calls `spawn_worker` the way it calls `Read`. The shell holds the live worker
handles, so a nudge (a write to a worker's stdin) is a local function call, not an IPC hop.

---

## 2. Memory CLI (`beckett memory …`)

The knowledge graph ([Spec 06](./06-identity-memory.md)) is reached via a CLI the parent runs
with Bash, wrapping the salvaged `src/memory/index.ts`. CLI rather than MCP so the parent can
also just `Read`/`Grep`/`Write` the raw markdown when that's simpler, while ranking/dedup stays
in one place.

| Command | Purpose |
|---|---|
| `beckett memory recall "<query>" [--k N] [--hops 1]` | 3-tier recall → relevant nodes (index + scored hits + one-hop expansion). |
| `beckett memory remember --type <t> --name <n> --desc "<d>" [--body -] [--link a,b]` | Dedup-checked create/update; atomic write + backlinks + index regen + git commit. |
| `beckett memory reindex` | Rebuild `MEMORY.md` + SQLite mirror from the markdown tree. |

The `recall`/`remember` skills ([Spec 03](./03-skills.md)) tell the parent when to call these.

---

## 3. Identity CLI (`beckett gh …`, `beckett gmail …`)

Wraps the salvaged `src/agency/index.ts`. Every outward action is **classified** (FREE /
HANDSHAKE_GATED / ALWAYS_ASK, [Spec 06](./06-identity-memory.md)) before execution; the CLI is
the choke point so the policy can't be bypassed.

| Command | Class | Purpose |
|---|---|---|
| `beckett gh pr-open / pr-update / comment` | FREE | propose work (branch/PR/comment as `beckett-bot`). |
| `beckett gh merge <pr>` | HANDSHAKE_GATED | creates a pending action; executes only on `go`. |
| `beckett gh force-push <branch>` | depends | own `beckett/*` w/ open PR → gated; shared branch → ALWAYS_ASK. |
| `beckett gmail draft / label / triage` | FREE | read-side + drafting. |
| `beckett gmail send <draft>` | HANDSHAKE_GATED | creates a pending action; sends only on `go`. |

Pending actions persist in SQLite `(type, ctx)` and are surfaced to Discord by the parent via
`discord_reply`; the human's `go/decline/variant` resolves them ([Spec 06 §1.4](./06-identity-memory.md)).

---

## 4. What the parent has, end to end

- **Built-in Claude Code tools:** Read, Write, Edit, Bash, Glob, Grep (for inline work, git,
  running the CLIs, and editing memory markdown directly).
- **`beckett-control` MCP tools:** the worker control surface (§1).
- **CLIs via Bash:** `beckett memory …`, `beckett gh …`, `beckett gmail …`.
- **Skills:** the playbook ([Spec 03](./03-skills.md)) telling it how to use all of the above.

That set is deliberately small — the agent's intelligence carries the orchestration; the tools
just give its decisions hands.

## 5. Cross-references
- The shell that hosts this server → [Spec 01](./01-runtime.md)
- Worker mechanics each tool drives → [Spec 04](./04-workers-and-hooks.md)
- Action classes + handshake lifecycle + memory internals → [Spec 06](./06-identity-memory.md)
