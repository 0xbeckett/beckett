# Beckett — Spec 04: State Machine

> **The control flow canon.** This spec formalizes the loop from [Spec 00 §3](./00-overview.md#3-the-loop-canonical-state-machine)
> into two interlocking finite-state machines (TASK-level and NODE-level), the DAG executor that
> drives them, the INTEGRATE phase, the retry/escalation loops, and crash recovery. If this spec
> contradicts [Spec 00](./00-overview.md), Spec 00 wins (or we fix 00 first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Research & rationale: [`../my-docs/open-questions.md`](../my-docs/open-questions.md) (esp. §J state machine, §C4 integrate, §H3 retry/escalate, §A4 durability).

---

## 0. Scope & cross-links

This document owns: **all states, all transitions, the two-level FSM, the DAG executor, INTEGRATE,
the retry loop, the three escalation points, CLARIFY decisioning, and crash recovery.**

It **defers**:

| Concern | Owner |
|---|---|
| SUPERVISE internals (smoke-alarms, check-in scheduler, drift→read→decide) | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| Driver mechanics (spawn/steer/abort, JSONL parsing, `--resume`) | [Spec 02 — Worker Abstraction](./02-worker-abstraction.md) |
| Concurrency cap value, process model, resource gating | [Spec 01 — Architecture](./01-architecture.md) |
| REVIEW tiering, criteria format, GATE pass/fail logic | [Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md) |
| SQLite schema, event-log shape, durability primitives | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| Discord message shapes (ack, clarify, escalation, deliver) | [Spec 05 — Discord Interface](./05-discord-interface.md) |
| Brain routing (which model runs which phase) | [Spec 06 — Brain & Models](./06-brain-models.md) |
| Identity gates / delivery handshake mechanics | [Spec 07 — Identity & Agency](./07-identity-agency.md) |

⚠️ All sibling specs except [Spec 00](./00-overview.md) are forward references at time of writing.

---

## 1. Two-level FSM — the core mental model

Beckett runs **one TASK FSM per `@beckett` request** and **N NODE FSMs underneath it** (one per DAG
node). The relationship:

- The **TASK FSM** is the macro loop from Spec 00: `INTAKE → … → DELIVER`. It is *single-threaded* per
  task — a task is in exactly one TASK state at a time.
- A single TASK state — **`EXECUTING`** (which fans out to DISPATCH/SUPERVISE/INTEGRATE/REVIEW/GATE in
  Spec 00's prose) — contains a **running DAG**. While the task sits in `EXECUTING`, the DAG executor
  is advancing many **NODE FSMs concurrently**, each in its own sub-state.
- The TASK leaves `EXECUTING` only when the DAG executor reports **terminal DAG status** (all nodes
  `DONE`, or an unrecoverable node failure that escalates, or a global abort).

```
              TASK FSM  (one per @beckett request)
   INTAKE → CLARIFY? → PLAN → STAFF → ┌─────────────┐ → DELIVER
                                      │  EXECUTING   │
                                      │  (DAG runs)  │
                                      └─────────────┘
                                            │ contains
                                            ▼
              NODE FSM × N   (one per DAG node, run concurrently)
   BLOCKED → READY → DISPATCHED → SUPERVISING ⇄ (NUDGING|PAUSED)
           → INTEGRATING → REVIEWING → GATING → (RE_DISPATCH | NODE_DONE | NODE_FAILED)
```

> **Why split EXECUTING out of Spec 00's flat list?** Spec 00 lists DISPATCH/SUPERVISE/INTEGRATE/
> REVIEW/GATE as steps in *the loop*, but those are **per-node** activities that happen in parallel
> across many nodes — they are not global task phases. Modeling them as NODE sub-states (inside the
> single TASK state `EXECUTING`) is the only way the DAG can run nodes at different stages
> simultaneously. The Spec 00 step table is the **node lifecycle**; the TASK FSM wraps it. This is a
> formalization of Spec 00, not a contradiction of it. ⚠️ Confirm with Jason that "EXECUTING as the
> DAG-host state" reads cleanly against the Spec 00 loop diagram.

---

## 2. TS types — the state model

```ts
// ============================================================================
// TASK-LEVEL FSM
// ============================================================================

export enum TaskState {
  INTAKE      = "INTAKE",      // Haiku received the mention; classify + ack
  CLARIFY     = "CLARIFY",     // awaiting one crisp answer (irreversible ambiguity only)
  PLAN        = "PLAN",        // Opus writing the DAG + per-node acceptance criteria
  STAFF       = "STAFF",       // Opus assigning worker type per node (capability table)
  EXECUTING   = "EXECUTING",   // DAG executor running; many NODE FSMs live underneath
  ESCALATED   = "ESCALATED",   // halted, awaiting Jason (reachable from CLARIFY/EXECUTING/GATE)
  DELIVERING  = "DELIVERING",  // Haiku composing + posting the final in-channel message
  DELIVERED   = "DELIVERED",   // terminal: success, handshake pending or resolved
  ABORTED     = "ABORTED",     // terminal: hard-stopped by Jason or self-halt
  FAILED      = "FAILED",      // terminal: unrecoverable, escalation exhausted/declined
}

export const TASK_TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.DELIVERED, TaskState.ABORTED, TaskState.FAILED,
]);

// ============================================================================
// NODE-LEVEL FSM
// ============================================================================

export enum NodeState {
  BLOCKED      = "BLOCKED",      // ≥1 upstream dependency not yet DONE
  READY        = "READY",        // deps satisfied; waiting on a concurrency slot
  DISPATCHED   = "DISPATCHED",   // worker spawned (driver booting), not yet streaming
  SUPERVISING  = "SUPERVISING",  // worker running; orchestrator tailing JSONL read-only
  NUDGING      = "NUDGING",      // a steer msg is queued/in-flight to the worker
  PAUSED       = "PAUSED",       // worker frozen (checkpoint); diff under inspection
  INTEGRATING  = "INTEGRATING",  // merging this node's branch into the project branch
  REVIEWING    = "REVIEWING",    // checks + (self|fresh) reviewer running vs criteria
  GATING       = "GATING",       // Opus pass/fail decision against criteria
  RE_DISPATCH  = "RE_DISPATCH",  // gate failed; re-dispatching with reviewer feedback
  NODE_DONE    = "NODE_DONE",    // terminal: integrated + gated green
  NODE_FAILED  = "NODE_FAILED",  // terminal: retries exhausted or aborted → escalates task
}

export const NODE_TERMINAL: ReadonlySet<NodeState> = new Set([
  NodeState.NODE_DONE, NodeState.NODE_FAILED,
]);

// ============================================================================
// MODELS
// ============================================================================

export interface TaskRecord {
  id: string;
  userId: string;                 // multiplayer-ready (Spec 00: user_id on every task)
  channelId: string;              // Discord origin channel (ambient model, Spec 05)
  state: TaskState;
  prompt: string;                 // original request
  assumptions: string[];          // reversible-ambiguity choices, surfaced at DELIVER
  dag?: Dag;                      // populated at PLAN
  escalation?: Escalation;        // populated when state === ESCALATED
  createdAt: number;
  updatedAt: number;              // bumped on every persisted transition (durability)
}

export interface NodeRecord {
  id: string;
  taskId: string;
  title: string;
  deps: string[];                 // node ids this node depends on
  scope: FileScope;               // owned, non-overlapping paths (Spec 02)
  worker?: WorkerAssignment;      // set at STAFF (harness, model, effort, network)
  workerId?: string;              // live worker handle id (Spec 02)
  sessionId?: string;             // persisted on spawn → enables --resume (Spec 02/09)
  branch: string;                 // beckett/<task>/<node> worktree branch
  state: NodeState;
  criteria: AcceptanceCriteria;   // executable checks + NL (Spec 11), written at PLAN
  attempts: number;               // re-dispatch counter; escalate when > MAX_RETRIES
  feedback: ReviewerFeedback[];   // threaded across retries (see §6)
  lastReviewerId?: string;        // for resume-vs-fresh decisioning
  createdAt: number;
  updatedAt: number;
}

export interface Dag {
  nodes: Record<string, NodeRecord>;
  projectBranch: string;          // integration target (e.g. beckett/<task>/integration)
}

export interface Escalation {
  origin: "CLARIFY" | "SUPERVISE" | "GATE";
  nodeId?: string;                // null for CLARIFY-origin
  reason: string;
  options: EscalationOption[];    // "tried 3×, options A/B/C" (Spec 11 format)
  postedMessageId?: string;       // Discord message awaiting reply (Spec 05)
  raisedAt: number;
}

export interface EscalationOption { key: string; label: string; effect: string; }

export const MAX_RETRIES = 3;     // Spec 00 ledger: ≤3 re-dispatch cycles
```

(`FileScope`, `WorkerAssignment`, `AcceptanceCriteria`, `ReviewerFeedback` are owned by Specs 02/11;
referenced here as opaque shapes.)

---

## 3. TASK FSM — diagram

```
                       ┌──────────┐
            mention →  │  INTAKE  │  (Haiku: classify + ack one-line read)
                       └────┬─────┘
              irreversible  │  reversible / unambiguous
                  ambiguity │
              ┌─────────────┴──────────────┐
              ▼                             ▼
        ┌──────────┐  answer          ┌────────┐
        │ CLARIFY  │ ───────────────► │  PLAN  │  (Opus: DAG + per-node criteria)
        └────┬─────┘                  └───┬────┘
             │ no-answer / refuse         │
             │ / contradiction            ▼
             │                        ┌────────┐
             │                        │ STAFF  │  (Opus: worker per node)
             │                        └───┬────┘
             │                            ▼
             │                     ┌─────────────┐
             │                     │  EXECUTING  │◄──────┐ (DAG executor; §4)
             │                     └──┬───┬───┬──┘       │
             │          DAG complete  │   │   │ node escalation (SUPERVISE/GATE)
             │                        │   │   └──────────┼───────┐
             │                        │   │ global abort │       │
             ▼                        │   ▼              │       ▼
        ┌───────────┐   resolve  ◄────┼─►┌───────────┐   │  ┌───────────┐
        │ ESCALATED │ ◄───────────────┘  │  ABORTED  │   └─►│ ESCALATED │
        └─────┬─────┘                    └───────────┘      └─────┬─────┘
              │ Jason picks option                                │
              │  ├─ resume → back to EXECUTING/PLAN ──────────────┘
              │  └─ decline/abort → FAILED
              ▼
        ┌────────────┐        ┌────────────┐       ┌───────────┐
        │ DELIVERING │ ─────► │ DELIVERED  │       │  FAILED   │
        └────────────┘        └────────────┘       └───────────┘
        (Haiku: final in-channel msg + handshake)   (terminal)
```

---

## 4. TASK FSM — transition table

Format: **(current, event, guard) → next + side effects.** Every transition that changes `TaskState`
**persists `state` + `updatedAt`** before acting (durability invariant, §9). Side effects after the
persisted write are idempotent-on-replay.

| # | Current | Event | Guard | Next | Side effects |
|---|---|---|---|---|---|
| T1 | — | `mention_received` | from `@beckett` in any channel | `INTAKE` | create `TaskRecord`; Haiku classifies; post ack one-liner (Spec 05) |
| T2 | `INTAKE` | `classified` | ambiguity is **reversible** OR none (see §7 guard `needsClarify`) | `PLAN` | record any assumptions; no question asked |
| T3 | `INTAKE` | `classified` | ambiguity is **irreversible/consequential** | `CLARIFY` | post ONE crisp question (Spec 05); arm CLARIFY escalation context |
| T4 | `INTAKE` | `classified` | not a task (chatter/FYI) | `DELIVERED` | Haiku replies conversationally; no DAG |
| T5 | `CLARIFY` | `answer_received` | answer resolves the ambiguity | `PLAN` | fold answer into prompt context |
| T6 | `CLARIFY` | `answer_received` | answer reveals contradiction / bad plan | `CLARIFY` or `ESCALATED` | Beckett pushes back (standing, pillar 3); may re-ask once then escalate |
| T7 | `CLARIFY` | `timeout` / `no_answer` | reversible fallback exists | `PLAN` | proceed on best assumption; note it for delivery |
| T8 | `CLARIFY` | `timeout` / `no_answer` | no safe fallback | `ESCALATED(origin=CLARIFY)` | task parks awaiting Jason (§6) |
| T9 | `PLAN` | `dag_built` | DAG valid (acyclic, every node has criteria) | `STAFF` | persist `Dag`; emit plan event |
| T10 | `PLAN` | `plan_infeasible` | spec self-contradicts / cannot decompose | `ESCALATED(origin=CLARIFY)` | "I can't staff this as written, here's why" (pillar 3) |
| T11 | `STAFF` | `staffed` | every node has a `WorkerAssignment` | `EXECUTING` | persist assignments; **start DAG executor** (§4.x) |
| T12 | `EXECUTING` | `dag_complete` | all nodes `NODE_DONE` | `DELIVERING` | compose delivery (Spec 05) |
| T13 | `EXECUTING` | `node_escalation` | a node hit SUPERVISE-abort or GATE-retries-exhausted | `ESCALATED(origin=SUPERVISE\|GATE)` | freeze sibling nodes per policy (§4.6); build options (Spec 11) |
| T14 | `EXECUTING` | `global_abort` | Jason `beckett abort <task>` or self-halt | `ABORTED` | abort all live workers (Spec 02); capture partials |
| T15 | `ESCALATED` | `option_chosen` | option = resume/redirect | `EXECUTING` or `PLAN` | apply option effect; re-enter DAG (re-plan if PLAN-origin) |
| T16 | `ESCALATED` | `option_chosen` | option = stop/decline | `FAILED` | record outcome; post honest close (Spec 05) |
| T17 | `ESCALATED` | `option_chosen` | option = abort | `ABORTED` | abort live workers |
| T18 | `DELIVERING` | `posted` | final message sent | `DELIVERED` | await handshake answer (merge/send) if irreversible step pending (Spec 07) |
| T19 | `DELIVERING` | `post_failed` | Discord/identity error | `ESCALATED(origin=GATE)` | retry post; if persistent, surface via CLI |

> **EXECUTING is re-entrant.** T15 returns a task to `EXECUTING` with a *modified* DAG (e.g. a node
> re-scoped, a new node inserted, or `attempts` reset for one node). The DAG executor resumes from
> persisted node states — it does not restart completed nodes.

---

## 5. NODE FSM — diagram + transition table

### 5.1 Diagram

```
   ┌─────────┐  deps satisfied   ┌────────┐  slot free   ┌────────────┐
   │ BLOCKED │ ────────────────► │ READY  │ ───────────► │ DISPATCHED │
   └─────────┘                   └────────┘              └─────┬──────┘
       ▲                                                       │ worker streaming
       │ (deps still pending)                                  ▼
       │                                              ┌──────────────┐
       │                              ┌──────────────►│ SUPERVISING  │◄────────┐
       │                              │               └──┬────┬───┬──┘         │
       │                       nudge  │  (resume)        │    │   │ pause      │
       │                     delivered│   ┌──────────────┘    │   ▼            │
       │                              │   ▼              ┌─────┴──┐  ┌────────┐ │
       │                          ┌───┴────┐            │ worker │  │ PAUSED │ │
       │                          │NUDGING │            │  exits │  └───┬────┘ │
       │                          └────────┘            └────┬───┘ resume│     │
       │                                                     │           └─────┘
       │                                  worker done (exit 0│, turn complete)
       │                                                     ▼
       │                                            ┌──────────────┐
       │                                            │ INTEGRATING  │ (merge branch; §6)
       │                                            └──────┬───────┘
       │                                merge ok / resolved│  conflict → integ-worker → §6
       │                                                   ▼
       │                                            ┌──────────────┐
       │                                            │  REVIEWING   │ (checks + reviewer; Spec 11)
       │                                            └──────┬───────┘
       │                                                   ▼
       │                                            ┌──────────────┐
       │                                            │   GATING     │ (Opus pass/fail; Spec 11)
       │                                            └──┬────┬───┬──┘
       │                              pass             │    │   │  fail & attempts<MAX
       │                                  ┌────────────┘    │   └──────────┐
       │                                  ▼                 │ fail &        ▼
       │                           ┌───────────┐            │ attempts=MAX ┌─────────────┐
       │                           │ NODE_DONE │            │              │ RE_DISPATCH │
       │                           └─────┬─────┘            ▼              └──────┬──────┘
       │  unblock dependents ◄───────────┘            ┌─────────────┐            │ re-enter
       └─────────────────────────────────────────────┤ NODE_FAILED │            │ with feedback
                                  (NODE_FAILED → task escalation T13) └──────────┘ ───► DISPATCHED
```

### 5.2 Transition table

| # | Current | Event | Guard | Next | Side effects |
|---|---|---|---|---|---|
| N1 | (new) | `node_created` | has unmet deps | `BLOCKED` | persist node |
| N2 | (new) | `node_created` | no deps | `READY` | enqueue in ready-set |
| N3 | `BLOCKED` | `dep_done` | **all** deps now `NODE_DONE` | `READY` | enqueue in ready-set |
| N4 | `READY` | `slot_available` | live workers < concurrency cap (Spec 01) | `DISPATCHED` | spawn worker in worktree (Spec 02); **persist `sessionId` immediately** |
| N5 | `DISPATCHED` | `stream_started` | first JSONL event seen | `SUPERVISING` | attach tailer; arm smoke-alarms + check-ins (Spec 03) |
| N6 | `SUPERVISING` | `nudge_decided` | Opus chose nudge (Spec 03) | `NUDGING` | enqueue steer msg; deliver at turn boundary (Spec 02) |
| N7 | `NUDGING` | `nudge_landed` | worker consumed steer | `SUPERVISING` | resume tailing |
| N8 | `SUPERVISING` | `pause_decided` | Opus/Jason chose pause | `PAUSED` | checkpoint; freeze worker (Spec 02/03) |
| N9 | `PAUSED` | `resume` | inspection done, continue | `SUPERVISING` | unfreeze / `--resume` |
| N10 | `PAUSED`/`SUPERVISING` | `abort_decided` | Opus/Jason chose abort | `NODE_FAILED` | kill worker; capture partial diff; → task T13 |
| N11 | `SUPERVISING` | `worker_exited_ok` | process exit 0, turn complete | `INTEGRATING` | finalize branch; begin merge (§6) |
| N12 | `SUPERVISING` | `worker_exited_err` | nonzero exit / crash | `RE_DISPATCH` (if attempts<MAX) else `NODE_FAILED` | classify failure; thread feedback |
| N13 | `INTEGRATING` | `merge_clean` | no conflicts | `REVIEWING` | run executable checks (Spec 11) |
| N14 | `INTEGRATING` | `merge_conflict` | git conflict OR interface mismatch | `INTEGRATING` (sub) | spawn integration worker (Opus) (§6) |
| N15 | `INTEGRATING` | `integ_resolved` | integ worker merged cleanly | `REVIEWING` | run checks |
| N16 | `INTEGRATING` | `integ_failed` | integ worker could not reconcile | `NODE_FAILED` | → task T13 escalation (SUPERVISE-origin) |
| N17 | `REVIEWING` | `review_complete` | checks ran + reviewer verdict ready | `GATING` | pass verdict + diff to Opus gate |
| N18 | `GATING` | `gate_pass` | checks exit 0 AND review pass (Spec 11) | `NODE_DONE` | log gate outcome; **unblock dependents** (fire `dep_done`) |
| N19 | `GATING` | `gate_fail` | criteria unmet AND `attempts < MAX_RETRIES` | `RE_DISPATCH` | capture `ReviewerFeedback`; `attempts++` |
| N20 | `GATING` | `gate_fail` | criteria unmet AND `attempts >= MAX_RETRIES` | `NODE_FAILED` | → task T13 escalation (GATE-origin) |
| N21 | `RE_DISPATCH` | `redispatch_ready` | feedback threaded (§6) | `DISPATCHED` | resume same session + feedback nudge (default) OR fresh spawn |
| N22 | `NODE_DONE` | — | terminal | — | when **all** nodes terminal-DONE → task `dag_complete` (T12) |
| N23 | `NODE_FAILED` | — | terminal | — | triggers task `node_escalation` (T13) |

> **Gate-fail attribution vs worker-error (N12 vs N19).** N12 is a *worker crash* (process died);
> N19 is a *quality fail* (worker finished, output rejected). Both route through `RE_DISPATCH` and
> share the retry budget — `attempts` is a single counter per node so a node that crashes twice then
> fails review once is already at the escalation boundary. ⚠️ Confirm with Spec 11 whether crashes and
> gate-fails should share one budget or have separate counters.

---

## 6. The DAG executor

The executor is the engine driving all NODE FSMs while the task sits in `EXECUTING`. It is a
**topological scheduler under a concurrency cap** (cap value owned by [Spec 01](./01-architecture.md);
treat as `CONCURRENCY_CAP`).

### 6.1 "Ready" and unblocking

- A node is **`READY`** ⇔ every id in `node.deps` references a node in `NODE_DONE`.
- A node with unmet deps is **`BLOCKED`**.
- On any `NODE_DONE` (N18), the executor scans that node's **dependents** and fires `dep_done` (N3);
  a dependent flips to `READY` only when **all** its deps are done (join semantics).
- This gives the natural shape: **independent nodes run in parallel; dependent nodes sequence.**

### 6.2 Scheduling loop (pseudocode)

```ts
function tick(dag: Dag) {
  const live = countLive(dag);                  // DISPATCHED|SUPERVISING|NUDGING|PAUSED|INTEGRATING
  let free = CONCURRENCY_CAP - live;            // Spec 01 owns the cap + CPU/RAM gating

  // Deterministic ready order: deepest-critical-path first, then DAG declaration order.
  const ready = Object.values(dag.nodes)
    .filter(n => n.state === NodeState.READY)
    .sort(byCriticalPathDescThenId);

  for (const node of ready) {
    if (free <= 0) break;                        // excess stays READY (queued)
    dispatch(node);                              // N4: spawn + persist sessionId
    free--;
  }

  if (allTerminal(dag)) {
    if (anyFailed(dag)) raiseTaskEvent("node_escalation");   // T13
    else raiseTaskEvent("dag_complete");                      // T12
  }
}
```

`tick()` runs on every NODE state change and on a low-frequency timer (defensive). It is **pure over
persisted state** — safe to call after a crash-replay.

### 6.3 Readiness semantics & cycles

- PLAN must emit an **acyclic** DAG; T9's guard rejects cycles (Kahn's algorithm; on cycle →
  `plan_infeasible` T10). ⚠️ Cycle detection lives at PLAN-validation time, owned jointly with Spec 11.
- A node may declare a dep that is **never satisfiable** only if an upstream `NODE_FAILED` occurs;
  that case is preempted because `NODE_FAILED` escalates the whole task (T13) before downstream starve.

### 6.4 Concurrency, failover, backpressure

- The cap bounds *live workers across the whole daemon* (all tasks share it) — see [Spec 01](./01-architecture.md).
- On a **rate-limit hit** for one harness, the executor does **not** mark the node failed: it leaves
  the node `READY` and lets STAFF-equivalent re-route the node to the other harness if compatible
  (failover, Spec 00 ledger), else queue+backoff. ⚠️ Failover re-staffing hook owned with Spec 02/06.

### 6.5 INTEGRATE — first-class merge phase (N11–N16)

Each node owns a git **worktree branch** (`beckett/<task>/<node>`). The DAG has one **project/
integration branch** (`Dag.projectBranch`). INTEGRATE happens **per node, at node completion**, before
that node's REVIEW — so review always runs against integrated code, and dependents branch off an
already-merged base.

**Merge strategy (default):**

1. `git fetch` the project branch into the node worktree; attempt `git merge --no-ff projectBranch`
   *into the node branch* first to surface conflicts in the node's own context (cheap, local).
2. If clean, fast-forward/merge the node branch **into** `projectBranch` (`--no-ff`, one commit per
   node for a legible integration history).
3. Re-run the node's executable checks **post-merge** (N13) — a clean merge can still break the build.

**Conflict handling (N14 → integration worker):**

```
merge_conflict (git textual conflict) OR interface_mismatch (semantic)
        │
        ▼
spawn INTEGRATION WORKER  (harness: claude, model: Opus, scope: union of both nodes' paths)
  inputs:  diff(node branch), diff(projectBranch since base),
           the INTERFACE CONTRACT for the two nodes (from PLAN),
           the conflict markers / failing check output
  task:    "reconcile these two diffs honoring the interface contract; produce a merged tree
            that builds + passes both nodes' checks"
        │
   ┌────┴─────┐
 resolved   failed
   │            │
   ▼            ▼
 REVIEWING   NODE_FAILED → task escalation (origin=SUPERVISE)   only AFTER integ worker fails
```

- **Interface reconciliation between parallel nodes:** when two independent nodes share a contract
  (e.g. node A defines an API type, node B consumes it), PLAN records the **interface contract** as
  part of each node's criteria. INTEGRATE checks the contract holds post-merge; a mismatch (B compiled
  against a stale shape of the type) is an `interface_mismatch` → same integration-worker path. This
  is the *semantic* sibling of a textual git conflict.
- **Escalation order (Spec 00 §C4):** auto-merge → integration worker (Opus) → **only then** escalate
  to Jason. Beckett never hands Jason a raw conflict it hasn't tried to resolve itself.

⚠️ Whether INTEGRATE is strictly per-node (chosen here) vs a single batched end-of-DAG merge is a real
design fork. Per-node is recommended: it keeps conflicts small/frequent/local rather than one giant
end-of-task merge, and lets dependents build on merged code. Confirm with Spec 01/02.

### 6.6 Node escalation & sibling policy

When a node hits `NODE_FAILED` (N10/N16/N20), the task transitions to `ESCALATED` (T13). Sibling
in-flight nodes:

- **Independent siblings** (no path to/from the failed node): **let them finish to `NODE_DONE`**
  (their work is still useful and may inform the options Beckett offers Jason). Do not start *new*
  nodes.
- **Dependent descendants** of the failed node: leave `BLOCKED` (they can never become `READY`).
- The task parks in `ESCALATED`; resolution (T15) may re-scope and reset `attempts` for the failed
  node, then re-enter `EXECUTING`.

---

## 7. CLARIFY decisioning (the INTAKE branch guard)

The guard on **T2 vs T3** is the proceed-on-reversible / ask-on-irreversible rule (Spec 00 ledger:
"Clarify bias").

```ts
type Reversibility = "reversible" | "irreversible";

interface AmbiguityAssessment {
  hasAmbiguity: boolean;
  reversibility: Reversibility;   // worst-case of the ambiguous decisions
  consequential: boolean;          // high blast radius even if technically reversible
  bestAssumption?: string;         // the choice Beckett would make if it proceeds
}

// Guard for INTAKE → PLAN (T2) vs INTAKE → CLARIFY (T3)
function needsClarify(a: AmbiguityAssessment): boolean {
  if (!a.hasAmbiguity) return false;                       // → PLAN
  if (a.reversibility === "irreversible") return true;     // → CLARIFY (ask once)
  if (a.consequential) return true;                        // high-stakes reversible → ask
  return false;                                            // reversible & low-stakes → PROCEED,
                                                           //   record bestAssumption, surface @ DELIVER
}
```

- **Reversible** examples (proceed, note assumption): naming, file layout, which test framework when
  unspecified, a draft's tone. → push `bestAssumption` to `TaskRecord.assumptions`, deliver with
  "I assumed X — easy to change."
- **Irreversible/consequential** examples (ask once): sending an email externally, force-pushing,
  deleting data, choosing between two incompatible architectures the user clearly cares about, merging
  to `main`. → `CLARIFY`, ONE crisp question (Spec 05 shape).
- **Never** ask about something Beckett can just *try* and reverse (Spec 00 pillar: agency = discretion).
- CLARIFY is also where Beckett exercises **standing to push back** (T6/T10): a contradictory spec
  earns a "this contradicts itself, which did you mean?" rather than a silent guess.

---

## 8. Retry loop & feedback threading

GATE-fail (N19) and worker-crash (N12) both route to `RE_DISPATCH`, sharing one per-node `attempts`
counter, capped at `MAX_RETRIES = 3` (Spec 00 ledger). On the (MAX+1)th need, the node escalates
(N20) instead of retrying.

### 8.1 How feedback is threaded — recommendation

> **Recommendation: resume the same session with a feedback nudge for *quality* gate-fails (N19);
> spawn fresh for *crash* retries (N12) and for the final retry before escalation.**

**Rationale:**

| Strategy | When | Why |
|---|---|---|
| **Resume same session** (`--resume <sessionId>` / `codex exec resume` + a feedback `user` msg) | Default for gate-fail (N19) | The worker already holds the full context of what it built and *why*; feeding reviewer feedback as a follow-up turn is the cheapest, most coherent fix path — it's literally how a human reviewer hands back a PR. Preserves the worktree, avoids re-deriving context, lands the fix in 1 turn. |
| **Spawn fresh** (new session, criteria + clean branch + feedback as initial brief) | Crash retries (N12); when prior attempts show the worker is *stuck in a rut* (same failure 2×); the last attempt before escalation | A crashed session may be corrupt/unresumable. A worker looping on the same wrong approach benefits from a clean slate — the feedback becomes the *brief* rather than a correction layered on a flawed mental model. The fresh worker gets the reviewer feedback + the prior failed diff as "here's an approach that didn't pass." |

```ts
function redispatchStrategy(node: NodeRecord, lastFailure: "gate" | "crash"): "resume" | "fresh" {
  if (lastFailure === "crash") return "fresh";                 // session may be unusable
  if (node.attempts >= MAX_RETRIES) return "fresh";            // last shot: clean slate
  if (sameFailureTwice(node.feedback)) return "fresh";         // stuck in a rut
  return "resume";                                             // default: cheapest coherent fix
}
```

### 8.2 Feedback payload

`ReviewerFeedback` (shape owned by Spec 11) is appended to `node.feedback` on every gate-fail and
threaded into the re-dispatch:

- **resume:** delivered as a steer/`user` message — "Review didn't pass: \<criteria not met\> —
  \<specific reviewer notes\>. Fix and keep your existing work."
- **fresh:** delivered in the initial brief — original node spec + criteria + "a previous attempt
  failed review for: \<reasons\>; its diff is attached as a non-passing reference."

The full `feedback[]` history persists so the escalation (after MAX) can show Jason **what was tried
each cycle** ("tried 3×, options A/B/C" — Spec 11).

---

## 9. Escalation — the three points

All three converge on `TaskState.ESCALATED`. The task **parks** there (no workers consuming the cap
except independent siblings finishing per §6.6) until Jason answers. An escalation produces a Discord
message (shape owned by [Spec 05](./05-discord-interface.md)) carrying the "tried N×, options A/B/C"
structure (format owned by [Spec 11](./11-review-gate-quality.md)).

| Escalation point | Origin enum | Trigger condition | What it produces | Task state while waiting |
|---|---|---|---|---|
| **CLARIFY** | `CLARIFY` | irreversible ambiguity with no safe fallback (T8); contradictory/infeasible spec (T6/T10) | ONE crisp question OR "can't staff this, here's why" | `ESCALATED` (no DAG yet, or DAG paused at PLAN) |
| **SUPERVISE** | `SUPERVISE` | Opus decided **abort** on a drifting worker (N10); integration worker failed to reconcile (N16); self-halt ("bigger than scoped") | first-person account + options (continue re-scoped / abort / take over) | `ESCALATED` (failed node parked; independent siblings finish) |
| **GATE** | `GATE` | node failed review `MAX_RETRIES` times (N20) | "tried 3×: \<what each cycle tried\>, options A/B/C" | `ESCALATED` (node parked at retry boundary) |

**Resolution (T15/T16/T17):** Jason replies (Discord) or acts (CLI `beckett ...`). The chosen
`EscalationOption.effect` maps to one of: re-enter `EXECUTING` (with node re-scoped / `attempts`
reset), re-enter `PLAN` (re-plan), `FAILED` (decline), or `ABORTED`.

**Invariants:** never silent retry, never silent failure (Spec 00 ledger). Every escalation is logged
to the event log (Spec 09) and every resolution records a gate/outcome row for the learned model
(Spec 00: "log every gate outcome from day one").

---

## 10. Crash recovery

Durability target (Spec 00 ledger / open-questions A4): **persist `session_id` + node state on every
change; on restart resume and lose ≤ 1 in-flight turn.** Persistence mechanics owned by
[Spec 09](./09-persistence-data-model.md); worker resume mechanics by [Spec 02](./02-worker-abstraction.md).

### 10.1 Durable vs transient

| Datum | Durable? | Where | Recovery |
|---|---|---|---|
| `TaskRecord.state`, `NodeRecord.state` | **yes** | SQLite (Spec 09) | source of truth on restart |
| `NodeRecord.sessionId` | **yes**, written at spawn (N4) **before** streaming | SQLite | enables `--resume` / `exec resume` |
| `attempts`, `feedback[]`, `assumptions[]`, `Dag`, `Escalation` | **yes** | SQLite | reload verbatim |
| Live worker process handles, stdin pipes, tailer subscriptions | **no** (in-memory) | — | re-established on resume |
| In-flight turn output not yet on disk | **no** | — | lost (≤1 turn) — re-driven by resume |
| Smoke-alarm counters / check-in timers (Spec 03) | rebuildable | derived | re-armed from JSONL on resume |

### 10.2 Restart sequence (pseudocode)

```ts
async function recover() {
  for (const task of db.tasksWhere(t => !TASK_TERMINAL.has(t.state))) {
    switch (task.state) {
      case TaskState.INTAKE:
      case TaskState.CLARIFY:
        rearmAwaitingUser(task);            // re-listen for the Discord answer; no worker to resume
        break;
      case TaskState.PLAN:
      case TaskState.STAFF:
        replay(task.state);                 // cheap Opus step; just re-run it (idempotent)
        break;
      case TaskState.ESCALATED:
        rearmAwaitingUser(task);            // re-bind to the posted escalation message
        break;
      case TaskState.EXECUTING:
        await recoverDag(task.dag!);        // the interesting case ↓
        break;
      case TaskState.DELIVERING:
        replay(TaskState.DELIVERING);       // re-attempt the post (idempotent on message id)
        break;
    }
  }
}

async function recoverDag(dag: Dag) {
  for (const node of Object.values(dag.nodes)) {
    switch (node.state) {
      case NodeState.DISPATCHED:
      case NodeState.SUPERVISING:
      case NodeState.NUDGING:
      case NodeState.PAUSED:
        // worker process is gone. Re-attach via persisted session.
        await reattachWorker(node);         // Spec 02: claude --resume / codex exec resume
        node.state = NodeState.SUPERVISING; // re-enter supervise; re-arm alarms (Spec 03)
        break;
      case NodeState.INTEGRATING:
      case NodeState.REVIEWING:
      case NodeState.GATING:
        // no live worker (or short-lived integ worker). These steps are idempotent → re-run.
        replayNodePhase(node);              // re-merge / re-check / re-gate from persisted branch
        break;
      case NodeState.RE_DISPATCH:
        node.state = NodeState.READY;       // let the executor re-dispatch with persisted feedback
        break;
      // BLOCKED / READY / NODE_DONE / NODE_FAILED: nothing to do, executor tick() handles them.
    }
  }
  tick(dag);                                 // resume scheduling from persisted state
}
```

- **Reattach vs respawn (N4 durability):** because `sessionId` is persisted *the instant* the worker
  starts (before any output), every running worker is resumable. A worker mid-turn at crash loses only
  that turn — `--resume` continues from the last committed turn boundary.
- **Idempotent phases:** INTEGRATE/REVIEW/GATE are pure functions of (persisted branch + criteria),
  so re-running them after a crash is safe — no double-merge (git merge is idempotent on an
  already-merged branch; guard with a "merged?" check).
- **No orphan workers:** on restart, any worker process that somehow survived the daemon is detected
  by pid/session and either re-adopted or killed (owned by Spec 01/02). ⚠️ Orphan-reaping policy to be
  pinned in Spec 01.

---

## 11. Open gaps ⚠️

1. **EXECUTING-as-DAG-host framing** vs Spec 00's flat step list — confirm the formalization reads
   cleanly (§1).
2. **Shared vs separate retry budget** for crash (N12) vs gate-fail (N19) — pin with Spec 11 (§5.2).
3. **Per-node vs batched INTEGRATE** — recommended per-node; confirm with Spec 01/02 (§6.5).
4. **Failover re-staffing hook** inside the executor on rate-limit — interface shared with Spec 02/06
   (§6.4).
5. **Cycle detection ownership** at PLAN-validation — shared with Spec 11 (§6.3).
6. **Orphan-worker reaping** on restart — owned by Spec 01/02 (§10.2).
7. **`CONCURRENCY_CAP` is task-global vs daemon-global** — assumed daemon-global here; confirm Spec 01.

---

## 12. Summary

1. **Two interlocking FSMs:** a single-threaded **TASK FSM** (`INTAKE→CLARIFY?→PLAN→STAFF→EXECUTING
   →DELIVERING→DELIVERED`, plus `ESCALATED/ABORTED/FAILED`) wraps a fan-out of per-node **NODE FSMs**
   (`BLOCKED→READY→DISPATCHED→SUPERVISING⇄NUDGING/PAUSED→INTEGRATING→REVIEWING→GATING→DONE/FAILED`).
2. The Spec 00 loop steps DISPATCH/SUPERVISE/INTEGRATE/REVIEW/GATE are formalized as **NODE sub-states
   running concurrently inside the one TASK state `EXECUTING`** — that's what lets the DAG run.
3. The **DAG executor** is a topological scheduler under a concurrency cap: a node is `READY` when all
   deps are `NODE_DONE`; completing a node fires `dep_done` to unblock dependents; independent nodes
   parallelize, dependents sequence.
4. **INTEGRATE is first-class and per-node:** merge node branch ↔ project branch, re-check post-merge;
   conflicts (textual or interface-mismatch) spawn an **Opus integration worker** before any escalation.
5. **Retry ≤3** shared per node; recommendation = **resume-same-session for gate-fails, fresh-spawn for
   crashes / stuck-ruts / last attempt**; after MAX → escalate with "tried 3×, options A/B/C."
6. **Three escalation points** (CLARIFY/SUPERVISE/GATE) all park the task in `ESCALATED`; **crash
   recovery** resumes from durable SQLite state (`session_id` + node state persisted on every change),
   re-attaching live workers via `--resume` and losing ≤1 turn.

**Flagged inconsistencies / forks:** see §11 — chiefly the EXECUTING framing (a deliberate
formalization of Spec 00, not a contradiction), the crash-vs-gate retry-budget question, and per-node
vs batched INTEGRATE. None contradict the Spec 00 ledger; all are deeper-than-canon decisions left for
sibling specs.
