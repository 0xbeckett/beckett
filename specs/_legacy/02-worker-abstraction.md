# Beckett — Spec 02: Worker Abstraction

> The atomic unit of Beckett. A **worker** = a harness instance + a scoped task + an isolated
> worktree + a resource envelope + acceptance criteria. This spec defines the `Worker` struct, the
> `HarnessDriver` interface, the two concrete drivers (`ClaudeDriver`, `CodexDriver`), telemetry
> normalization, scope enforcement, and resource-envelope mechanics — everything needed to spawn,
> steer, and abort a single worker. The DAG that composes workers, drift logic, and review live
> elsewhere (see cross-links).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Anchor: [Spec 00 — Overview & Canon](./00-overview.md). Research: [`../my-docs/`](../my-docs/)
> ([claude-code-headless.md](../my-docs/claude-code-headless.md),
> [codex-exec.md](../my-docs/codex-exec.md), [00-synthesis.md](../my-docs/00-synthesis.md)).

---

## 1. Scope of this spec & what it defers

| Concern | Owner |
|---|---|
| Worker struct, drivers, spawn/steer/abort, telemetry, scope enforcement, resource envelope | **This spec (02)** |
| When to nudge/pause/abort; smoke-alarms; check-ins; drift→read→decide | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| Acceptance-criteria *format*, tiered review, GATE, retry/escalate | [Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md) |
| SQLite schema, event-log durability, resume-on-restart | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| DAG execution, INTEGRATE, state machine | [Spec 04 — State Machine](./04-state-machine.md) |
| Process model, concurrency cap, daemon runtime | [Spec 01 — Architecture](./01-architecture.md) |

This spec exposes **mechanism** (how to drive one harness process). Spec 03 supplies **policy**
(when to intervene). The boundary is deliberate: the control plane only ever calls the typed
`HarnessDriver` control handles defined here.

Canon honored (Spec 00 §4): TypeScript on bun; shell out to both CLIs (no SDK embed in v1); Claude
nudge = stream-json user msg at turn boundary, abort = kill + `--resume`; Codex one-shot `exec` +
`exec resume`, nudge deferred; git worktree per worker; PreToolUse hook denies out-of-scope writes;
**no dollar budget** — scarce resources are rate limits + wall-clock + effort.

---

## 2. The `Worker` struct

The single in-memory + persisted record for one harness instance. Fields the orchestrator owns are
separated from fields the driver maintains.

```ts
// ── identity & assignment ────────────────────────────────────────────────
type Harness = 'claude' | 'codex';

// concrete driver implementation (NOT the SDK — canon: CLI-shell both in v1)
type DriverKind =
  | 'claude-cli-stream'   // claude -p, bidirectional stream-json (steerable)
  | 'codex-exec-oneshot'; // codex exec + exec resume (one-shot, deferred nudge)
  // 'codex-app-server' reserved for v2 (turn/steer) ⚠️ not built in v1 (Spec 00 §4 Codex steering)

type WorkerState =
  | 'spawning'   // worktree + process being created; no session_id yet
  | 'running'    // process alive, a turn in flight or idle awaiting input
  | 'nudging'    // a steer message is queued/written, not yet acked at a turn boundary
  | 'paused'     // checkpointed: process killed/idle, session_id retained, diff inspectable
  | 'review'     // turn loop ended, handed to REVIEW/GATE (Spec 11)
  | 'done'       // terminal: criteria satisfied (set by GATE, not the driver)
  | 'failed'     // terminal: harness error / max-turns / max-wall-clock without success
  | 'aborted';   // terminal: deliberately hard-stopped (Spec 03 decision)

interface Worker {
  id:        string;            // beckett-assigned, e.g. "wk_7f3a" (NOT the harness session id)
  nodeId:    string;            // DAG node this worker staffs (Spec 04)
  userId:    string;            // attribution — present from day one (Spec 00: multiplayer-ready)

  harness:   Harness;
  driver:    DriverKind;
  model:     string;            // exact launch model id, e.g. "claude-opus-4-9" / "gpt-5.6-codex"
                                // ⚠️ Codex does NOT emit the model in its stream (openai/codex#14736)
                                //    — this field is the source of truth for Codex.

  // ── session / resume (durability: persisted the instant it is known) ──────
  sessionId: string | null;     // claude: result.session_id / system.init.session_id (a UUID we may
                                //   pre-mint via --session-id). codex: thread.started.thread_id.
                                // null only while state==='spawning'.

  // ── isolation & scope ────────────────────────────────────────────────────
  scope:     FileScope;         // §6 — owned, non-overlapping paths
  workspace: string;            // absolute path to this worker's git worktree (its cwd)
  branch:    string;            // worktree branch, e.g. "beckett/wk_7f3a/<node-slug>"

  // ── envelope & criteria ──────────────────────────────────────────────────
  resourceEnvelope: ResourceEnvelope;   // §7 — effort / turnCap / wallClockS / network
  criteriaRef:      string;             // FK to acceptance criteria row (Spec 11). NOT inlined here.

  // ── live runtime ─────────────────────────────────────────────────────────
  state:     WorkerState;
  spend:     WorkerSpend;       // derived counters, updated from the event stream (§5)
  control:   WorkerControl;     // bound driver handles (the 3+1 primitives)

  // ── timestamps ───────────────────────────────────────────────────────────
  spawnedAt:      number;       // epoch ms
  lastActivityTs: number;       // epoch ms of last parsed WorkerEvent (watchdog input, §7.3)
  endedAt:        number | null;
}

interface FileScope {
  ownedGlobs:  string[];        // paths this worker MAY write, relative to repo root,
                                //   e.g. ["src/auth/**", "tests/auth/**"]
  readGlobs:   string[] | null; // optional explicit read allowlist; null = read anywhere in worktree
  description: string;          // NL scope for the criteria/reviewer ("the auth module only")
}

interface ResourceEnvelope {
  effort:    'low' | 'medium' | 'high' | 'xhigh'; // reasoning depth; mapped per harness (§7.1)
  turnCap:   number;            // hard ceiling on agent turns (--max-turns / watchdog, §7.2)
  wallClockS: number;           // watchdog kill threshold in seconds (§7.3)
  network:   boolean;           // outbound network allowed? default false, opt-in per node (§6.3)
}

// NOTE (Spec 00 §4 Economics): NO usd / budget field. Tokens are tracked for telemetry/rate-limit
// pressure only; cost is never a gate. Claude's total_cost_usd is informational.
interface WorkerSpend {
  turns:     number;            // completed agent turns
  toolCalls: number;            // tool invocations (tool_use / command_execution+file_change+mcp)
  tokens:    { input: number; output: number; cacheRead: number; cacheCreate: number };
  diffLines: { added: number; removed: number; files: number }; // from git, §5.4
  usdEstimate: number | null;   // claude only, informational; null for codex
}

interface WorkerControl {
  nudge(msg: string): Promise<NudgeReceipt>;  // soft steer
  pause(): Promise<void>;                       // checkpoint (idle/kill, keep session)
  resume(): Promise<void>;                      // re-attach after pause/restart
  abort(reason: string): Promise<void>;         // hard stop, capture partial
  askPlan(): Promise<NudgeReceipt>;             // sugar: nudge("what's your current plan?")
}

interface NudgeReceipt {
  accepted: 'delivered' | 'queued';  // claude→'delivered' (acked via --replay-user-messages) or
                                     //   'queued' (buffered); codex→always 'queued' (next resume)
  at: number;                        // epoch ms
}
```

