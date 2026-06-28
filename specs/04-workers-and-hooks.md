# Beckett — Spec 04: Workers & Hooks

> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> The worker layer: how a child agent is spawned, isolated, steered, and observed. v2 is
> **hybrid** — the salvaged Claude driver is the steerable primary; **sandcastle** spawns
> non-Claude workers and provides sandboxes + branch-merge. Folds the v0.1 worker-abstraction +
> control-plane specs into one. Honors [Spec 00](./00-overview.md).

---

## 1. The worker

The atomic unit. The parent creates one via `spawn_worker` ([Spec 05](./05-tools-mcp.md)); the
shell materializes it as a subprocess in a git worktree.

```ts
interface Worker {
  id: string;                 // "wk_7f3a"
  harness: "claude" | "codex" | "pi";
  driver: "claude-cli-stream" | "sandcastle";
  sessionId: string;          // for resume; persisted at spawn BEFORE streaming
  scope: { ownedGlobs: string[]; readGlobs?: string[]; description: string };
  workspace: string;          // absolute worktree path
  branch: string;
  envelope: { effort: "low"|"medium"|"high"|"xhigh"; turnCap: number; wallClockS: number; network: boolean };
  criteria: AcceptanceCriteria;  // Spec 03
  state: "spawning"|"running"|"nudging"|"paused"|"review"|"done"|"failed"|"aborted";
  spend: { turns; toolCalls; tokens; diffLines: {added,removed,files}; usdEstimate };
}
```

**Resource envelope:** `effort` → model tier + reasoning level; `turnCap` is a hard ceiling;
`wallClockS` is a watchdog kill threshold; `network` is off by default, opt-in per worker.
Envelopes are **estimates the watcher uses as a prompt-to-look**, never a silent kill switch
(except the hard `turnCap`/`wallClockS` ceilings).

---

## 2. The two spawn paths (hybrid)

### 2.1 Claude workers → salvaged driver (`src/drivers/claude.ts`)
The steerable primary. Already implements spawn / nudge / pause / resume / abort and JSONL→event
normalization. Spawned as a long-lived stream-json process:

```bash
claude -p --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-hook-events \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Bash,Glob,Grep" \
  --session-id "$WORKER_UUID" \
  --append-system-prompt "$CRITERIA_AND_SCOPE_AND_TASK" \
  --max-turns "$TURN_CAP"
  # PreToolUse scope-guard hook + PostToolUse telemetry hook installed in the worktree's .claude/
```

- **Nudge** = write a `user` NDJSON line to stdin → lands at the **next turn boundary**;
  `--replay-user-messages` echo flips the receipt `queued → delivered`.
- **Pause** = stop writing stdin (process stays alive). **Resume** = `--resume <sessionId>` from
  the same cwd; nudges buffered across a kill are delivered as the first turn.
- **Abort** = SIGTERM → SIGKILL (no documented CLI soft-interrupt); session kept for resume.

### 2.2 Codex / pi workers → sandcastle
Run-to-completion harnesses. sandcastle owns spawn + sandbox provider + branch/merge:

```ts
import { run, codex, pi } from "@ai-hero/sandcastle";
const result = await run({
  agent: codex("gpt-5.1-codex"),          // or pi(...)
  sandbox: docker(),                      // or no-sandbox for worktree-only isolation
  prompt: workerPrompt,                   // criteria + scope + task
  branchStrategy: { type: "branch", branch: worker.branch },
  maxIterations: turnCap,
  output: Output.object({ ... }),         // structured done-signal
});
```

- **Nudge** for these is **checkpoint + resume between runs** (sandcastle `result.resume?(...)`),
  not mid-turn — accepted tradeoff per the harness-asymmetry research ([`../my-docs/00-synthesis.md`](../my-docs/00-synthesis.md)).
- **Sandbox** = Docker/Podman (bind-mount) or Vercel (isolated) when blast-radius isolation is
  wanted; `no-sandbox` keeps just the worktree.
- **Resume / fork** = `result.resume?()` / `result.fork?()` for retry and parallel variants.

> The shell normalizes **both** paths into the same `Worker` + telemetry shape so the parent's
> `worker_status` digest is uniform regardless of harness.

---

## 3. Scope isolation (three layers)

1. **Git worktree per worker** with non-overlapping `ownedGlobs` assigned at staff time — the
   structural guarantee. `src/worker/worktree.ts` (salvaged) allocates branch + worktree under
   `<project>/.beckett/worktrees/<worker>/`.
2. **PreToolUse scope-guard hook** (`src/hooks/scope-guard.ts`, salvaged, already standalone):
   denies `Edit|Write|MultiEdit|NotebookEdit` and Bash write-redirections that escape
   `ownedGlobs` (minimatch); denies unresolvable shell expansion (`$`, `~`, backtick); allows
   pure sinks (`/dev/null`). **Every deny emits a `hook_decision` event** → a scope-violation
   smoke-alarm input. Configured per-worktree via env (`BECKETT_WORKTREE`, `BECKETT_OWNED_GLOBS`).
