# Beckett — Spec 00: Overview & Canon

> **This is the anchor document.** Every other spec references it. It defines the vision, the
> vocabulary, the canonical decisions, and the doc map. If a deep spec contradicts this file,
> this file wins (or this file is wrong and we fix it here first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Research & rationale: [`../my-docs/`](../my-docs/) (harness wire-formats, decision log).

---

## 1. What Beckett is

**Beckett is an agentic coworker you reach in Discord.** You `@beckett` a task in whatever channel
you're already in; it goes off and does the whole thing and comes back like a colleague would —
sparingly, in its own voice, owning its decisions. Code is its primary expertise, but it's general:
it can email the marketing team, do research, or run ops, because it carries a robust memory of your
people, projects, and environment.

Beckett's defining trait is **agency**: it has its own home on a machine, its own GitHub and email
identity, its own memory it accumulates, and discretion over how it spends its resources. It doesn't
need supervision; it works best when it can just *do the thing* and only surface what you actually
need to know.

### The spine: a harness over harnesses

Beckett never does the work itself. It **composes and steers things that do** — Claude Code and Codex
are *harnesses*; Beckett is a harness over harnesses. The only primitive it manipulates is:

> **a worker = a harness instance + a scoped task + an isolated workspace + a resource envelope +
> acceptance criteria.**

Everything else — parallel, sequence, both — is a DAG of workers. Get that abstraction clean and the
whole loop falls out of it. (See [Spec 02 — Worker Abstraction](./02-worker-abstraction.md).)

### The cost principle (reframed for subscriptions)

The original principle was "Opus is judgment, not the clock": cheap models for the mechanical stuff
(intake, classification, formatting), Opus only for genuine judgment (plan, steer-on-drift, gate).
That still holds — **but Beckett runs on Jason's Claude/Codex *subscriptions*, not metered API**, so
there is **no dollar budget**. The discipline is now about **rate limits + wall-clock + attention**:
keep the expensive head (Opus) asleep, woken only by a signal or a check-in it scheduled for itself.

---

## 2. The four pillars of "self" (what makes it a coworker, not a tool)

These are the design north stars. Every feature should strengthen at least one.

1. **Discretion over resources.** Beckett decides worker count, model tier, effort, and whether a
   node is even worth doing. It proposes scope/resources, not a budget. Agency *is* discretion.
2. **A persistent home + earned knowledge.** Beckett lives at `/home/beckett/` on `loom-desk` and
   accumulates a **knowledge graph** of linked markdown (people, projects, env, and a *learned model
   of its own workers* — "Codex over-engineers data layers; this Sonnet is reliable on tests"). That
   model is earned through experience, which makes it genuinely Beckett's.
3. **Standing to push back.** Beckett can say "this spec contradicts itself" or "I'd decompose this
   differently," and can refuse to staff a bad plan. The clarify step is standing, not politeness.
4. **Self-governance.** Beckett can halt *itself*, not just its workers: "I don't think I should keep
   going on this, here's why — continue?" Knowing when to stop is what separates an agent with a
   viewpoint from a runaway loop.

And it **reports in the first person and owns its decisions**: "I aborted worker 3 because it was
rewriting the auth layer it didn't own; I re-scoped and re-dispatched."

---

## 3. The loop (canonical state machine)

```
INTAKE → CLARIFY? → PLAN → STAFF → DISPATCH → SUPERVISE ⇄ (nudge / pause / abort)
       → INTEGRATE → REVIEW → GATE → (re-dispatch | next node | DELIVER)

escalation-to-Jason reachable from CLARIFY, SUPERVISE, and GATE.
```

| Step | Who | What happens |
|---|---|---|
| **INTAKE** | Haiku | Receive the `@beckett` mention, classify, ack honestly with a one-line read. Receipt, not a promise. |
| **CLARIFY?** | Opus (escalated) | Enough to plan? Proceed on reversible ambiguity (note assumptions at delivery); ask ONE crisp question only on consequential/irreversible ambiguity. |
| **PLAN** | Opus | Write the task DAG + **acceptance criteria per node** (executable checks + NL), now — this is what GATE checks against. |
| **STAFF** | Opus | Assign each node a worker type from the capability table. Granularity scales **inversely** with worker strength. |
| **DISPATCH** | orchestrator | Spawn workers along the DAG — parallel where independent, sequenced where dependent. Each owns a non-overlapping scope in its own git worktree. |
| **SUPERVISE** | orchestrator + Opus | Tail worker JSONL **read-only**. Smoke-alarms or Opus's **self-scheduled check-ins** pull Opus in to read and decide **nudge / pause / abort**. |
| **INTEGRATE** | orchestrator + Opus | Merge worktree branches; reconcile interfaces. First-class phase, not an afterthought. |
| **REVIEW** | Opus / fresh reviewer | Verify against the criteria. Self-review for simple nodes; **fresh adversarial reviewer** (criteria + diff, no implementer context) for critical ones. |
| **GATE** | Opus | Pass → advance. Fail → re-dispatch with feedback (retry ≤3) → then escalate with options. No silent infinite retry, no silent failure. |
| **DELIVER** | Haiku (Beckett voice) | Final message in-channel: what was done, known limits, the artifact — plus the **handshake** ("PR's up — review or merge?"). |

Full detail: [Spec 04 — State Machine](./04-state-machine.md).

---

## 4. Canonical decisions (the ledger)

Single source of truth. Rationale for each lives in [`../my-docs/open-questions.md`](../my-docs/open-questions.md).

| # | Decision |
|---|---|
| **Runtime** | Long-lived **bun** daemon on **`loom-desk`** (Ubuntu 24.04, 8c/31GB, Tailscale `ssh loom-desk`). NOT a VM. |
| **Language** | **TypeScript** (run on bun). |
| **Harness drivers** | **Shell out to both** `claude -p` and `codex exec` as subprocesses speaking JSONL. No SDK embed in v1. |
| **Claude steering** | Nudge = `--input-format stream-json` user msg → lands next **turn boundary**. Abort = **kill + `--resume`**. Permissions = flags + hooks. |
| **Codex steering** | One-shot `exec` + `exec resume`. Nudge deferred to turn end. (app-server `turn/steer` is a v2 upgrade.) |
| **Economics** | **No dollar budget** — runs on subscriptions. Scarce resources = **rate limits + wall-clock**. "Budget" = scope/resources Beckett proposes. |
| **Rate limits** | **Failover** to the other harness; else queue + backoff; notify only if blocked a long time. (v0 = Claude-only → queue+backoff.) |
| **Workspace** | **Git worktree per worker** (branch each). INTEGRATE = git merge. No containers in v1 (Docker available if needed). |
| **Scope enforcement** | Worktree + PreToolUse **hook denies writes outside owned paths**; Claude `bypassPermissions` within scope; Codex `workspace-write --ask-for-approval never` (network opt-in per node). |
| **Brain** | **Hybrid w/ auto-escalation**: Haiku fields every mention, silently tags in Opus for judgment (plan / drift-read / gate). Opus off the clock between looks. |
| **Supervise** | **Non-invasive observation** (tail JSONL) + **Opus self-scheduled check-ins** + mechanical smoke-alarms. Intervention is a separate deliberate write. |
| **Discord** | **Ambient, no threads.** `@beckett` in any channel → replies in that same channel. Management lives **off Discord** (CLI). Sparseness is law. |
| **Mgmt surface** | **`beckett` CLI** (`ps`, `tail`, `nudge`, `abort`, `status`, `logs`) over SQLite + JSONL. No web UI in v1. |
| **Persistence** | **SQLite** (state) + **JSONL event log** (audit). Durability: persist `session_id` + node state on change; resume on restart, lose ≤ 1 turn. |
| **Criteria** | Per node: **executable checks** (tests/build/lint exit codes) + **NL criteria**. Mandatory — no node without a "done." |
| **Review** | **Tiered**: self for simple, **fresh adversarial reviewer** for critical. Cross-provider review post-v0. GATE = checks pass AND review pass. |
| **Retry/escalate** | **≤3** re-dispatch cycles → escalate with options. Never silent. |
| **Clarify bias** | **Proceed on reversible** (report assumptions at delivery), **ask once on irreversible**. Never ask about things it can just try. |
| **Plan gate** | **Go, surface only on ambiguity** — no approval gate; one-line read in the ack, then start. |
| **Identity** | Beckett's **own GitHub + Gmail** from day one (+ own Discord bot user, + own OS user `beckett`). |
| **Agency boundary** | Reversible work free (branch, PR, draft); outbound/irreversible via **delivery handshake** ("review or merge?" / "send as me, or you handle it?"). |
| **Memory** | **Knowledge graph** of linked markdown (`~/.beckett/memory/`, frontmatter + `[[wikilinks]]` + index). People, projects, env, learned-worker narratives. |
| **Persona** | Chill, quippy, young, energetic-but-relaxed (talks like Jason). `~/.beckett/persona.md`. User-facing voice only; internal prompts businesslike. |
| **Learned model** | **Design-for, build-later**: v1 static capability table + **log every gate outcome** to SQLite from day one. |
| **Secrets** | `~/.beckett/.env`; goal = **zero re-auth** (persist `claude`/`codex` subscription logins after one-time setup). |
| **Multiplayer** | **Design-for, build-later**: single-user v1, but `user_id` on every task/nudge/message. |
| **Task domain** | **General coworker, code-primary.** Operates from `/home/beckett/`; can create projects & register them in memory. |

---

## 5. Filesystem & host layout (loom-desk)

```
loom-desk (Ubuntu 24.04, user: beckett)
~/.beckett/
  config.toml            # tunables (concurrency cap, retry N, drift K, model routing)
  .env                   # secrets: DISCORD_TOKEN, GITHUB_PAT, GMAIL_*, ...
  persona.md             # Beckett's voice
  memory/
    MEMORY.md            # index (one line per fact)
    *.md                 # knowledge graph: people, projects, env, learned-worker notes
  beckett.db             # SQLite: tasks, nodes, workers, events, outcomes, users
  events/*.jsonl         # append-only audit log
  logs/                  # daemon + per-worker prettified logs
/home/beckett/projects/
  <project>/             # a git repo Beckett works in
    .beckett/worktrees/  # per-worker worktrees (branch each)
```

`claude`/`codex` auth persists in `~/.claude` and `~/.codex` (one-time login). See
[Spec 12 — Roadmap & Setup](./12-roadmap-setup.md).

---

## 6. Glossary

- **Harness** — an autonomous coding agent CLI Beckett drives: `claude -p` or `codex exec`.
- **Worker** — one harness instance running a scoped node in its own worktree under a resource
  envelope + acceptance criteria. The atomic unit.
- **Node** — one task in the DAG, with its own criteria, worker assignment, and scope.
- **DAG** — the plan: nodes + dependencies (parallel where independent, sequenced where dependent).
- **Nudge** — a soft steering message delivered to a running worker at a safe boundary, preserving
  its context (vs kill-and-restart). The default intervention.
- **Pause / checkpoint** — freeze a worker, inspect the diff, decide.
- **Abort** — hard-stop a worker, capture partial state.
- **Smoke-alarm** — a cheap mechanical drift signal (no-progress, repeated calls, over-resource,
  scope-violation, blocked). A signal to *look*, never an automatic verdict.
- **Check-in** — an Opus-scheduled future look at a worker ("wake me on team 3 in ~10 min").
- **Gate** — the pass/fail decision against acceptance criteria.
- **Delivery handshake** — the one crisp question at the finish line for the irreversible step
  (merge / send email).
- **Brain** — the Haiku-front-door + auto-escalated-Opus decision layer. Not a standing session.
- **Capability table** — the (harness, model, task_type) → fitness mapping STAFF uses; static in v1,
  learned later from logged outcomes.

---

## 7. Document map

| Spec | Title | Covers |
|---|---|---|
| 00 | **Overview & Canon** (this) | Vision, pillars, decisions, glossary, layout |
| 01 | [Architecture](./01-architecture.md) | Components, process model, runtime, data flow, concurrency |
| 02 | [Worker Abstraction](./02-worker-abstraction.md) | Worker struct, claude/codex drivers, spawn/steer/abort, telemetry, scope |
| 03 | [Control Plane & Supervise](./03-control-plane-supervise.md) | Observation, smoke-alarms, check-ins, nudge/pause/abort, drift→read→decide |
| 04 | [State Machine](./04-state-machine.md) | All states/transitions, DAG execution, integrate, escalation |
| 05 | [Discord Interface](./05-discord-interface.md) | Ambient model, intake/clarify/deliver, sparseness, multiplayer-ready, bot setup |
| 06 | [Brain & Models](./06-brain-models.md) | Hybrid routing, auto-escalation, prompt architecture, persona application |
| 07 | [Identity & Agency](./07-identity-agency.md) | GitHub, Gmail, action-class gates, handshakes, email poller |
| 08 | [Memory & Knowledge Graph](./08-memory-knowledge-graph.md) | md+frontmatter+wikilinks, index, recall, usage by brain/workers |
| 09 | [Persistence & Data Model](./09-persistence-data-model.md) | SQLite schema, event log, durability/recovery, outcome logging |
| 10 | [CLI](./10-cli.md) | `beckett` command surface, output formats |
| 11 | [Review, Gate & Quality](./11-review-gate-quality.md) | Criteria format, checks, tiered review, retry/escalation |
| 12 | [Roadmap & Setup](./12-roadmap-setup.md) | v0→v1→later build order, loom-desk setup checklist, risks |

---

## 8. Phasing (north star)

- **v0 — prove steering end-to-end.** Discord `@beckett` → Opus plan (single node) → ONE Claude worker
  in a worktree → SUPERVISE (smoke-alarm + manual nudge from CLI/Discord) → self-review vs criteria →
  DELIVER in-channel. One harness, one worker, real soft-interrupt.
- **v1 — the coworker.** Add Codex (unlocks failover) → multi-node DAG + integrate → delegated review →
  own GitHub/Gmail identity + handshakes → knowledge-graph memory → outcome logging.
- **Later.** Learned capability model on; multiplayer unlock; cross-provider review; Codex app-server
  steering; containers for untrusted contexts; web dashboard.