`askPlan` is a named primitive because Spec 00 / open-questions flag it as the highest-leverage
mid-flight probe. It is instant for Claude (lands next turn), deferred for Codex (applied on next
`exec resume`).

---

## 3. The `HarnessDriver` interface

Both drivers implement this. The control plane (Spec 03) and DAG executor (Spec 04) never touch a
CLI directly — they hold a `HarnessDriver` and call these six methods. This is the seam that absorbs
the [harness asymmetry](../my-docs/00-synthesis.md) (Claude steerable mid-flight; Codex one-shot).

```ts
interface HarnessDriver {
  readonly kind: DriverKind;

  /** Create worktree (if not pre-made), launch the process, return once sessionId is known
   *  (claude: system/init line; codex: thread.started). Transitions spawning→running. */
  spawn(spec: SpawnSpec): Promise<SpawnResult>;

  /** Soft steer. claude: write a stream-json user line to stdin (lands next turn boundary).
   *  codex: enqueue; applied on the next exec resume. Returns delivered|queued. */
  sendNudge(msg: string): Promise<NudgeReceipt>;

  /** Checkpoint. claude: stop feeding stdin + (optionally) close it so the loop quiesces, keep
   *  sessionId for --resume. codex: a no-op while a turn runs (can only checkpoint at turn end);
   *  between turns it is already paused by nature. */
  pause(): Promise<void>;

  /** Hard stop. Both: SIGTERM→SIGKILL the process group. sessionId retained so the supervisor can
   *  inspect the partial diff and optionally re-dispatch via resume. */
  abort(reason: string): Promise<void>;

  /** Subscribe to the normalized event stream (§5). Returns an unsubscribe fn. The driver owns the
   *  raw JSONL parse; subscribers only ever see WorkerEvent. */
  onEvent(cb: (e: WorkerEvent) => void): () => void;

  /** Snapshot of derived counters (§5). Cheap; reads accumulators, runs `git diff --stat`. */
  getTelemetry(): WorkerSpend;
}

interface SpawnSpec {
  workerId: string;
  prompt:   string;             // the node task (initial user turn)
  systemAppend: string;         // criteria + scope + worker-persona (businesslike) — §4.3 / §4 below
  workspace: string;            // worktree path (driver creates it if absent, §6.1)
  scope:    FileScope;
  envelope: ResourceEnvelope;
  model:    string;
  sessionId?: string;           // optional caller-minted UUID (claude --session-id); else captured
  mcpConfigPath?: string;       // claude --mcp-config / codex [mcp_servers]
  doneSchemaPath: string;       // JSON-schema file for the structured done-signal (§4 / §5.5)
}

interface SpawnResult { sessionId: string; pid: number; }
```

Implementation note (bun): each driver wraps `Bun.spawn(...)` (or `child_process` under bun) and a
line-buffered reader over `stdout`. Drivers never block the daemon: stdout is consumed in an async
loop, each line parsed and fanned out via `onEvent`. The control plane attaches its read-only tail
through `onEvent`; intervention is always a separate, deliberate `sendNudge`/`pause`/`abort` call
(Spec 00 §3: observation decoupled from intervention).

---

## 4. ClaudeDriver — `claude -p` as a steerable worker

### 4.1 The exact invocation

