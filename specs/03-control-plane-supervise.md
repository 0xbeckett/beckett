# Beckett — Spec 03: Control Plane & Supervise

> **The intelligence of the loop.** This spec defines how Beckett *watches* its workers without
> interfering, *notices* when one drifts, *thinks* about whether the drift matters, and only then
> *acts*. The governing rule, from [Spec 00 §4 — "Supervise"](./00-overview.md#4-canonical-decisions-the-ledger):
> **observation is decoupled from intervention.** Tailing is free and continuous; nudge/pause/abort
> are separate, deliberate, logged writes.
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Canon: [Spec 00](./00-overview.md). Research: [`../my-docs/00-synthesis.md`](../my-docs/00-synthesis.md),
> [`claude-code-headless.md`](../my-docs/claude-code-headless.md), [`codex-exec.md`](../my-docs/codex-exec.md).

---

## 0. Where this sits

This is the `SUPERVISE` box of the canonical loop ([Spec 00 §3](./00-overview.md#3-the-loop-canonical-state-machine)):

```
… → DISPATCH → SUPERVISE ⇄ (nudge / pause / abort) → INTEGRATE → …
                  │
                  └── escalation-to-Jason reachable from here
```

Three layers, strictly separated, each its own §:

| Layer | Cost | Runs | What it does | §|
|---|---|---|---|---|
| **Observation** | free | always, per worker | tail JSONL read-only → maintain counters | §1 |
| **Triggering** | ~free | always | smoke-alarms (mechanical) + check-ins (scheduled) fire a *look* | §2–3 |
| **Decision** | Haiku + Opus | only on a fire | summarize → Opus reads → structured verdict | §4 |
| **Intervention** | a write | only on a verdict | nudge / pause / abort / ask_plan | §5–6 |

A fire never produces an automatic verdict. A look always passes through Opus before any write. That
gap is the whole point: it's what stops Beckett from cheap-stopping good work (§7).

**Boundaries (defer):**
- Driver mechanics — spawn flags, stdin wiring, `--resume`, JSONL paths → **[Spec 02 — Worker Abstraction](./02-worker-abstraction.md)** ⚠️ *(not yet written; driver facts below are sourced from `my-docs/` and must stay consistent with 02 once it lands).*
- How Opus is actually invoked (model routing, `claude -p --json-schema`, prompt assembly, Haiku front-door) → **[Spec 06 — Brain & Models](./06-brain-models.md)**.
- Worker/node *state transitions* (`running→paused→…`) and DAG sequencing → **[Spec 04 — State Machine](./04-state-machine.md)**.
- The accept/reject decision against criteria → **[Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md)**.
- SQLite DDL for the tables referenced here → **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)**.
- CLI surface (`beckett tail`, `beckett nudge`) that reflects this layer → **[Spec 10 — CLI](./10-cli.md)**.

All thresholds in this doc are **defaults in `~/.beckett/config.toml`** and tunable at runtime. The
canonical `[supervise]` block is in §8.

---

## 1. The observation model

### 1.1 Principle

Every worker, the instant it spawns ([Spec 02]), gets exactly **one** `Observer`. The Observer is a
**read-only consumer**. It never writes to the worker's stdin, never touches its workspace, never
holds a lock the worker needs. If the Observer crashes, the worker is unaffected; if the worker
crashes, the Observer flushes final counters and exits. This is non-negotiable — it is the
"non-invasive observation" canonical decision.

### 1.2 Two data sources, stream-primary

Per [`my-docs` D3 → decided], the Observer reads from **both** and treats the live stream as primary:

| Source | Use | Latency |
|---|---|---|
| **Live stdout stream** (`stream-json` for claude, `--json` JSONL for codex) | real-time counter updates; the hot path | per-line |
| **On-disk transcript** (`~/.claude/projects/<enc-cwd>/<id>.jsonl` / `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`) | durable record; the slice Opus reads on a "go look"; recovery after restart | persisted |

The stream gives cheap real-time counters. The on-disk transcript is the **system of record** for
"Opus, go read the last 3 turns" (§4) and survives a daemon restart (re-tail from a saved byte
offset — see [Spec 09] for the offset persistence). The Observer normalizes both harnesses' event
vocabularies into one counter set so the rest of the control plane is harness-agnostic.

### 1.3 The unified counter set (`WorkerCounters`)

One struct per worker, updated on every observed event, persisted on change (so a restart loses ≤ the
current in-flight turn, per [Spec 00 durability]). This is the **single source of truth that
smoke-alarms read**; it is deliberately small, mechanical, and cheap.

```ts
interface WorkerCounters {
  workerId:            string;
  nodeId:             string;
  harness:            'claude' | 'codex';

  // ── progress / activity ──────────────────────────────────────────
  turns:              number;        // completed turns (claude: result/turn boundaries; codex: turn.completed)
  toolCalls:          number;        // total tool invocations observed
  lastActivityTs:     number;        // epoch ms of the last observed event of ANY kind
  lastTurnEndTs:      number;        // epoch ms of the last turn boundary

  // ── change / diff progress ───────────────────────────────────────
  diffBytes:          number;        // cumulative bytes changed in the worktree (git diff --numstat, sampled at turn end)
  filesChanged:       number;        // count of distinct files touched
  diffBytesAtTurn:    number[];      // ring buffer: diffBytes snapshot per turn (len = K_window, see §2.1)

  // ── repetition ───────────────────────────────────────────────────
  repeatedToolCallRun: number;       // current run-length of near-identical consecutive tool calls (see §1.4)
  lastToolSig:        string | null; // fingerprint of the most recent tool call

  // ── resource envelope ────────────────────────────────────────────
  tokens:             { input: number; output: number; cacheRead: number; cacheCreate: number };
  // NOTE: no usd field. Subscriptions, not metered API (Spec 00 economics). total_cost_usd is captured
  // verbatim if present (claude only) but is INFORMATIONAL — never a threshold input.
  costUsdInformational: number | null;

  // ── health flags ─────────────────────────────────────────────────
  scopeViolations:    number;        // count of PreToolUse hook denials for out-of-scope writes (claude) /
                                     //   sandbox-denied writes surfaced as failed command_execution (codex)
  blockedFlag:        boolean;       // worker is waiting on input / asked a question / approval-blocked
  errorFlag:          boolean;       // last turn ended in turn.failed / result.is_error / error event

  // ── bookkeeping ──────────────────────────────────────────────────
  streamOffsetBytes:  number;        // byte offset into the on-disk transcript (for restart re-tail)
  envelope:           ResourceEnvelope;  // the node's planned envelope, copied at dispatch (see §2.2)
}

interface ResourceEnvelope {     // from PLAN/STAFF (Spec 04); the "budget" reframed as scope+resources
  turnTarget:    number;          // expected turns for this node (planner estimate)
  wallClockSecs: number;          // soft wall-clock expectation
  // no dollars — Spec 00 economics
}
```

### 1.4 Counter derivation per harness

The Observer's only harness-specific code is the event normalizer. Mapping:

| Counter | Claude (`stream-json`) | Codex (`--json` JSONL) |
|---|---|---|
| `turns` | `result` line / turn boundary (also `num_turns` on final `result`) | `turn.completed` events |
| `toolCalls` | `assistant` lines containing `tool_use` blocks (**dedup by `message.id`** — parallel calls repeat it) | `item.started` with `type=command_execution`/`mcp_tool_call`/`file_change` |
| `tokens` | `assistant` `message.usage` (dedup by `message.id`); reconcile to `result.usage` at turn end | `turn.completed.usage` (`input_tokens`/`cached_input_tokens`/`output_tokens`) |
| `diffBytes`/`filesChanged` | sampled `git -C <worktree> diff --numstat` at each turn boundary (transcript has no reliable byte total) | `file_change` items give paths; numstat still sampled for bytes |
| `scopeViolations` | `--include-hook-events` → PreToolUse `permissionDecision=deny` (see [Spec 02] hook) | `command_execution` `status=failed` whose denial reason is a sandbox/workspace write block |
| `blockedFlag` | `result` with no end / `AskUserQuestion` tool_use / permission stall | turn waiting on an approval request (only via app-server; for one-shot `exec`, a turn that ends needing escalation surfaces as a failed item) |
| `errorFlag` | `result.is_error` / `subtype` ∈ {`error_*`} | `turn.failed` / top-level `error` |

**Tool-call fingerprint** (`lastToolSig`, drives `repeatedToolCallRun`): a stable hash of
`(toolName, normalizedArgs)`. Normalization strips volatile fields (timestamps, line offsets) and
lowercases paths. "Near-identical" = same fingerprint **or** ≥ 0.9 Jaccard similarity on the arg
token set. Consecutive matches increment `repeatedToolCallRun`; any non-match resets it to 1. ⚠️
Jaccard threshold (0.9) is a guess; tune against real transcripts before trusting the N≥3 alarm.

### 1.5 What the Observer does NOT do

- It does **not** decide anything. It maintains counters and emits `smoke-alarm` events. Verdicts are §4.
- It does **not** call any model. Counter updates are pure mechanical parsing.
- It does **not** pause/throttle the worker. Backpressure on the stream (if the daemon is slow) is
  handled by buffering the on-disk transcript read, never by holding the worker's pipe.

> Cross-link: the actual stdout pipe handle, the spawn command, and the transcript path all come from
> the `Worker` struct in **[Spec 02]**. The Observer attaches to `worker.telemetry`.

---

## 2. Smoke-alarms (the cheap mechanical drift signals)

A **smoke-alarm** is a pure function over `WorkerCounters` (+ `ResourceEnvelope`). When its predicate
flips false→true it emits a `SmokeAlarm` event, which fires a *look* (§4). **It never produces a
verdict.** The name is literal: smoke means *go look*, not *the building is on fire*.

```ts
type SmokeAlarmKind =
  | 'no_diff_progress' | 'over_envelope' | 'repeated_tool_calls'
  | 'scope_violation'  | 'worker_blocked';

interface SmokeAlarm {
  kind:        SmokeAlarmKind;
  workerId:    string;
  nodeId:      string;
  firedAt:     number;          // epoch ms
  detail:      Record<string, number | string>;  // the counter values that tripped it
  dedupeKey:   string;          // kind + workerId + bucket — see §2.3
}
```

### 2.1 The five alarms + default thresholds

All thresholds live in `[supervise]` of `config.toml` (§8). Defaults:

| # | Alarm | Predicate | Default | Rationale |
|---|---|---|---|---|
| **A1** | `no_diff_progress` | `turns` advanced by ≥ `K` since `diffBytes` last increased meaningfully (Δ < `minDiffBytes`) | **K = 3 turns**, `minDiffBytes = 64` | a coder that's read/thought for 3 turns with no edits may be stuck or spelunking. Look, don't judge — could be legit exploration (§7). |
| **A2** | `over_envelope` | `turns > envelope.turnTarget × overTurnFactor` **OR** `now − startTs > envelope.wallClockSecs × overWallFactor` | **overTurnFactor = 1.5**, **overWallFactor = 1.5** | "spend/turns over ~1.5× node envelope" per [Spec 00 smoke-alarm list]. Subscriptions ⇒ measured in turns + wall-clock, never $. |
| **A3** | `repeated_tool_calls` | `repeatedToolCallRun ≥ N` | **N = 3** | "N≥3 repeated near-identical tool calls" — classic spin (same grep, same failing test, same file). |
| **A4** | `scope_violation` | `scopeViolations` increased (hook/sandbox denied an out-of-scope write) | **fires on first** (Δ ≥ 1) | scope is the worktree contract ([Spec 00 scope enforcement]); even one breach attempt warrants a look. |
| **A5** | `worker_blocked` | `blockedFlag === true` **OR** `errorFlag === true` | **fires on flip** | worker asked a question, hit an approval wall, or errored. The worker is *waiting on us*. Highest urgency. |

Notes:
- **A1** uses the `diffBytesAtTurn` ring buffer (window length = `K`). Reset the "last increased" marker whenever Δ ≥ `minDiffBytes`.
- **A2** "envelope" is the planner's per-node estimate copied at dispatch — not a hard cap. Crossing it is a *prompt to reassess*, the textbook "don't cheap-stop a big refactor" case (§7).
- **A5** also covers the **rate-limit** case indirectly: if a worker stalls because its subscription hit a cap, `lastActivityTs` goes stale → see A6 below. Failover/queue handling itself is [Spec 00 rate-limits] / [Spec 04].

### 2.2 One more derived alarm (staleness)

| # | Alarm | Predicate | Default |
|---|---|---|---|
| **A6** | `stale` (a sub-kind of `worker_blocked`) | `now − lastActivityTs > staleSecs` and worker not `paused` | **staleSecs = 180** |

A worker emitting nothing for 3 min is either rate-limited, hung, or wedged on a prompt. Folded into
`worker_blocked` for decisioning but tracked separately for diagnostics. ⚠️ `staleSecs` must exceed
the longest legitimate single tool call (e.g. a slow test suite); 180s is a starting guess — tune.

### 2.3 Debounce & dedupe (don't alarm-storm Opus)

Waking Opus is the expensive thing we're protecting. Each alarm is rate-limited:

- **Per-kind cooldown** (`alarmCooldownSecs`, default **120s**): once `no_diff_progress` fires for a
  worker, it can't re-fire for that worker for 120s — unless its severity *escalates* (e.g. K crossed
  again at 2×K).
- **`dedupeKey`** = `kind:workerId:floor(elapsed/cooldown)`. Identical keys within the window collapse
  to one look.
- **Coalescing:** if multiple alarms for the *same worker* fire within `coalesceWindowMs` (default
  **2000ms**), they batch into **one** look carrying all kinds (one summary, one Opus read — cheaper
  and gives Opus fuller context). `worker_blocked`/`scope_violation` bypass coalescing delay (urgent)
  but still attach any co-firing alarms.

```ts
function shouldFireLook(a: SmokeAlarm, st: AlarmState): boolean {
  const last = st.lastFired.get(`${a.kind}:${a.workerId}`);
  if (last && a.firedAt - last < cfg.alarmCooldownSecs * 1000
           && !severityEscalated(a, st)) return false;   // cooled down
  return true;
}
```

---

## 3. Opus self-scheduled check-ins

Smoke-alarms are *reactive*. Check-ins are *proactive*: when Opus makes a plan or a steering decision,
it can **schedule its own next look** — "this is a big refactor, wake me on W after 10 turns or 15
min, whichever first." This is the second of the two ways Opus gets pulled in ([Spec 00 supervise]).

### 3.1 The `CheckIn` structure

```ts
interface CheckIn {
  id:           string;            // uuid
  workerId:     string;            // the worker to look at
  nodeId:       string;
  createdByDecisionId: string;     // the Opus decision (§4) that scheduled this
  createdAt:    number;            // epoch ms

  // Trigger — fires on WHICHEVER comes first (OR semantics):
  trigger: {
    afterTurns?:   number;         // relative: fire when worker.turns ≥ (turnsAtCreate + afterTurns)
    afterSecs?:    number;         // relative: fire at createdAt + afterSecs*1000
    atTurnAbs?:    number;         // absolute turn count (rare; used on reschedule)
  };
  turnsAtCreate: number;           // snapshot, so afterTurns is relative to schedule time

  reason:       string;            // Opus's note to its future self: "verify the data-layer refactor compiles"
  state:        'pending' | 'fired' | 'cancelled' | 'superseded';
}
```

At least one of `afterTurns` / `afterSecs` / `atTurnAbs` must be set (validated on insert). If both a
turn and a time trigger are set, **first to hit wins** and cancels the sibling.

### 3.2 The scheduler

The orchestrator keeps an in-memory `CheckInScheduler` per daemon, backed by SQLite (`checkins`
table, [Spec 09]) so a restart re-arms pending check-ins:

```ts
class CheckInScheduler {
  private timers = new Map<string, Timer>();   // checkInId → bun timer (for afterSecs/atTime)
  // turn-based check-ins are evaluated by the Observer on every turn-boundary update (no timer)

  schedule(c: CheckIn): void {
    db.insertCheckIn(c);                        // persist FIRST (durability)
    if (c.trigger.afterSecs != null) {
      const at = c.createdAt + c.trigger.afterSecs * 1000;
      this.timers.set(c.id, setTimeout(() => this.fire(c.id), Math.max(0, at - Date.now())));
    }
    // turn triggers need no timer; checkOnTurn() polls them
  }

  // called by the Observer whenever worker.turns increments
  checkOnTurn(workerId: string, turns: number): void {
    for (const c of db.pendingCheckIns(workerId)) {
      const target = c.trigger.atTurnAbs ?? (c.turnsAtCreate + (c.trigger.afterTurns ?? Infinity));
      if (turns >= target) this.fire(c.id);
    }
  }

  private fire(id: string): void {
    const c = db.getCheckIn(id);
    if (!c || c.state !== 'pending') return;     // already cancelled/superseded
    db.setCheckInState(id, 'fired');
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    controlPlane.enqueueLook({ source: 'checkin', checkIn: c });   // → §4
  }

  cancel(id: string, why: 'cancelled' | 'superseded'): void { /* clear timer + db state */ }
  rearmOnRestart(): void { for (const c of db.pendingCheckIns()) this.schedule(c); }  // recovery
}
```

A check-in fires a **look**, exactly like a smoke-alarm — same downstream path (§4). The difference is
*why* Opus is being woken: a check-in carries Opus's own prior `reason`, which is fed back into the
summary prompt ("you asked to verify X — here's where W is now").

### 3.3 How Opus populates a check-in

Opus does not call the scheduler directly. It emits a check-in **as a field of its structured decision
output** (§4, the `nextCheckIn` field). The orchestrator reads that field and calls
`scheduler.schedule()`. This keeps Opus stateless ([Spec 06]) — it just declares "look again under
these conditions," and the orchestrator owns the timer/turn machinery. One decision schedules **at
most one** check-in per worker; scheduling a new one for a worker that already has a pending check-in
**supersedes** the old (`cancel(old, 'superseded')`), so check-ins never pile up.

---

## 4. The drift → cheap-summary → Opus-read → decide path

This is the spine. A smoke-alarm (§2) **or** a check-in (§3) produces a `Look`. Every look runs the
same four steps. The expensive step (Opus) is reached only here, and only after a cheap summary.

```
                 ┌─ smoke-alarm (§2) ─┐
   trigger ──────┤                    ├──▶ LOOK ──▶ ① cheap summary (Haiku)
                 └─ check-in (§3) ────┘                     │
                                                            ▼
                                          ② Opus reads summary  (+ may pull raw slice)
                                                            │
                                                            ▼
                                          ③ Opus emits Decision  (structured JSON)
                                                            │
                                                            ▼
                                          ④ orchestrator executes (§5) + logs + maybe reschedules (§3)
```

### 4.1 Step ① — the cheap summary (Haiku)

Instead of dumping a raw transcript into Opus (slow, token-heavy, and most looks are false alarms),
the orchestrator first asks **Haiku** ([Spec 06] does the routing) to compress the worker's recent
activity. This is the cost-discipline lever from [Spec 00 §1].

Input to Haiku: the last `summaryTurns` (default **3**) turns of the on-disk transcript slice + the
worker's current plan/todo (claude: latest plan; codex: latest `todo_list` item) + the firing
alarm(s)/check-in reason + the `WorkerCounters` snapshot.

Output (`--json-schema`, [Spec 06] handles the invocation):

```ts
interface WorkerSummary {
  workerId:       string;
  whatItsDoing:   string;     // 1-2 sentences: the worker's current objective in its own framing
  recentActions:  string[];   // bullet list of the last ~3 turns' concrete actions
  currentPlan:    string;     // the worker's stated next steps, if any
  signalsOfDrift: string[];   // Haiku's read of WHY the alarm fired (e.g. "re-running the same failing test")
  signalsOfProgress: string[];// counter-evidence it's fine (e.g. "large diff in progress across 6 files")
  blockedOn:      string | null;  // if worker_blocked: what it's waiting for
}
```

Haiku **summarizes, it does not judge**. `signalsOfDrift`/`signalsOfProgress` are observations, not a
verdict. The verdict is Opus's alone.

### 4.2 Step ② — Opus reads

Opus receives: the `WorkerSummary`, the firing `SmokeAlarm[]` / `CheckIn`, the `WorkerCounters`, the
node's `AcceptanceCriteria` + `ResourceEnvelope`, and Beckett's persona/memory context ([Spec 06]).

Opus **may pull the raw transcript slice** if the summary is insufficient — it requests it via a
`needRawSlice` escape in its output (or the orchestrator pre-attaches the raw slice when the alarm is
`scope_violation`/`worker_blocked`, where literal detail matters). The raw slice is the on-disk
transcript bytes from `streamOffsetBytes - sliceBackBytes` to head (default `sliceBackBytes` covers
~3 turns). This keeps the *common* path cheap (summary only) while preserving Opus's ability to see
ground truth when it counts.

### 4.3 Step ③ — the Decision (EXACT schema)

Opus emits exactly this, via `claude -p --json-schema` ([Spec 06] owns the call; this spec owns the
shape). This is the **canonical control-plane decision object**:

```ts
interface SuperviseDecision {
  action:      'continue' | 'nudge' | 'pause' | 'abort' | 'reschedule';
  reason:      string;          // REQUIRED. First-person, owned. Logged + may surface to Discord.
                                //   e.g. "Worker's 2× over turns but mid-way through a legit 9-file refactor; let it cook."
  message?:    string;          // REQUIRED iff action==='nudge'. The steering text delivered to the worker.
  nextCheckIn?: {               // OPTIONAL. Schedules a future look (§3). Required iff action==='reschedule'.
    afterTurns?: number;
    afterSecs?:  number;
    reason:      string;        // note to future-self
  };
  escalate?: {                  // OPTIONAL. Pull Jason in (Spec 05). Independent of action (can continue AND flag).
    severity: 'fyi' | 'needs_input';
    question?: string;          // required iff severity==='needs_input'
  };
}
```

JSON Schema (the literal `--json-schema` payload):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["action", "reason"],
  "properties": {
    "action": { "enum": ["continue", "nudge", "pause", "abort", "reschedule"] },
    "reason": { "type": "string", "minLength": 1 },
    "message": { "type": "string" },
    "nextCheckIn": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reason"],
      "properties": {
        "afterTurns": { "type": "integer", "minimum": 1 },
        "afterSecs":  { "type": "integer", "minimum": 1 },
        "reason":     { "type": "string", "minLength": 1 }
      }
    },
    "escalate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["severity"],
      "properties": {
        "severity": { "enum": ["fyi", "needs_input"] },
        "question": { "type": "string" }
      }
    }
  }
}
```

Cross-field validation (enforced by the orchestrator after the schema validates — JSON Schema can't
express these):
- `action==='nudge'` ⇒ `message` non-empty.
- `action==='reschedule'` ⇒ `nextCheckIn` present.
- `escalate.severity==='needs_input'` ⇒ `escalate.question` non-empty.
- If validation fails, treat as `action: 'continue'` with a logged warning and re-arm a short check-in (`afterSecs: 120`) — **never** silently drop a worker (the no-silent-failure principle, [Spec 00 retry/escalate]).

### 4.4 Step ④ — execute

```ts
async function applyDecision(d: SuperviseDecision, w: Worker): Promise<void> {
  db.logEvent('supervise_decision', { workerId: w.id, decision: d });   // audit (Spec 09)
  switch (d.action) {
    case 'continue':                                       break;       // do nothing — most common, by design
    case 'nudge':    await control.nudge(w, d.message!);   break;       // §5.1
    case 'pause':    await control.pause(w);               break;       // §5.2
    case 'abort':    await control.abort(w, d.reason);     break;       // §5.3 → re-dispatch/escalate is Spec 04
    case 'reschedule': /* no worker write — just re-arm */  break;       // §3
  }
  if (d.nextCheckIn) scheduler.schedule(toCheckIn(d.nextCheckIn, w, d));
  if (d.escalate)    discord.escalate(w, d.escalate);                    // Spec 05
}
```

The `continue` action is the **default and the most frequent outcome** — that's healthy. Most looks
end in "yep, fine, go back to sleep." Opus being woken is cheap relative to a worker burning an hour
on the wrong thing; Opus *deciding to do nothing* is the system working.

> All four steps' model routing (which model, how invoked, prompt assembly) → **[Spec 06]**. This
> spec defines *what* flows through them and the *exact* decision contract.

---

## 5. Intervention primitives (per harness)

Three writes + one named query. Each is an interface with **two implementations** because the
harnesses are asymmetric ([`my-docs/00-synthesis.md`] — "the one fact that shapes everything"). We
document the asymmetry honestly rather than fake parity ([open-questions B3]).

```ts
interface WorkerControl {
  nudge(w: Worker, msg: string): Promise<NudgeReceipt>;
  pause(w: Worker): Promise<Checkpoint>;
  abort(w: Worker, reason: string): Promise<AbortState>;
  ask_plan(w: Worker): Promise<NudgeReceipt>;   // first-class named op (§5.4)
}
```

> The *driver mechanics* below (stdin wiring, `--resume`, `exec resume`, kill signals) are owned by
> **[Spec 02]**; restated here only enough to make the control semantics + asymmetry legible.

### 5.1 `nudge(worker, msg)` — the default intervention

A soft steering message delivered at the worker's **next safe boundary**, preserving its context.

| | Claude worker | Codex worker (`exec`) |
|---|---|---|
| **Mechanism** | Write one NDJSON `user` line to the open stdin (`--input-format stream-json`). Lands at the **next turn boundary**. | `exec` **cannot** be steered mid-run ([codex-exec §2]). Nudge is **enqueued** (§6) and applied on the **next resume** (`codex exec resume <id> "<msg>"`) at turn end. |
| **Latency** | ~next turn (seconds–minutes) | next turn end, then a fresh resume turn — **coarser** |
| **Ack** | `--replay-user-messages` echoes the msg back on stdout → Observer flips receipt to `delivered` | no live echo; receipt stays `queued` until the resume turn actually starts → then `delivered` |
| **UI/CLI state** | `queued` → `delivered` (fast) | `queued` (visibly longer) → `delivered` on resume |

```ts
interface NudgeReceipt {
  nudgeId:   string;
  workerId:  string;
  status:    'queued' | 'delivered' | 'failed';
  queuedAt:  number;
  deliveredAt: number | null;
  harness:   'claude' | 'codex';
}
```

**The asymmetry is surfaced, not hidden.** `beckett tail`/`beckett ps` ([Spec 10]) and any Discord
acknowledgement show the literal status: a Claude nudge reads `delivered` within a turn; a Codex nudge
reads `queued (applies at next turn end)` until resume. We never pretend a Codex `exec` nudge was
instant. ⚠️ Codex app-server `turn/steer` would make Codex nudges live — deferred to v2 per [Spec 00].

### 5.2 `pause(worker)` — checkpoint & hold

Freeze a worker, capture its diff, hold for a decision. Pause is **cheap for both harnesses** because
it leans on the on-disk transcript + git ([synthesis #2]).

```ts
interface Checkpoint {
  workerId:   string;
  at:         number;
  sessionId:  string;             // for later resume
  diff:       string;             // git -C <worktree> diff (captured, not applied anywhere)
  diffStat:   { files: number; bytes: number };
  lastTranscriptOffset: number;   // resume point in the JSONL
  counters:   WorkerCounters;     // snapshot
}
```

| | Claude | Codex (`exec`) |
|---|---|---|
| **Hold mechanism** | stop draining the nudge queue + don't send the next turn; the process stays alive at the turn boundary (it's waiting on stdin anyway). True soft-hold. | a one-shot `exec` turn can't be frozen mid-turn. "Pause" = let the current turn finish, then **do not** issue the next `resume`. Effectively "hold at turn end." |
| **Resume** | continue feeding stdin (or `--resume <id>` if the process was torn down) | `codex exec resume <id> "<continue>"` when unpaused |

Paused workers keep their Observer running (counters freeze naturally — no new events) and their
check-ins are **suspended** (timers cleared, re-armed on unpause) so a paused worker doesn't trip
`stale`. State transition `running→paused→running|aborted` is owned by [Spec 04].

### 5.3 `abort(worker, reason)` — hard stop + capture

Kill the worker, but **never lose its partial state** — capture enough to resume or hand to a retry
([Spec 00 durability]; retry/re-dispatch logic is [Spec 04]).

```ts
interface AbortState {
  workerId:    string;
  reason:      string;            // Opus's first-person reason, logged + surfaced
  sessionId:   string;            // claude --resume / codex exec resume target — resurrection is possible
  diff:        string;            // partial work, preserved on the worktree branch
  diffStat:    { files: number; bytes: number };
  lastTranscriptOffset: number;   // where it died
  counters:    WorkerCounters;    // final snapshot → outcome log (Spec 09 / learned model, Spec 00)
  killedAt:    number;
}
```

| | Claude | Codex (`exec`) |
|---|---|---|
| **Kill** | no documented CLI mid-run interrupt → **kill the process**, capture state, `--resume <id>` if resurrected ([claude-headless §2.3], [Spec 00 claude steering]) | kill the `exec` process; `codex exec resume <id>` to resurrect ([codex-exec §2]) |
| **Loss** | loses the in-flight turn only | loses the in-flight turn only |

Abort always: (1) snapshots `git diff` to the worktree branch (work is never discarded — INTEGRATE or
a human may still want it), (2) persists `sessionId` + offset so the node can be re-dispatched *with
context* or resumed, (3) writes the final counters to the outcome log feeding the learned-worker model
([Spec 00]). What happens *after* abort (re-dispatch ≤3, escalate) is [Spec 04] + [Spec 11].

### 5.4 `ask_plan(worker)` — first-class named op

The "ask the worker its current plan mid-flight" primitive flagged as highest-leverage
([open-questions D5]). It is a **named control op**, not just a nudge, because the orchestrator treats
the worker's *reply* as structured input to the next look (it's the freshest `currentPlan` for §4's
summary).

| | Claude | Codex (`exec`) |
|---|---|---|
| **Behavior** | **instant-ish**: a nudge whose text is the plan prompt ("Briefly, what's your current plan and why?"), read next turn; reply parsed from the next `assistant` text | **deferred**: can't query a running `exec` turn. Either read the latest `todo_list` item already in the stream (free, no interruption — *preferred*), or enqueue as a resume-time question |

`ask_plan` is what Opus calls when the summary (§4.1) is ambiguous about *intent* — cheaper and less
disruptive than `pause`, and it directly feeds the "is this drift or a big legit plan?" judgment (§7).
For Codex, prefer harvesting the existing `todo_list` from the stream over interrupting — the plan is
often already observable.

---

## 6. The nudge queue

A per-worker FIFO of pending steering messages, drained at the worker's next safe boundary, and
**persisted to SQLite** so a daemon restart never drops a pending nudge ([open-questions D4]; SQLite
schema → [Spec 09]).

```ts
interface QueuedNudge {
  nudgeId:    string;
  workerId:   string;
  text:       string;
  source:     'opus_decision' | 'cli' | 'discord' | 'ask_plan';   // provenance for audit + UI
  userId:     string;          // multiplayer-ready attribution (Spec 00 multiplayer)
  enqueuedAt: number;
  status:     'queued' | 'delivered' | 'failed';
  deliveredAt: number | null;
}
```

### 6.1 Lifecycle

```ts
class NudgeQueue {
  // 1. enqueue: persist FIRST, then in-memory (durability: survive crash between the two? persist wins)
  enqueue(n: QueuedNudge): void {
    db.insertNudge({ ...n, status: 'queued' });    // SQLite (Spec 09)
    this.mem.get(n.workerId)!.push(n);
  }

