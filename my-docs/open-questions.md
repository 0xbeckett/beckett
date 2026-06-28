# Beckett — Open Architecture Questions

> Living doc. Each question carries my current POV/recommendation so you can react fast rather than
> start from blank. Answer in any order, in batches. We resolve these → then write `specs/`.
> Status legend: 🔴 unanswered · 🟡 leaning · 🟢 decided

## Decisions Log

- **2026-06-27 — Stack = TypeScript** (A2 🟢). Claude Agent SDK + discord.js + Codex via subprocess; SQLite for state.
- **2026-06-27 — Harness drivers = CLI-shell BOTH** (B1/B2 🟢). Shell out to `claude -p` and `codex exec`
  uniformly as subprocesses speaking JSONL. *No SDK embed in v1.* Consequences: Claude nudge = stdin
  stream-json at turn boundary (✅ retained); Claude abort = **kill + `--resume`** (no graceful interrupt);
  permissions via **flags + hooks**, not `canUseTool` callbacks; Codex unchanged (one-shot + resume).
  Upgrade path: swap *just* the Claude driver to the SDK later if interrupt fidelity is needed.
- **2026-06-27 — v0 = single-worker steerable Claude loop** (K1 🟢). Discord → Opus plan (1 node) →
  one Claude worker in a git worktree → supervise (drift signal + Discord nudge) → self-review vs
  criteria → deliver in-thread. Codex/multi-node/agency come after.
- **2026-06-27 — Multiplayer = design-for, build-later** (E4 🟢). Single-user loop in v1, but every
  task/nudge/message carries `user_id` from day one so multiplayer is a fast-follow, not a rewrite.
- **2026-06-27 — Workspace = git worktree per worker** (C1 🟢). Each worker on its own worktree/branch;
  INTEGRATE = git merge. Containers deferred to untrusted/multi-tenant.
- **2026-06-27 — Brain = HYBRID with auto-escalation** (D1 🟢). Cheap model (Haiku) fields every
  `@beckett` mention — it's chatty when it can be, and *internally* decides "this is out of my
  purview, tag in Opus" for real judgment (plan / drift-read / gate). Escalation is automatic and
  invisible to the user. Opus continuity = SQLite + memory files, not a pinned context.
- **2026-06-27 — Discord = AMBIENT, no threads** (E1 🟢 — *replaces my thread-per-task proposal*).
  Beckett "works where you work": you `@beckett` in any channel (e.g. `#general`); it responds **in
  that same channel** when done or when it needs you. The DAG/worker/telemetry management lives
  **off Discord** (separate surface — see new Q L1). Discord carries ONLY: mention → optional
  clarifying Q&A (Beckett can push back / disambiguate inline) → silence while working → optional
  "stuck, need you" → delivery. **Sparseness is law:** never show tool calls, per-node "done", or
  progress spam — only what the user ABSOLUTELY needs. Multiplayer falls out naturally (anyone, any
  channel; attribution = who mentioned).
- **2026-06-27 — Acceptance criteria = executable checks + NL** (H1 🟢). Every node gets machine-checkable
  commands (tests/build/lint exit codes) AND natural-language criteria for the reviewer, written at
  PLAN time. GATE passes only if checks exit 0 AND reviewer confirms NL criteria.
- **2026-06-27 — Management surface = CLI + structured logs** (L1 🟢, new). A `beckett` CLI
  (`ps`, `tail`, `nudge`, `abort`, `budget`, …) over SQLite state + JSONL event logs. No web UI in v1.
  (Implies persistence = SQLite + JSONL event log, confirming A3.)