Spawned with **cwd = the worktree** (`Bun.spawn({ cwd: workspace })`); that is how Claude is rooted
to the worktree. `--add-dir` is only for *extra* read/write roots beyond cwd (rarely needed).

```bash
claude -p \
  --input-format stream-json \      # stdin = NDJSON user-message channel (the nudge mechanism)
  --output-format stream-json \     # stdout = NDJSON event stream (telemetry, §5)
  --verbose \                       # REQUIRED for stream-json under -p
  --include-partial-messages \      # token-level deltas → live "is it moving?" signal (§5)
  --replay-user-messages \          # echo injected nudges back on stdout = the ACK channel (§4.4)
  --include-hook-events \           # surface PreToolUse gate decisions (scope-violation signal, §6)
  --permission-mode bypassPermissions \  # autonomous; safe because worktree + hook bound the blast radius
  --add-dir "$WORKSPACE" \          # (cwd is already $WORKSPACE; add-dir only if extra roots needed)
  --session-id "$WK_UUID" \         # caller-minted UUID so we own resume identity from t=0
  --append-system-prompt "$SYS_APPEND" \  # criteria + scope + worker persona (§4.3)
  --mcp-config "$MCP_CONFIG" \      # tool servers (e.g. Gmail) for this node
  --json-schema "$DONE_SCHEMA" \    # constrains the final result → structured done-signal (§5.5)
  --max-turns "$TURN_CAP"           # hard turn ceiling (§7.2). NO --max-budget-usd (no $ budget).
  # stdin is an open pipe; stdout is consumed line-by-line.
```

Spawned, not via a FIFO — the driver keeps a handle to the child's `stdin` and writes NDJSON lines.

⚠️ **`--effort` is not documented** in [claude-code-headless.md](../my-docs/claude-code-headless.md).
Claude effort is therefore expressed via **model tier** (`--model`), not a flag — see §7.1. If a
real `--effort` flag exists on the installed `claude 2.1.195`, wire it in `spawn()`; until verified,
do not depend on it.

⚠️ `--append-system-prompt` and `--add-dir` are standard `claude` CLI flags but are not enumerated in
the headless wire-format doc; verify against `claude --help` on loom-desk during setup (Spec 12).

We deliberately do **not** use `--bare`: it skips MCP/hook auto-load and forces `ANTHROPIC_API_KEY`,
but Beckett runs on the **subscription** login in `~/.claude` (Spec 00 §4 Secrets). We pass MCP and
the scope hook explicitly anyway, so `--bare` buys nothing and breaks subscription auth.

### 4.2 The scope hook is wired via settings, not a flag

`--permission-mode bypassPermissions` still honors **deny rules and hooks** (headless doc §4.2). The
PreToolUse scope hook (§6.2) is registered through a per-worker settings file passed with `--settings`
(or `--mcp-config`-adjacent settings); it is the hard boundary inside the worktree. See §6.2.

### 4.3 `--append-system-prompt` content (worker persona)

Internal worker prompts are **businesslike**, not the Beckett user-voice persona (Spec 00 §4 Persona).
The appended block carries three things:

```
You are an autonomous worker. Scope: you own and may modify ONLY: src/auth/**, tests/auth/**.
Treat everything else as read-only context. Do not edit files outside your scope; if you believe
you must, stop and say so instead.
Acceptance criteria (you are done when ALL hold): <NL criteria from Spec 11>.
When finished, emit the structured done-signal matching the provided schema.
```

### 4.4 Writing a nudge (exact stdin line)

A nudge is one NDJSON `user` message written to the child's stdin, newline-terminated:

```json
{"type":"user","message":{"role":"user","content":"Also keep backward-compat with the old session cookie"},"parent_tool_use_id":null}
```

```ts
// ClaudeDriver.sendNudge
async sendNudge(msg: string): Promise<NudgeReceipt> {
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: msg },
    parent_tool_use_id: null,
  }) + "\n";
  this.child.stdin.write(line);          // does NOT splice mid-turn/mid-tool
  this.worker.state = 'nudging';
  return { accepted: 'queued', at: Date.now() };
}
```

**Where it lands:** the message is *queued* and consumed at the **next turn boundary** — once the
current turn's tool batch resolves and control returns to the model. It never splices into an
in-flight model generation or a running tool (headless doc §2.2; ⚠️ exact turn-vs-tool granularity is
implementation-defined — design for turn-boundary latency).

**Ack:** because `--replay-user-messages` is set, the nudge is re-emitted on stdout as a `user`
line. The driver matches that echo (by content + arrival after the write) and flips the receipt
`queued → delivered`, returning `state` to `running`. This is how Spec 03 shows "delivered" vs
"buffered" in the supervise view.

```ts
// in the onEvent parse loop:
if (e.kind === 'user_echo' && e.text === pendingNudge.text) {
  pendingNudge.resolve({ accepted: 'delivered', at: Date.now() });
  this.worker.state = 'running';
}
```

### 4.5 Pause, abort, resume