  // 2. drain: called by the Observer when it detects a safe boundary for this worker
  async drainAt(w: Worker, boundary: 'turn_end' | 'resume'): Promise<void> {
    const pending = db.queuedNudges(w.id);
    for (const n of pending) {
      if (w.harness === 'claude' && boundary === 'turn_end') {
        await driver.writeStdinUserMsg(w, n.text);          // Spec 02
        db.setNudgeStatus(n.nudgeId, 'queued');             // 'delivered' on replay-echo ack
      } else if (w.harness === 'codex' && boundary === 'resume') {
        // codex: nudges are concatenated into the resume prompt (one resume, all pending)
        await driver.execResume(w, joinNudges(pending));    // Spec 02
        db.markDelivered(pending);
        break;                                              // single resume drains all
      }
    }
  }
}
```

### 6.2 Drain boundaries & semantics

- **Claude:** safe boundary = a turn boundary. Each queued nudge is written as its own stdin `user`
  line; the `--replay-user-messages` echo flips its status to `delivered` (positive ack). Multiple
  queued nudges are delivered in FIFO order across upcoming turns.
- **Codex (`exec`):** safe boundary = the next `resume`. **All** pending nudges for the worker are
  joined into one resume prompt (so we don't spawn one resume per nudge), delivered together, all
  marked `delivered`. This is the honest coarse-grained path ([synthesis #1]).
- **Ordering:** strict FIFO per worker. A `pause`/`abort` decision **flushes-but-holds** the queue
  (don't deliver into a worker we're about to stop); on `abort` the undelivered nudges are marked
  `failed` with reason `worker_aborted` (audited, not silently dropped).
- **Restart recovery:** on daemon boot, `db.queuedNudges()` repopulates the in-memory queues before
  any worker resumes, so a nudge enqueued the instant before a crash still lands ([Spec 00 durability:
  "lose ≤ 1 turn"]).
- **De-dupe:** identical text from the same source within `nudgeDedupeMs` (default **5000ms**) collapses
  (prevents double-delivery from a retried CLI command).

---

## 7. Worked example — "don't cheap-stop good work"

The principle this whole spec exists to enforce: a smoke-alarm is a *prompt to think*, never a verdict.
Here a worker that a naive system would kill turns out to be doing exactly the right thing.

**Setup.** Node `auth-refactor` planned with `envelope.turnTarget = 8`. Claude worker `W3` assigned.

```
t+0      DISPATCH W3. Observer attaches. envelope copied into counters.
t+...    W3 works. By turn 12 it's read 20 files, edited none yet (exploring the call graph).
t+...    turn 16: counters → turns=16 (2× the 8-turn target), diffBytes=0 for last 3 turns.
```

**① Alarms fire.** Two trip, coalesced into one look (§2.3):
- `A2 over_envelope`: `16 > 8 × 1.5` → true.
- `A1 no_diff_progress`: 3 turns, Δdiff < 64B → true.

A cheap-stop system aborts here ("2× budget, no output → it's stuck"). Beckett does **not**. It fires a *look*.

**② Cheap summary (Haiku, §4.1):**
```json
{
  "whatItsDoing": "Mapping every call site of the legacy SessionCookie auth before changing signatures.",
  "recentActions": ["grepped getSession across 9 modules", "read middleware/auth.ts + 4 callers",
                    "built a list of 14 call sites to migrate"],
  "currentPlan": "Refactor the shared interface first, then update all 14 call sites in one pass.",
  "signalsOfDrift": ["no edits in 3 turns", "well over turn target"],
  "signalsOfProgress": ["systematic call-graph mapping", "concrete 14-site migration plan formed"]
}
```

**③ Opus reads (§4.2).** It sees: not spinning (no `repeated_tool_calls` alarm, `repeatedToolCallRun=1`),
no `scope_violation`, a coherent plan, and `signalsOfProgress` that explain the zero-diff as *deliberate
mapping before a big atomic edit*. The high turn count is the signature of a legitimately large refactor,
not drift. Optionally it calls `ask_plan(W3)` to confirm intent (instant for claude) — reply matches.

**③ Decision:**
```json
{
  "action": "reschedule",
  "reason": "W3 is 2× over turns but it's mid a legit 14-call-site auth refactor — mapping before editing, not stuck. Killing it now would throw away real work. Let it cook; I'll look again after it should have started editing.",
  "nextCheckIn": { "afterTurns": 6, "afterSecs": 600,
    "reason": "By +6 turns it should have edits landing across the 14 sites; if diffBytes is still 0 then it IS stuck." }
}
```

**④ Execute (§4.4).** No worker write. Scheduler arms a check-in: fire on `W3.turns ≥ 22` OR +10min.
The `A2`/`A1` alarms are now in cooldown (won't re-storm). Opus goes back to sleep.

**Continuation.** By turn 21, `diffBytes` climbs across 14 files — real progress. When the check-in
fires at turn 22, the §4.1 summary shows landing edits; Opus emits `{ "action": "continue", "reason":
"edits landing as planned across all 14 sites, on track" }` and arms no further check-in (or a light
one). The refactor completes and goes to REVIEW/GATE ([Spec 11]). **A good worker was never
interrupted** — the envelope crossing bought a *look*, the look bought *judgment*, judgment bought
*patience*. That gap between alarm and verdict is the product.

---

## 8. Configuration (`~/.beckett/config.toml`)

Canonical `[supervise]` block. All values tunable at runtime; these are the defaults referenced throughout.

```toml
[supervise]
# ── observation ──
diff_sample        = "turn_end"   # when to sample git numstat: "turn_end" | "every_n_secs"
summary_turns      = 3            # how many recent turns the Haiku summary covers (§4.1)
slice_back_turns   = 3            # raw transcript slice Opus can pull (§4.2)