3. **OS sandbox** for codex/sandcastle workers (`workspace-write`, network off unless opted in)
   — and Docker via sandcastle for genuinely untrusted contexts.

> ⚠️ Known gap (deferred): a determined Bash command could still write within the worktree
> outside its owned globs. Containers (sandcastle Docker) are the real fix; v2 ships the hook
> heuristic + worktree boundary and reaches for Docker when isolation matters.

---

## 4. Observation: hooks → digests → smoke-alarms

The parent never tails raw logs. The pipeline that keeps it informed:

### 4.1 Worker hooks emit compact telemetry
Each worktree's `.claude/` carries, besides scope-guard:
- A **PostToolUse / Stop** hook that appends one-line JSON events to
  `~/.beckett/workers/<id>/events.jsonl` and updates `status.json` (turns, last action, diff
  stats, alarm-relevant counters, blocked/error flags). Compact by design.

### 4.2 The watcher digests + alarms (`src/shell/watcher.ts`)
Tails `events.jsonl` + the worker's session JSONL, maintains counters, and computes
**smoke-alarms** (thresholds in `config.toml [supervise]`, carried forward from v0.1):

| Alarm | Predicate | Default |
|---|---|---|
| `no_diff_progress` | ≥K turns since the diff last grew by ≥64 bytes | K=3 |
| `over_envelope` | turns > target×factor OR wall-clock > wallClockS×factor | factor=1.5 |
| `repeated_tool_calls` | ≥N near-identical consecutive tool calls (Jaccard ≥0.9) | N=3 |
| `scope_violation` | a hook/sandbox write-deny fired | on first |
| `blocked` / `stale` | error/blocked flag, or no activity > stale_secs | 180s |

Debounce: per-kind per-worker cooldown 120s; coalesce same-worker alarms within 2s into one
look; `scope_violation`/`blocked` bypass the coalesce delay (urgent). On an alarm (or a fired
**check-in**), the watcher injects a compact **signal** onto the parent's stdin — e.g.
`[signal wk_7f3a] no_diff_progress: 3 turns, last action Read x4`.

### 4.3 The parent reads digests, decides
The parent wakes on the signal, calls `worker_status` for the digest, optionally
`read_worker_log` for a transcript slice, and applies the `supervise` skill
([Spec 03](./03-skills.md)) to decide continue/nudge/pause/abort/reschedule. **Observation ≠
intervention**: tailing is continuous and free; nudge/pause/abort are separate deliberate writes
the parent makes via tools.

---

## 5. Control primitives (what the parent can do to a worker)

| Primitive | Tool | Claude worker | Codex/pi worker (sandcastle) |
|---|---|---|---|
| spawn | `spawn_worker` | long-lived stream-json process | `run()` / `createSandbox()` |
| nudge | `nudge_worker` | stdin user msg @ next turn (ack via replay echo) | queued → applied on next resume |
| pause | (via nudge/abort semantics) | stop writing stdin | let the run finish, don't resume |
| abort | `abort_worker` | SIGTERM→SIGKILL, keep session | kill process, keep thread id |
| resume | (recovery / re-dispatch) | `--resume <id>` from worktree | `result.resume?()` |
| observe | `worker_status` / `read_worker_log` | normalized events + JSONL | normalized events + sandcastle logs |
| integrate | `integrate` | git merge worktree branch | sandcastle branch-merge |

Telemetry is normalized into a unified `WorkerEvent` stream (`session_started`, `turn_started`,
`turn_completed`, `tool_call`, `tool_result`, `file_change`, `hook_decision`, `user_echo`,
`finished`, `error`) — Claude dedup'd by `message.id`, codex forward-compat-skipping unknown
item types and validating its final structured message.

---

## 6. Integrate

A first-class phase on the heavy path. The `integrate` tool:
1. Merges the project branch into the node branch (cheap conflict surface), then the node branch
   into the project branch (`--no-ff`, one commit per node). sandcastle's branch-merge handles
   its own workers.
2. Re-runs the node's executable checks post-merge.
3. **On conflict** (textual git OR interface-contract mismatch): the parent spawns an
   integration worker with both diffs + the interface contract + conflict markers; success →
   review; failure → escalate (origin = supervise).

---

## 7. Recovery
Workers persist `sessionId` at spawn **before** streaming, so a shell/parent crash re-attaches
via `--resume` / sandcastle resume from the worktree, rebuilding watcher counters from
`workers/<id>/`. Loss ≤ 1 in-flight turn. Full sequence → [Spec 01 §5.3](./01-runtime.md).

## 8. Cross-references
- Tool contract for every primitive above → [Spec 05](./05-tools-mcp.md)
- When/why the parent spawns & supervises → [Spec 02](./02-doctrine.md)
- Criteria/review the worker is held to → [Spec 03](./03-skills.md)
- Harness wire-format details (claude/codex JSONL) → [`../my-docs/`](../my-docs/)