- **pause():** stop writing stdin; optionally close stdin so the loop quiesces after the current
  turn. `sessionId` retained. The on-disk transcript at
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` is the durable checkpoint
  (`<encoded-cwd>` = the worktree path with every non-alphanumeric char → `-`). Diff inspection =
  `git diff` in the worktree.
- **abort(reason):** there is **no documented CLI interrupt wire format** (headless doc §2.3, §9). So
  abort = **kill the process** (SIGTERM → SIGKILL the group), keep `sessionId`. Partial work is on
  disk (worktree + transcript). To continue later, re-dispatch via resume.
- **resume():** relaunch the *same* invocation as §4.1 but swap `--session-id "$WK_UUID"` for
  `--resume "$sessionId"`, run from the **same cwd** (resume is cwd-scoped — a wrong cwd silently
  starts fresh). Full prior context is restored. A nudge held across a kill is delivered as the first
  user turn of the resumed run.

```bash
claude -p --resume "$SESSION_ID" \
  --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-hook-events \
  --permission-mode bypassPermissions --max-turns "$TURN_CAP"
# run with cwd == the worktree, exactly as the original spawn
```

---

## 5. CodexDriver — `codex exec` (one-shot) + `exec resume`

### 5.1 The exact invocation

```bash
codex exec \
  --json \                              # stdout = JSONL thread/turn/item events (§5, telemetry)
  -C "$WORKSPACE" \                     # --cd: root the run at the worktree (Codex's worktree binding)
  --sandbox workspace-write \           # write only inside cwd (+ $TMPDIR); network OFF by default
  --ask-for-approval never \            # never block on a prompt; forbidden ops just fail (no hang)
  --skip-git-repo-check \               # worktrees are valid git dirs but skip the guard to be safe
  --output-schema "$DONE_SCHEMA" \      # constrain final message → structured done-signal (§5.5)
  -o "$WORKSPACE/.beckett/last-message.txt" \  # also write final agent_message to a file (robust grab)
  -c model='"gpt-5.6-codex"' \          # model id (TOML-quoted string). Recorded in Worker.model too.
  -c model_reasoning_effort='"high"' \  # effort (§7.1)
  "$PROMPT"                             # the node task. (systemAppend is prepended into $PROMPT, §5.3)
```

Network opt-in (only when `envelope.network === true`, e.g. `npm install` / `git push`):

```bash
  -c sandbox_workspace_write.network_access=true \   # bare boolean — NOT quoted
```

⚠️ **No USD and no model name in the stream** (codex-exec.md §1.5): `turn.completed.usage` has token
counts only. `Worker.model` is the authoritative model record; `WorkerSpend.usdEstimate` is `null`
for Codex (no token→USD normalization — Spec 00 §4 Economics removed the USD ledger entirely).

⚠️ `--output-schema` can be **silently ignored or corrupted when MCP tools are active**
(openai/codex#15451, #19816): intermediate `agent_message`s are also forced into the schema. The
driver therefore **validates** the final-message JSON against the schema itself and falls back to
parsing `last-message.txt`; it never assumes conformance (§5.5).

### 5.2 No mid-run steering — nudge is deferred

`codex exec` is **strictly one-shot**: prompt in → run to completion → process exits. There is **no
stdin steering** (codex-exec.md §2). So:

```ts
// CodexDriver.sendNudge — deferred-by-design
async sendNudge(msg: string): Promise<NudgeReceipt> {
  this.nudgeQueue.push(msg);          // persisted (Spec 09) so a restart doesn't drop it
  return { accepted: 'queued', at: Date.now() };  // NEVER 'delivered' for codex in v1
}
```

The queued steer text is applied on the **next `exec resume`** — either when the current turn ends
naturally (the process exits, the driver restarts with resume + the queued text) or after an abort.
`turn/steer` via `codex app-server` (true mid-turn injection) is the documented upgrade and is
**deferred to v2** (Spec 00 §4; codex-exec.md §7). Honest UX: Codex nudges show "queued", never
"delivered" mid-turn — Spec 03 renders the asymmetry rather than faking parity.

### 5.3 systemAppend handling

Codex has no `--append-system-prompt`. The scope + criteria + worker-persona block (§4.3 content) is
**prepended into the prompt string**. AGENTS.md in the worktree can also carry standing scope rules,
but per-node criteria go inline in `$PROMPT` so they travel with resume.

### 5.4 Resume

```bash
codex exec resume "$THREAD_ID" \
  --json -C "$WORKSPACE" --sandbox workspace-write --ask-for-approval never \
  --skip-git-repo-check --output-schema "$DONE_SCHEMA" \
  -o "$WORKSPACE/.beckett/last-message.txt" \
  -c model='"gpt-5.6-codex"' -c model_reasoning_effort='"high"' \
  "$DEQUEUED_NUDGE_OR_FOLLOWUP"
```

Resume replays the rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`) — full transcript,
plan, and approvals are preserved (codex-exec.md §2.1). `$THREAD_ID` = `thread.started.thread_id`.
⚠️ Confirm id format vs. what `resume` expects on the installed `codex-cli 0.142.3`; archived
sessions may not appear in resume pickers (codex-exec.md §2.2).

### 5.5 Abort

Codex has no soft interrupt either — **abort = kill the process** (SIGTERM → SIGKILL). Because exec
is one-shot, "pause" is effectively "wait for `turn.completed`, then the process exits on its own";
`pause()` is a near no-op that just stops the driver from auto-resuming. Partial file edits are in
the worktree; the rollout file is the durable checkpoint for `resume`.

---

## 6. The structured done-signal (both harnesses)

Each node carries a JSON-schema file (`SpawnSpec.doneSchemaPath`) that the worker fills in when it
believes it is finished. Same schema shape for both harnesses; different plumbing.