# ── smoke-alarm thresholds (§2) ──
no_diff_K          = 3            # A1: turns of no meaningful diff before alarm
no_diff_min_bytes  = 64          # A1: Δbytes that counts as "progress"
over_turn_factor   = 1.5         # A2: turns > target × this
over_wall_factor   = 1.5         # A2: wall-clock > estimate × this
repeated_tool_N    = 3           # A3: run-length of near-identical tool calls
repeated_tool_jaccard = 0.9      # A3: arg-similarity threshold for "near-identical"  ⚠️ tune
stale_secs         = 180         # A6: silence before a worker is "stale"  ⚠️ must exceed slowest tool

# ── debounce (§2.3) ──
alarm_cooldown_secs = 120        # per-kind per-worker re-fire cooldown
coalesce_window_ms  = 2000       # batch same-worker alarms into one look

# ── nudge queue (§6) ──
nudge_dedupe_ms     = 5000       # collapse identical nudges within this window

# ── check-ins (§3) ── (no global defaults; Opus sets per-decision)
```

---

## 9. Open gaps ⚠️

- **⚠️ Spec 02 not yet written.** All driver-mechanic claims here (stdin NDJSON, `--replay-user-messages`
  ack, `--include-hook-events`, `--resume`, `codex exec resume`, transcript paths) are sourced from
  `my-docs/` and must be reconciled when [Spec 02] lands. If 02 chooses the **Agent SDK** for the
  Claude driver instead of CLI-shell, `nudge` gains a true `interrupt()` and §5.1's "next turn
  boundary" latency improves — update this spec's Claude column accordingly.
- **⚠️ `diffBytes` sampling cost.** `git diff --numstat` per turn boundary across many concurrent
  workers may be non-trivial. If it shows up in profiling, switch to watching `file_change` events
  (codex) / PostToolUse Edit/Write hooks (claude) for byte deltas and reserve numstat for periodic
  reconciliation.
- **⚠️ Jaccard 0.9 / stale 180s / cooldown 120s** are first-guess constants with no real-transcript
  calibration. Treat §8 as a tuning surface, not settled law.
- **⚠️ Codex `blockedFlag`/`scope_violation` fidelity.** With one-shot `exec`, a worker waiting on an
  approval doesn't "block" (approvals are `never` → it just fails the command). So `worker_blocked`
  for codex is really "errored/failed-and-exited," detected at process exit, not mid-run. True mid-run
  block detection needs app-server (v2).
- **⚠️ Look concurrency.** If many workers alarm at once, multiple Opus looks could fire concurrently.
  Needs a look queue / concurrency cap (likely shared with the worker concurrency cap, [Spec 01]) so
  the expensive head isn't fanned out unboundedly. Coalescing (§2.3) mitigates per-worker but not
  cross-worker storms.

---

## 10. Cross-links

- **[Spec 00 — Overview & Canon](./00-overview.md)** — supervise decision, economics (no $), durability, glossary.
- **[Spec 02 — Worker Abstraction](./02-worker-abstraction.md)** ⚠️ — `Worker` struct, drivers, spawn/steer/abort mechanics, telemetry handles, scope/hooks.
- **[Spec 04 — State Machine](./04-state-machine.md)** — `running/paused/aborted` transitions, re-dispatch, DAG sequencing, escalation routing.
- **[Spec 06 — Brain & Models](./06-brain-models.md)** — Haiku summary + Opus decision invocation, `--json-schema` call, routing, persona injection.
- **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)** — `checkins`, `nudges`, `events`, counter/offset persistence DDL; outcome logging.
- **[Spec 10 — CLI](./10-cli.md)** — `beckett tail / ps / nudge / abort` surfacing queued-vs-delivered.
- **[Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md)** — what happens to aborted/completed work; criteria the decision references.
- **[Spec 05 — Discord Interface](./05-discord-interface.md)** — how `escalate` reaches Jason; nudges originating from Discord.
```