- **2026-06-27 — Supervise = non-invasive observation + Opus self-scheduled check-ins** (D2/D3 🟢).
  Beckett continuously *tails* each worker's JSONL (stream + on-disk transcript) — **read-only, never
  interferes**. Opus is pulled in to look by EITHER (a) mechanical smoke-alarms — no-diff-progress over
  K turns, spend > ~1.5× node budget, N repeated near-identical tool calls, scope-violation/worker-
  blocked — OR (b) **a check-in Opus scheduled for itself** at plan/decision time ("wake me on team 3
  in ~10 min / after N turns"). Observation is decoupled from intervention; nudge/pause/abort are
  separate deliberate writes. Opus stays off the clock between looks. *Implementation: orchestrator
  keeps a per-worker timer/turn-count scheduler that Opus populates via its structured decision output.*
- **2026-06-27 — Clarify bias = proceed on reversible, ask on irreversible** (E?/clarify 🟢). Sensible
  default + report-assumptions-at-delivery when cheap/reversible; one crisp question BEFORE acting when
  consequential/irreversible. Never ask about things it can just try.
- **2026-06-27 — Agency identity = OWN accounts from day one** (F1 🟢). Beckett gets its own GitHub +
  Gmail identity in v1 (not borrowing Jason's). Pushes branches / opens PRs / sends+reads email AS
  ITSELF. Action-class gates still govern what it may do unattended (see F3/F4). Raises v1 setup +
  security surface — handled via the Identity abstraction + gates.

---

- **2026-06-27 — REVIEW/GATE = tiered (self → fresh reviewer)** (H2 🟢). Executable checks always run;
  simple nodes = Opus self-reviews diff; critical nodes = spawn a FRESH reviewer (criteria + diff, no
  implementer context) for adversarial eyes. GATE = checks pass AND review passes. Cross-provider
  review is a post-v0 upgrade for critical nodes.
- **2026-06-27 — NO DOLLAR BUDGET; runs on subscriptions** (Section I 🟢 — *major reframe*). Beckett
  uses the user's Claude Code / Codex **subscriptions**, not metered API. There is no USD ledger, no
  token→USD normalization, no `--max-budget-usd`. The "budget" abstraction becomes **scope & resources**:
  Beckett proposes *what it needs* (worker count, effort/reasoning level, rough time, which harnesses).
  The only scarce resources are **subscription rate limits + wall-clock**. Self-halt is framed in those
  terms ("this is bigger than scoped — another team + ~2h, continue?"), never dollars. `total_cost_usd`
  from Claude's stream is informational only.
- **2026-06-27 — GitHub = free branch/PR, merge via delivery handshake** (F3 🟢). Beckett pushes
  `beckett/*` branches and opens/updates PRs as itself with no approval. Merging is **conversational at
  delivery**: "PR's up — want to review it yourself, or can I merge to main?" → acts on the answer
  (merge, or stop because the task is done). Standing auto-merge can be granted later.
- **2026-06-27 — Email = autonomous read/triage/draft, gated send** (F2 🟢). Beckett reads, classifies,
  triages, and can spawn tasks from its inbox autonomously, and drafts replies. **Sending anything always
  asks** via the delivery handshake: "drafted it to your inbox — send as me, or you handle it?" Applies to
  cc'd threads too.

- **2026-06-27 — Runtime = loom-desk (Jason's machine), NOT a VM** (A1 🟢 — *corrects stale memory*).
  Beckett is a long-lived daemon on **loom-desk**: Ubuntu 24.04, x86_64, **8 cores / 31GB RAM**, reachable
  via `ssh loom-desk` (Tailscale). Present: **bun 1.3.13**, Docker 29, git 2.43, node v18.19 (old), npm 9.
  **Missing (v0 prereqs): `claude` CLI, `codex` CLI** (must install + auth against subscriptions),
  plus pnpm/tmux/sqlite3-cli (we'll use `better-sqlite3`/bun's sqlite, so the CLI isn't required).
  Trusted single-user box → reinforces no-containers-in-v1 (Docker available if ever needed).
  Orchestrator target runtime: **bun** (modern, already installed; avoids the node-18 problem).
- **2026-06-27 — Plan gate = GO, surface only on ambiguity** (J/plan 🟢). Beckett acks with a one-line
  read of what it'll do, then starts immediately — no approval gate. Returns only at the irreversible/
  consequential bar (clarify-bias) or when stuck. Big-swing tasks may include scope/resources in the ack.
- **2026-06-27 — Rate limits = FAILOVER across harnesses, else queue+backoff** (I/limits 🟢). On hitting a
  Claude/Codex subscription cap, Beckett routes compatible pending nodes to the other harness; if neither
  fits, pause + auto-retry with backoff and notify only if blocked a meaningfully long time. *v0 is
  Claude-only, so v0 behavior = queue+backoff; failover activates once Codex is wired (this pulls Codex
  integration a little earlier than a pure v0).*
- **2026-06-27 — Learned worker model = design-for, build-later** (G1 🟢). v1 staffs from a **static
  capability table** (heuristics) but **logs every gate outcome** `(harness, model, task_type) →
  {passed, retries, drift_events, turns}` to SQLite from day one. Adaptive staffing + Opus narration
  ("Codex over-engineers data layers…") turns on later from real data.
- **2026-06-27 — Durability = resume, lose ≤ current turn** (A4 🟢). Persist `session_id` on worker
  start and DAG node state on every change; on restart re-attach via `claude --resume` / `codex exec
  resume` and re-enter SUPERVISE. Worst case loses the single in-flight turn.

- **2026-06-27 — Task domain = general agentic coworker, code-primary** (K/domain 🟢). Beckett handles a
  broad range (code, email, research, ops) with **software as its primary expertise**. Non-code tasks
  work because of robust **memory** (e.g. "email the marketing team that we're a go for Project Anaconda"
  resolves *marketing team* + *Project Anaconda* from memory). Beckett operates from its own home
  `/home/beckett/` on loom-desk, can **create coding projects and register them in memory**, and has deep
  understanding of its own environment.
- **2026-06-27 — Memory = knowledge graph of linked markdown** (G2 🟢). Many robust `.md` files under
  `~/.beckett/memory/` with frontmatter + `[[wiki-links]]` between them = a knowledge graph (people,
  projects, preferences, env facts, learned-worker narratives). Mirrors Claude Code's own memory pattern
  (index + per-fact files). This is what makes Beckett agile across non-code domains. First-class subsystem.
- **2026-06-27 — Filesystem layout & own OS user** (A1 🟢). Propose a dedicated Unix user `beckett` on
  loom-desk (its "own self" extends to the OS account). `~/.beckett/` = config + md knowledge
  (`persona.md`, `memory/`, capability table, pricing N/A). `/home/beckett/projects/<name>/` = repos/
  projects (each a git repo; worktrees under `.beckett/worktrees/`). `~/.beckett/.env` = secrets.
- **2026-06-27 — Persona = chill, quippy, young, energetic-but-relaxed** (voice 🟢). Talks like Jason does
  here (casual, lowercase-friendly, dry wit). Lives in `~/.beckett/persona.md`. Applies to the
  user-facing `@beckett` (Haiku front-door) voice; internal worker/reviewer prompts stay businesslike.
- **2026-06-27 — Secrets = `.env`, zero-reauth** (secrets 🟢). Credentials in `~/.beckett/.env`
  (Discord bot token, GitHub PAT, Gmail auth). Goal: Beckett runs indefinitely **without Jason needing to
  re-auth** — incl. persisting `claude`/`codex` subscription logins (`~/.claude`, `~/.codex`) after a
  one-time setup.

## A. Substrate & process model

**A1. 🔴 What does Beckett physically run on?** Memory says v1 = shared project VM, collaboration
wedge. My POV: Beckett is a **single long-lived daemon process** per project VM (not serverless),
because the supervise loop needs persistent in-memory handles to running worker streams. One VM = one
Beckett = one project/team. Confirm: one Beckett per project, or one Beckett serving many projects?

**A2. 🔴 Implementation language?** The Claude Agent SDK is first-class in **TypeScript** and Python;
Codex's programmatic surface (app-server) ships **TypeScript bindings** (`generate-ts`). My POV:
**TypeScript** for the orchestrator — best SDK coverage on both sides, good async streaming, easy
Discord lib (discord.js). Python is viable but Codex integration is rougher. Your call?

**A3. 🔴 Persistence layer?** The DAG, worker state, budget ledger, and Beckett's memory must survive
VM restarts mid-task. My POV: **SQLite** (single-file, on the VM) for state + a JSONL event log for
audit. Postgres only if multi-project later. Agree, or do you want something else (Redis for the
nudge queue)?

**A4. 🔴 Crash recovery semantics.** If the VM/daemon dies with 3 workers mid-task, on restart Beckett
should: re-attach to survivable sessions via `--resume`/`exec resume` from the persisted session_ids,
and re-spawn the rest. My POV: persist `session_id` the instant each worker starts so every worker is
resumable. Acceptable? How hard is the durability requirement — is "lose at most the current turn" OK?

---

## B. Harness integration depth (the biggest fork)

**B1. 🔴 Claude driver: SDK-embed vs CLI-shell?** SDK gives `interrupt()`, `canUseTool`, programmatic
streaming input. CLI (`claude -p --input-format stream-json`) gives steering-at-turn-boundary but
interrupt = kill+resume. My POV: **embed the TS SDK** for Claude workers — steering fidelity is the
whole thesis. Worth the heavier dependency?

**B2. 🔴 Codex driver: one-shot `exec` vs `app-server`?** This is THE decision. `exec` is simple but
**cannot be nudged mid-run**. `app-server` (JSON-RPC, `turn/steer` + `turn/interrupt`) gives real
steering but is experimental and heavier. My POV: **start with `exec` + `exec resume`** (nudge =
"queue steer text, apply at next turn"), and treat app-server as a v2 upgrade *only if* Codex workers
turn out to need true mid-turn steering. Most Codex nodes will be tightly-scoped one-shots anyway
(granularity scales inversely with worker strength). Agree to defer app-server?

**B3. 🔴 Is the "nudge" allowed to be best-effort/asymmetric in v1?** i.e. Claude = instant-ish
(next turn), Codex = only between turns. My POV: yes, document it honestly rather than fake parity.
The supervise UI just shows "nudge queued" vs "nudge delivered." OK?

**B4. 🔴 Do we want dual-provider cross-check on the same node** (run Claude *and* Codex, diff results)
in v1, or later? My POV: later — it's a quality multiplier, not a core-loop requirement.

---

## C. Workspace, scope & isolation

**C1. 🔴 How is scope ownership *enforced*, not just declared?** Options: (a) **git worktree per
worker** (clean isolation, natural merge), (b) shared dir + PreToolUse hook that **denies writes
outside scope**, (c) Codex sandbox `workspace-write` rooted at the worker's dir. My POV: **git
worktree per worker on a shared repo** as the primary mechanism — it makes the INTEGRATE phase a real
`git merge`, and pairs with Claude's `--worktree` and Codex's `--cd`. Hooks/sandbox enforce the
boundary *within* the worktree. Agree?

**C2. 🔴 Containers or just dirs/worktrees?** Full container-per-worker (Docker) gives real blast-radius
control but adds weight. My POV for v1 (trusted shared VM, collaboration wedge): **worktrees + Codex
OS sandbox + Claude tool allowlist**, no per-worker containers yet. Containers when Beckett runs
untrusted/multi-tenant. OK to defer containers?

**C3. 🔴 Network access policy per worker.** Codex defaults network OFF in workspace-write. Tasks
needing `npm install`/`git push`/API calls must opt in. My POV: **default-off, opt-in per node** in
the plan ("this node needs network for deps"). Beckett's planner decides. Reasonable?

**C4. 🔴 Integration/merge conflict handling.** When two worktrees touch adjacent code despite scoping,
who resolves? My POV: Beckett attempts auto-merge; on conflict, spawn a dedicated **integration
worker** (Opus) with both diffs + the interface contract. Escalate to you only after that fails. OK?

---

## D. Beckett's brain & the supervise control plane

**D1. 🔴 Is "Beckett the brain" a persistent Opus session, or orchestration code that *calls* Opus on
signal?** The pitch says Opus = judgment not clock. My POV: **orchestration code (TS) that invokes
Opus statelessly per decision** (plan / drift-read / gate), passing the relevant transcript slice.
Beckett's *continuity* lives in the DB + memory files, not in a pinned Opus context. This keeps the
expensive head asleep. But the coworker *voice* needs continuity — handled by always feeding Opus
Beckett's persona + memory. Agree the brain is code-orchestrating-Opus, not a standing Opus chat?

**D2. 🔴 Which cheap signals trigger an Opus "go read the worker" decision?** Candidates: token-spend
rate spike, wall-clock over node estimate, N repeated near-identical tool calls, no-diff-progress over
K turns, worker emitted an error/asked a question, scope-violation attempt (hook fired). My POV: start
with **(a) no-diff-progress over K turns, (b) spend > 1.5× node budget, (c) scope-violation, (d)
worker explicitly asks/blocks.** Each fires → one cheap "summarize last 3 turns" → Opus decides
nudge/pause/abort. Which signals do you most want? Any I'm missing?

**D3. 🔴 Where does the supervise loop get its data — parse stdout streams, or watch on-disk JSONL,
or both?** My POV: **parse the live stream** for counters (free, real-time) and use the on-disk JSONL
as the durable record / for "Opus go read." Both, with the stream as primary. OK?

**D4. 🔴 Nudge queue mechanism.** My POV: in-memory per-worker queue, drained at the worker's next
safe boundary; persisted to DB so a restart doesn't drop a pending nudge. For Claude = stdin write;
for Codex = held until next `exec resume`. Agree?

**D5. 🔴 The "ask the worker its plan" mid-flight question** — you flagged this as highest-leverage.
For Claude this is a nudge ("what's your current plan?") read next turn. For Codex one-shot it's not
possible mid-run (only after turn). My POV: implement as a first-class control op `ask_plan(worker)`
that's instant for Claude, deferred for Codex. Confirm you want this as a named primitive.

---

## E. Discord interface & interaction model

**E1. 🔴 Channel/thread topology.** Options: one **thread per task**, one channel per project, DMs for
1:1. My POV: **a Beckett channel per project; each new task spawns a Discord thread**; Beckett posts
sparse updates in-thread; the channel root is for "new task" intake and status. Multiplayer = many
people in the channel. Agree with thread-per-task?

**E2. 🔴 What triggers a Discord message from Beckett (sparseness policy)?** My POV: post on **state
transitions worth a coworker's words** — ack (intake), clarifying questions, plan summary (optional),
"hit a wall / escalation", and delivery. NOT on every worker turn. Drift/nudges are silent unless they
escalate. Tunable "chattiness" per user. What cadence feels right to you?

**E3. 🔴 How does steering map to Discord?** My POV: a reply in the task thread = a **nudge** routed to
the relevant worker(s) (Beckett decides which, or asks). "stop" / "pause" keywords map to abort/pause.
Slash commands (`/beckett status`, `/beckett budget`, `/beckett abort`) for explicit control. Want
slash commands, natural language, or both? (I lean both: NL for collaboration, slash for control.)

**E4. 🔴 Multiplayer attribution & priority.** Multiple people task Beckett in one channel. My POV:
Beckett tracks who asked what, can run concurrent tasks, and when requests conflict it says so
("Jason asked X, Sam asked Y, they collide on auth — which first?"). Does v1 need multi-user, or is it
you-only first with multiplayer as fast-follow? (Memory says collaboration is the *wedge*, so maybe
multiplayer is v1-critical?)

**E5. 🔴 Does Beckett act in voice/DM/other surfaces, or Discord-only for v1?** My POV: Discord-only
surface for v1; email is *agency* (B-to-world) not *interface* (you-to-B). Confirm.

---

## F. Identity & external agency (the "self")

**F1. 🔴 Does Beckett have its own credentials, or act as you?** The pitch wants its own email,
GitHub, Discord identity. My POV: **Beckett gets its own GitHub account + its own Google/Gmail
account** (true agency, clean attribution, safe blast radius) rather than borrowing your tokens.
Discord = its own bot user (already separate). Confirm you want separate real accounts provisioned?

**F2. 🔴 Email: ride the available Gmail MCP, or raw SMTP/IMAP on Beckett's own account?** My POV:
Beckett's own Gmail account, driven via the **Gmail MCP** (we have it) for send/read/label, so workers
and the brain can use email as a tool. The "cc Beckett / Beckett replies" flow = a poller on its
inbox that classifies (cheap) → maybe spawns a task. Agree?

**F3. 🔴 GitHub agency model.** Beckett's own GH account, added as collaborator to repos, pushes
branches + opens PRs **as itself**, can review/comment. My POV: branch-and-PR, never force-push to
shared branches; PRs are the integration handoff. Human merges, or Beckett can merge its own PRs after
green CI + gate? (I lean: Beckett opens PR, you merge, until trust is established → then auto-merge on
green.)

**F4. 🔴 How much can Beckett spend/act without asking?** This is the agency budget. My POV: a
**standing discretionary budget** (per-task default + daily cap) Beckett spends freely within; above
cap it asks. Plus action-class gates (e.g. "can email external people? can open public PRs? can spend
>$X?"). What are the hard "always ask first" actions for you?

---

## G. Memory & learning

**G1. 🔴 The learned worker-capability model** ("Codex over-engineers data layers; this Sonnet is
reliable on tests"). My POV: a structured store updated after each gate — `(harness, model, task_type)
→ rolling stats (pass-rate, retries, cost, drift events)` — that the STAFF step queries. Start as a
JSON/SQLite table; the *narrative* version ("Codex over-engineers…") is Opus summarizing the stats.
Agree this is the "most its-own-stuff" asset and worth building early?

**G2. 🔴 Beckett's general memory.** Persona, project facts, past decisions, your preferences. My POV:
file-based like Claude Code's own memory (markdown + index), living on the VM, fed into the brain's
prompts. Reuse the same pattern. OK?

**G3. 🔴 Does learning cross projects?** If one Beckett per project, the worker-capability model is
per-VM. My POV: keep a **shared, project-agnostic worker model** synced across Becketts (worker
behavior generalizes), but project memory stays local. Worth it, or keep everything local for v1?

---

## H. Acceptance criteria, review & gate

**H1. 🔴 What form do acceptance criteria take?** Options: natural language, machine-checkable
(tests/lint/build commands), or both. My POV: **both** — every node gets (a) executable checks Beckett
runs itself (tests/build/lint exit codes) and (b) NL criteria for the delegated reviewer. Written at
PLAN time. Agree criteria are mandatory per node (no node without a "done" definition)?

**H2. 🔴 Self-review vs delegated review threshold.** My POV: Beckett chooses — simple node = self
(read diff, run checks, Opus judges); complex/critical node = **fresh reviewer** (new claude -p with
*only* criteria+diff, no implementer context) for adversarial eyes. Codex can be the reviewer for
Claude's work and vice-versa (different failure modes). Want cross-provider review as default for
critical nodes?

**H3. 🔴 Retry budget & escalation format.** My POV: **N=2–3** re-dispatch cycles with reviewer
feedback, then stop and escalate to Discord: "tried 3×, stuck here, options: A/B/C." Never silent
infinite retry, never silent failure. Confirm N and the escalation message shape.

---

## I. Budget & economics

**I1. 🔴 Budget granularity & who sets it.** My POV: per-task budget proposed by Beckett at plan time
(from the capability model's cost stats), you can override; per-node sub-budgets; a daily/global cap.
Beckett can *choose to spend less* (its discretion). Agree Beckett proposes, you can cap?

**I2. 🔴 Codex USD normalization.** Since Codex emits tokens only, I need a pricing table
(`model → $/Mtok in+out`) maintained in config to fold Codex spend into one ledger. Confirm you're OK
maintaining a small pricing config (it'll drift as prices change).

**I3. 🔴 Self-halt economics.** "I don't think I should keep spending on this." My POV: trigger when
projected cost-to-done (from retries/drift) exceeds remaining budget × factor, Beckett pauses and asks
rather than burning the budget silently. Want a hard self-halt, or always-ask-before-halt?

---

## J. State machine, durability & scale

**J1. 🔴 Confirm the state machine.** INTAKE → CLARIFY? → PLAN → STAFF → DISPATCH → SUPERVISE ⇄
(nudge/pause/abort) → INTEGRATE → REVIEW → GATE → (re-dispatch | next node | DELIVER), escalation
reachable from CLARIFY/SUPERVISE/GATE. Any states to add (e.g. an explicit INGEST/CONTEXT-GATHER
before PLAN, or a PR/CI-wait state)?

**J2. 🔴 Max concurrent workers & resource limits.** My POV: a configurable concurrency cap (start
small, e.g. 4–6) gated by VM CPU/RAM; excess nodes queue. Each harness instance is heavy. What's the
target VM size / concurrency you imagine?

**J3. 🔴 Long-running tasks.** Tasks may run hours/days. My POV: fully async — Beckett owns the task,
posts sparse updates, survives restarts, you can walk away. Confirm tasks are "fire and forget with
updates," not "keep the session open."

---

## K. Scope / phasing

**K1. 🔴 What is the thinnest end-to-end v0** that proves the thesis? My POV:
`Discord task → Opus plan (single node) → spawn ONE Claude worker in a worktree → supervise with
basic drift signal + manual nudge from Discord → self-review against criteria → deliver in-thread`.
One harness (Claude), one worker, real steering. Then add: Codex workers → multi-node DAG → delegated
review → email/GitHub agency → learned model. Does this v0 match your instinct, or is multiplayer /
multi-worker essential to even the first proof?

**K2. 🔴 What's explicitly OUT of scope for v1?** My candidates to cut: containers, app-server steering
for Codex, dual-provider cross-check, cross-project learning, voice/non-Discord surfaces, auto-merge.
Anything here you consider v1-essential?