```json
{
  "type": "object",
  "required": ["status", "summary", "filesChanged"],
  "properties": {
    "status":       { "type": "string", "enum": ["complete", "blocked", "partial"] },
    "summary":      { "type": "string" },
    "filesChanged": { "type": "array", "items": { "type": "string" } },
    "checksRun":    { "type": "array", "items": { "type": "string" } },
    "blockedReason":{ "type": "string" }
  }
}
```

- **Claude:** `--json-schema` → the validated object lands in `result.structured_output` (NOT
  `result.result`, which is free text). Extract from the `result` event.
- **Codex:** `--output-schema` → conforming JSON is the final `agent_message` text and is mirrored to
  `last-message.txt`. **Validate it yourself** (§5.1 caveat).

The done-signal feeds REVIEW/GATE (Spec 11); this spec only guarantees its emission and parse.

---

## 7. Telemetry: unified `WorkerEvent` stream

Both raw JSONL formats are normalized into one discriminated union so Spec 03's supervisor and the
CLI (`beckett tail`, Spec 10) consume a single shape regardless of harness.

```ts
type WorkerEvent =
  | { kind: 'session_started'; sessionId: string; model: string; ts: number }
  | { kind: 'turn_started';    ts: number }
  | { kind: 'assistant_text';  text: string; partial: boolean; ts: number }
  | { kind: 'tool_call';       tool: string; input: unknown; toolId: string; ts: number }
  | { kind: 'tool_result';     toolId: string; isError: boolean; ts: number }
  | { kind: 'file_change';     paths: { path: string; kind: 'add'|'update'|'delete' }[]; ts: number }
  | { kind: 'plan_update';     items: { text: string; done: boolean }[]; ts: number }
  | { kind: 'user_echo';       text: string; ts: number }   // claude --replay-user-messages ack
  | { kind: 'hook_decision';   decision: 'allow'|'deny'|'ask'|'defer'; reason?: string; ts: number }
  | { kind: 'turn_completed';  usage: TokenUsage; ts: number }
  | { kind: 'finished';        status: 'success'|'error'; subtype: string;
                               structuredOutput: unknown | null; usage: TokenUsage; ts: number }
  | { kind: 'error';           message: string; ts: number };

interface TokenUsage { input: number; output: number; cacheRead: number; cacheCreate: number; }
```

### 7.1 Claude → WorkerEvent (normalization table)

| Raw `claude -p` line | → `WorkerEvent.kind` | Mapping notes |
|---|---|---|
| `system` / `subtype:init` | `session_started` | `sessionId`=`session_id`, `model`=`model` |
| `assistant` (has `tool_use` block) | `tool_call` (one per `tool_use`) | `tool`=block.`name`, `toolId`=block.`id`; **dedup `assistant` lines by `message.id`** |
| `assistant` (text block) | `assistant_text` (`partial:false`) | from `message.content[].text` |
| `stream_event` `text_delta` | `assistant_text` (`partial:true`) | `--include-partial-messages`; live "is it moving" |
| `user` (tool_result content) | `tool_result` | `toolId`=`tool_use_id`, `isError`=`is_error` |
| `user` (replayed input) | `user_echo` | only when it matches a pending nudge (§4.4) |
| hook event (`--include-hook-events`) | `hook_decision` | `decision`=`permissionDecision`, `reason`=`permissionDecisionReason` |
| `result` | `finished` | `subtype` drives terminal state (table below); `structuredOutput`=`structured_output`; `usage` from `result.usage` |

Claude has no explicit per-turn `turn_started`/`turn_completed` line; the driver synthesizes
`turn_started` on the first `assistant` after a `tool_result` (or after init), and reads cumulative
turn count from `result.num_turns`. **File changes** are not a Claude event type — derive them from
`tool_call`s named `Edit`/`Write` and confirm via git (§7.4).

Claude `result.subtype` → terminal `WorkerState`:

| subtype | state |
|---|---|
| `success` | → `review` (handed to GATE) |
| `error_max_turns` | `failed` (turn cap hit) |
| `error_max_structured_output_retries` | `failed` (done-signal never validated) |
| `error_during_execution` | `failed` (resumable via `--resume`) |

⚠️ Effort: with `--effort` unverified, the envelope's `effort` maps to a **model tier** at spawn
(e.g. `high`/`xhigh`→`claude-opus-4-9`, `medium`/`low`→a Sonnet). Recorded in `Worker.model`.

### 7.2 Codex → WorkerEvent (normalization table)

| Raw `codex exec --json` event | → `WorkerEvent.kind` | Mapping notes |
|---|---|---|
| `thread.started` | `session_started` | `sessionId`=`thread_id`; **`model` injected from `Worker.model`** (not in stream) |
| `turn.started` | `turn_started` | — |
| `item.completed` `type:reasoning` | `assistant_text` (`partial:false`) | summarized reasoning (only if summaries on) |
| `item.completed` `type:agent_message` | `assistant_text` | the **final** one is the answer/done-signal |
| `item.started` `type:command_execution` | `tool_call` | `tool`="bash", `input`=`command`, `toolId`=`item.id` |
| `item.completed` `type:command_execution` | `tool_result` | `isError`=`status==='failed' \|\| exit_code!==0` |
| `item.completed` `type:file_change` | `file_change` | map `changes[].{path,kind}` directly |
| `item.*` `type:mcp_tool_call` | `tool_call`/`tool_result` | `tool`=`server/tool`; `isError`=`error!=null` |
| `item.*` `type:todo_list` | `plan_update` | `items[].{text, completed→done}` |
| `item.completed` `type:web_search` | `tool_call` | `tool`="web_search", input=`query` |
| `item.completed` `type:error` | `error` | item-level (e.g. truncated output) |
| `turn.completed` | `turn_completed` + (process exit) `finished` `success` | `usage`={input_tokens, cached_input_tokens→cacheRead, output_tokens, cacheCreate:0} |
| `turn.failed` / top-level `error` | `error`, then `finished` `error` | `message`=`error.message` |

Forward-compat: treat unknown `type` / `item.type` as skip-don't-crash (codex-exec.md §1.6). Codex
has no `cache_creation_input_tokens`; set `cacheCreate:0`.

### 7.3 Derived counters (`WorkerSpend`)

| Counter | Claude source | Codex source |
|---|---|---|
| `turns` | `result.num_turns` (live: count synthesized `turn_started`) | count `turn_completed` events (1 per exec run; sum across resumes) |
| `toolCalls` | count `tool_call` events (post-dedup) | count `command_execution` + `file_change` + `mcp_tool_call` items |
| `tokens` | `assistant.message.usage` per turn (dedup by `message.id`) + `result.usage` | `turn.completed.usage` (sum across turns/resumes) |
| `tokens.cacheRead/Create` | `cache_read_input_tokens` / `cache_creation_input_tokens` | `cached_input_tokens` / `0` |
| `diffLines` | git (§7.4) | git (§7.4) |
| `usdEstimate` | `result.total_cost_usd` (informational only) | **null** |
| `lastActivityTs` | ts of last WorkerEvent | ts of last WorkerEvent |

### 7.4 Diff size via git (harness-agnostic)

The truth of "what changed" is the worktree, not the stream. `getTelemetry()` shells:

```bash
git -C "$WORKSPACE" diff --numstat            # added\tremoved\tpath per file (uncommitted)
git -C "$WORKSPACE" diff --numstat --staged   # include staged
```

Sum columns → `{ added, removed, files }`. This is also the basis for Spec 03's no-diff-progress
smoke-alarm and for inspecting a paused worker.

---

## 8. Scope enforcement — "owns a non-overlapping scope," guaranteed

Three layers, defense-in-depth (Spec 00 §4 Scope enforcement):

### 8.1 Layer 1 — git worktree per worker (isolation + merge)

STAFF/DISPATCH (Spec 04) guarantees `ownedGlobs` are **non-overlapping across concurrent workers**
before any spawn — this is the structural guarantee; the hook/sandbox below enforce it at runtime.

```bash
# from the project repo root, once per worker:
cd /home/beckett/projects/<project>
git worktree add -b "beckett/wk_7f3a/<node-slug>" \
  ".beckett/worktrees/wk_7f3a" \
  "$BASE_REF"        # usually origin/main or the integration branch for this DAG
# → workspace = /home/beckett/projects/<project>/.beckett/worktrees/wk_7f3a
```

Each worker gets its own branch + working dir. INTEGRATE (Spec 04) is a real `git merge` of the
branches. Teardown after a terminal state: `git worktree remove <path> --force` (after the diff has
been captured/merged).

### 8.2 Layer 2 — Claude PreToolUse hook (deny out-of-scope writes)

A small script registered as a PreToolUse hook in the worker's settings file. It receives the tool
call on stdin, and **denies any write whose path escapes `ownedGlobs`**. `bypassPermissions` still
honors hook denies (headless doc §4.1–4.2), so this is a hard boundary even in autonomous mode.

```ts
#!/usr/bin/env bun
// scope-guard.ts — PreToolUse hook. Registered per worker; env carries the owned roots.
// settings.json: { "hooks": { "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
//                  "hooks": [{ "type": "command", "command": "bun /opt/beckett/scope-guard.ts" }] }] } }
import { minimatch } from "minimatch";

const OWNED = (process.env.BECKETT_OWNED_GLOBS ?? "").split(":").filter(Boolean); // "src/auth/**:tests/auth/**"
const ROOT  = process.env.BECKETT_WORKTREE!;                                      // absolute worktree path
const input = await Bun.stdin.json();           // { tool_name, tool_input, ... }

const tool = input.tool_name as string;
const ti   = input.tool_input ?? {};

// collect candidate write targets per tool
let targets: string[] = [];
if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
  targets = [ti.file_path ?? ti.notebook_path].filter(Boolean);
} else if (tool === "Bash") {
  // best-effort: deny obvious writes outside scope; rely on workspace cwd for the rest.
  // (Bash is the leaky tool — see §8.4. Heuristic: flag redirections / mutating cmds to abs paths.)
  const cmd = String(ti.command ?? "");
  const m = cmd.match(/(?:>>?|--output[= ]|-o\s+)\s*("?)(\/[^\s"']+)/g) ?? [];
  targets = m.map(s => s.replace(/.*?(\/[^\s"']+).*/, "$1"));
}

const norm = (p: string) => (p.startsWith("/") ? p : `${ROOT}/${p}`);
const rel  = (p: string) => norm(p).startsWith(ROOT + "/") ? norm(p).slice(ROOT.length + 1) : null;

for (const t of targets) {
  const r = rel(t);
  const outsideWorktree = r === null;                                  // absolute path escapes worktree
  const outsideScope = r !== null && !OWNED.some(g => minimatch(r, g));
  if (outsideWorktree || outsideScope) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Out of scope: ${t} is not within your owned paths (${OWNED.join(", ")}). ` +
          `Stay inside your worktree scope or stop and report you need it.`,
      },
    }));
    process.exit(0);   // deny wins; surfaced as a hook_decision event (§7.1) → scope-violation alarm
  }
}
console.log(JSON.stringify({})); // empty = pass through to normal permission flow (allowed)
```

Every `deny` surfaces as a `hook_decision` WorkerEvent (because `--include-hook-events` is set),
which is exactly Spec 03's **scope-violation smoke-alarm** input.

### 8.3 Layer 3 — Codex sandbox rooting

Codex needs no hook: `--sandbox workspace-write -C "$WORKSPACE"` confines all writes to the worktree
(cwd) at the OS level; network is OFF unless opted in (§6.3 / §5.1). The worktree *is* the sandbox
root. `ownedGlobs` finer than "the whole worktree" are enforced by the **non-overlapping worktree
assignment** (Layer 1) plus the prepended scope instruction (§5.3) — Codex can't write outside the
worktree at all, and inside it the node is the only writer.

### 8.4 Known leak & network (⚠️)

- ⚠️ **Bash is the leaky tool for Claude.** The hook's path-matching for `Bash` is heuristic
  (redirections/`-o`/`--output`); a determined `bash -c` could still write outside `ownedGlobs`
  *within the worktree*. The worktree boundary (so no other worker's files exist there) plus
  non-overlapping assignment make this low-risk in v1; containers are the real fix and are deferred
  (Spec 00 §8). For Codex, the OS sandbox covers Bash uniformly — no leak.
- **Network is default-OFF, opt-in per node.** Claude: governed by the tool allowlist + hook (no
  built-in network jail). Codex: `-c sandbox_workspace_write.network_access=true` only when
  `envelope.network`. Nodes needing `npm install`/`git push` declare it at PLAN time (Spec 04).

---

## 9. Resource-envelope mechanics

No dollars (Spec 00 §4). The envelope bounds **effort**, **turns**, **wall-clock**, and **network**.

### 9.1 Effort

| `envelope.effort` | Claude | Codex |
|---|---|---|
| `low` / `medium` | model tier = Sonnet via `--model` (⚠️ no `--effort` flag verified) | `-c model_reasoning_effort='"low"'` / `'"medium"'` |
| `high` / `xhigh` | model tier = Opus via `--model` | `-c model_reasoning_effort='"high"'` / `'"xhigh"'` |

`Worker.model` always records the exact launch model (mandatory for Codex — not in its stream).

### 9.2 Turn cap

- **Claude:** `--max-turns "$TURN_CAP"` → on hit, `result.subtype = "error_max_turns"` →
  `WorkerState.failed`. Live count from synthesized `turn_started` / `result.num_turns`.
- **Codex:** no native turn cap on `exec`. The driver enforces it by counting `turn_completed`
  events across resumes; when the count reaches `turnCap`, it **stops auto-resuming** and marks the
  worker `failed`/`review` rather than dispatching another `exec resume`.

### 9.3 Wall-clock watchdog

Driver-side, harness-agnostic. A timer started at spawn; reset is **not** automatic — instead the
watchdog reads `Worker.lastActivityTs` (updated on every WorkerEvent):

```ts
// per-worker watchdog (driver owns the timer; runs every ~5s)
const idleS  = (Date.now() - worker.lastActivityTs) / 1000;
const totalS = (Date.now() - worker.spawnedAt) / 1000;
if (totalS > envelope.wallClockS) {
  await worker.control.abort(`wall-clock cap ${envelope.wallClockS}s exceeded`);
}
// (a separate idle threshold — no events for N s — is a Spec 03 smoke-alarm, not a hard kill)
```

Hard wall-clock kill is a driver guarantee (no run exceeds `wallClockS`). The *softer* "no progress"
read is delegated to Spec 03 (it decides nudge vs pause vs abort). Abort here = the §4.5 / §5.5 kill
path; `sessionId` retained so Spec 04 can re-dispatch if the node still needs doing.

---

## 10. Lifecycle & walkthroughs

### 10.1 State diagram

```
                 spawn()
   (none) ───────────────────▶ spawning
                                  │ sessionId captured (init / thread.started)
                                  ▼
        ┌──────────────────▶ running ◀───────────┐
        │                     │  │  │             │ resume()
        │        sendNudge()  │  │  │ pause()     │
        │        ┌────────────┘  │  └──────────▶ paused
        │        ▼               │                │
        │     nudging ──ack──────┘                │ abort()/watchdog
        │   (delivered|queued)                    ▼
        │                                      aborted (terminal)
        │ result success / final agent_message
        ▼
      review ──▶ (GATE: Spec 11) ──▶ done (terminal)
        │                                  
        └── result error / max-turns / max-wall-clock ──▶ failed (terminal)
```

`done` is set by GATE (Spec 11), not the driver. `failed`/`aborted` are driver/watchdog terminals.
Both `paused` and `aborted`/`failed` keep `sessionId` so re-dispatch via resume is always possible.

### 10.2 Claude: spawn + steer + abort (pseudocode)

```ts
const wkUuid = crypto.randomUUID();
const ws = await mkWorktree(project, "wk_7f3a", baseRef);   // §8.1
const driver = new ClaudeDriver(worker);

// spawn — cwd is the worktree; hook + persona + done-schema attached
await driver.spawn({
  workerId: "wk_7f3a", prompt: nodeTask, systemAppend: scopeCriteriaPersona,
  workspace: ws, scope, envelope, model: "claude-opus-4-9",
  sessionId: wkUuid, mcpConfigPath, doneSchemaPath,
});
// → process running with: --input-format stream-json --output-format stream-json --verbose
//   --include-partial-messages --replay-user-messages --include-hook-events
//   --permission-mode bypassPermissions --session-id <wkUuid> --append-system-prompt ...
//   --mcp-config ... --json-schema <done> --max-turns <cap>;  PreToolUse=scope-guard.ts

driver.onEvent(e => supervisor.ingest(worker, e));         // read-only tail (Spec 03)

// steer (Spec 03 decided to) — lands next turn boundary, ack via --replay-user-messages
const r = await driver.sendNudge("keep backward-compat with the old session cookie");
// r.accepted: 'queued' → flips to 'delivered' when the user_echo arrives

// abort — no soft interrupt; kill + retain sessionId
await driver.abort("rewriting auth layer it doesn't own");  // SIGTERM→SIGKILL
// later, re-dispatch with corrective nudge as first turn:
//   claude -p --resume <sessionId> ... (same cwd)  → first user msg = the corrective instruction
```

### 10.3 Codex: spawn + steer + abort (pseudocode)

```ts
const ws = await mkWorktree(project, "wk_9c2b", baseRef);
const driver = new CodexDriver(worker);

await driver.spawn({
  workerId: "wk_9c2b", prompt: scopeCriteriaPersona + "\n\n" + nodeTask,  // §5.3 prepend
  systemAppend: "", workspace: ws, scope, envelope, model: "gpt-5.6-codex",
  mcpConfigPath, doneSchemaPath,
});
// → codex exec --json -C <ws> --sandbox workspace-write --ask-for-approval never
//   --skip-git-repo-check --output-schema <done> -o <ws>/.beckett/last-message.txt
//   -c model='"gpt-5.6-codex"' -c model_reasoning_effort='"high"' "<prompt>"
//   (+ -c sandbox_workspace_write.network_access=true  iff envelope.network)

driver.onEvent(e => supervisor.ingest(worker, e));

// steer — DEFERRED. Queued, applied on next resume (never mid-turn in v1).
const r = await driver.sendNudge("also fix any lint errors you hit");   // r.accepted = 'queued'

// when this exec exits at turn.completed, the driver auto-resumes with the dequeued nudge:
//   codex exec resume <threadId> ... "also fix any lint errors you hit"

// abort — kill (no soft interrupt). rollout JSONL is the checkpoint.
await driver.abort("over wall-clock");   // SIGTERM→SIGKILL
// re-dispatch later: codex exec resume <threadId> ... "<corrective instruction>"
```

---

## 11. Open gaps (⚠️ summary)

| Gap | Status |
|---|---|
| Claude `--effort` flag | ⚠️ not in headless doc; effort via `--model` tier until verified on loom-desk |
| Claude `--append-system-prompt`, `--add-dir`, `--settings` | ⚠️ standard flags but unverified in wire-format doc; confirm via `claude --help` (Spec 12) |
| Claude CLI interrupt | ⚠️ none documented → abort = kill+`--resume` (canon) |
| Codex model name in stream | ⚠️ absent (#14736) → `Worker.model` is source of truth |
| Codex USD | ⚠️ none → `usdEstimate=null`; no token→USD (canon: no $ budget) |
| Codex `--output-schema` + MCP | ⚠️ may be ignored/corrupted (#15451, #19816) → validate ourselves + `-o` file |
| Codex `resume` id format / archived sessions | ⚠️ verify on `codex-cli 0.142.3` |
| Bash write-leak inside worktree (Claude) | ⚠️ heuristic hook; containers (deferred) are the real fix |
| Codex true mid-turn steer (`app-server` `turn/steer`) | ⚠️ v2 upgrade; v1 = deferred nudge via resume |

---

## 12. Summary

1. A **Worker** = `{harness, driver, sessionId, FileScope, worktree, ResourceEnvelope, criteriaRef,
   WorkerState, WorkerSpend, control}` — the atomic unit; everything composes into a DAG (Spec 04).
2. One **`HarnessDriver`** interface (spawn/sendNudge/pause/abort/onEvent/getTelemetry) absorbs the
   Claude-vs-Codex asymmetry behind a typed seam the control plane calls.
3. **ClaudeDriver** = long-lived `claude -p` with bidirectional stream-json; nudge = stdin user line
   landing at the next turn boundary (acked via `--replay-user-messages`); abort = kill + `--resume`;
   autonomy = `bypassPermissions` bounded by a PreToolUse scope hook.
4. **CodexDriver** = one-shot `codex exec --json -C <worktree> --sandbox workspace-write
   --ask-for-approval never`; nudge is **deferred** (queue → next `exec resume`); abort = kill;
   network opt-in; no USD / no model in stream.
5. Both JSONL formats normalize into one **`WorkerEvent`** union + derived counters (turns,
   toolCalls, tokens, git-diff size, lastActivityTs); scope enforced by **worktree + hook (Claude) /
   OS sandbox (Codex)**; the envelope bounds **effort / turnCap / wall-clock**, never dollars.
6. Deferred to siblings: when-to-intervene (03), criteria/review (11), persistence (09), DAG/integrate (04).
</content>
</invoke>
