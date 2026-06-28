# Beckett — Spec 03: Skills (the playbook)

> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> The parent agent's on-demand playbook. Each skill is a markdown `SKILL.md` under
> `.claude/skills/<name>/` that the parent loads when its chosen path ([Spec 02](./02-doctrine.md))
> needs it — **not** a fixed pipeline. Skills replace the v0.1 hand-coded `brain/*` prompts; the
> *formats* below (acceptance criteria, review verdict) are carried forward unchanged and are
> canonical.

---

## 1. Why skills (not code)

In v0.1 each brain step was a TypeScript function assembling a prompt and parsing structured
output. In v2 the parent *is* the model, so each step is a **skill**: instructions + formats it
reads and applies in its own context. This means:

- The decision logic lives where the reasoning happens (no LLM-call round-trips for judgment).
- Skills are composable and skippable — the parent uses `plan` for a heavy task, skips it for a
  trivial one.
- Formats (criteria, verdict schemas) are stated once in the skill and reused by the workers /
  reviewers the parent spawns.

Each skill's `SKILL.md` carries: **purpose**, **when to use** (and when not), **inputs it
gathers**, **the output/format it produces**, and the **decision rules** (the businesslike
layer-2 instructions from the old brain prompts).

---

## 2. Skill catalog

| Skill | Used on path | Purpose |
|---|---|---|
| [`intake`](#intake) | all | Classify the mention, write the honest one-line ack. |
| [`recall`](#recall) | all | Pull the relevant slice of the memory knowledge graph. |
| [`plan`](#plan) | one-worker (lite), heavy | Author acceptance criteria; for heavy, the DAG. |
| [`staff`](#staff) | heavy | Assign harness/model/effort per node from capability guidance + learned notes. |
| [`supervise`](#supervise) | one-worker, heavy | Read a worker digest and decide continue/nudge/pause/abort/reschedule. |
| [`review`](#review) | one-worker, heavy | Verify a diff against criteria; run the gate. |
| [`deliver`](#deliver) | all non-inline | Compose the final in-channel message + any handshake. |
| [`remember`](#remember) | as needed | Write a durable cross-task fact into memory (dedup-checked). |

---

## 3. The skills

### intake
**Purpose:** turn an `@beckett` mention into (a) an effort judgment ([Spec 02 §2](./02-doctrine.md))
and (b) an honest one-line ack — a *receipt, not a promise*.
**Decision rules:** classify `kind` ∈ {task, question, chatter, fyi} and whether it's within
purview. For a task, the ack states the read and the immediate next step ("on it — branching off
main, wiring the JWT swap, running the suite"). No over-promising; no "let me think harder"
filler. Chatter/fyi get a light reply or none (sparseness).
**Output:** a posted ack (via `discord_reply`) + the parent's internal effort decision.

### recall
**Purpose:** fetch the relevant slice of memory before planning/answering, so decisions use what
Beckett knows about the people/projects/env in play.
**Mechanism (carried forward, [Spec 06](./06-identity-memory.md)):** 3-tier, cheap-first —
always read `MEMORY.md` index; score index lines against the task and fetch top-K full bodies;
one-hop graph expansion across `[[wikilinks]]`. Implemented behind a `beckett memory recall
"<query>"` CLI; the skill tells the parent when/how to call it and how to weave results in.
**Output:** memory snippets injected into the parent's working context.

### plan
**Purpose:** define **done** before doing. On the one-worker path, "plan lite" = just author the
acceptance criteria. On the heavy path, also produce the DAG.
**Acceptance criteria format (canonical, mandatory for non-trivial work):**
```ts
interface AcceptanceCriteria {
  checks: string[];           // shell commands; exit 0 = pass (deterministic floor)
  nl: string[];               // atomic English statements; reviewer judges met/not-met (ceiling)
  interfaceContract?: string; // optional boundary contract with parallel nodes
}
```
**Authoring rules:** every node has criteria (checks and/or nl; empty = a plan defect). Checks
must be runnable as-is, non-interactive, deterministic, scoped to the node (`npm test -- src/auth`),
and network-free unless the node's envelope opts in. NL statements are atomic and verifiable from
the diff ("malformed/expired tokens are rejected with 401, not 500"), and must cover the request
**+ error handling + backward-compat + 'no check was weakened to pass'**.
**DAG rules (heavy):** smallest right decomposition; acyclic; non-overlapping `scopePaths` per
concurrent node (no merge conflicts by choice); depend only on what truly must come first
(maximize parallelism); per node propose `{title, intent, dependsOn, scopePaths, criteria,
suggestedWorker, envelope, reviewTier, initialCheckIn}`. **Standing to refuse:** if the spec
self-contradicts or can't be decomposed sanely, emit no nodes and say why.

### staff
**Purpose:** assign each node a worker (harness, model, effort).
**Rules:** default **Sonnet** (Claude, own driver — steerable); **Opus** for genuinely
ambiguous or architecture-critical nodes; **Codex/pi** (via sandcastle) where memory's
learned-worker notes or capability guidance favor them. **Granularity scales inversely with
worker strength** — coarser nodes for stronger workers. Pull learned-worker notes via `recall`
("Codex over-engineers data-layer nodes — constrain or prefer Claude"). Effort → model tier +
reasoning level; set `turnCap`, `wallClockS`, `network` in the envelope ([Spec 04](./04-workers-and-hooks.md)).

### supervise
**Purpose:** on a watcher signal or check-in, decide the lightest sufficient intervention.
**Inputs:** the `worker_status` digest (turns, last action, diff stats, fired alarms, criteria,
envelope); optionally a `read_worker_log` slice if warranted.
**Decision (carried forward):** one of `continue | nudge | pause | abort | reschedule`, with a
required first-person `reason`. `message` required for `nudge`; `nextCheckIn` for `reschedule`;
optional `escalate {severity: fyi|needs_input, question}`.
**Rules:** an alarm is a *prompt to think*, never a verdict. **Never cheap-stop good work.**
Prefer `continue`/`reschedule` > `nudge` > `pause` > `abort`. A worker over its envelope but
making real progress → continue. Repeated identical tool calls or zero diff progress → look,
then usually nudge.

### review
**Purpose:** verify a node's diff against its criteria and run the **gate**.
**Tier selection (carried forward):** a node is **critical** (→ ≥ fresh review) if any hold:
touches security/auth/crypto/payments; touches deps/infra/CI; blast radius ≥ 2; diff ≥ 150
lines; files changed ≥ 8; external surface (public API, migration, deletes data, irreversible);
prior retries ≥ 1. Else **simple** (→ self-review). Most-critical nodes → **cross-provider** or
**panel** (N independent fresh reviewers, majority vote).
**Fresh reviewer:** a brand-new agent that never saw the implementer's reasoning. Gets criteria
+ diff + check results; **not** the session/transcript/rationale. Spawned read-only
(`--allowedTools Read,Glob,Grep --permission-mode dontAsk`), adversarial prompt ("you did NOT
write this and owe it no benefit of the doubt; for each NL criterion decide met/not-met citing
file:line; a failing check is an automatic blocker; if you can't verify it, it's NOT met").
**Verdict format (canonical):**
```ts
interface ReviewVerdict {
  pass: boolean;
  criteriaMet: { criterion: string; met: boolean; note?: string }[];
  issues: { severity: "blocker"|"major"|"minor"; criterion?: string; detail: string; location?: string }[];
  confidence: number; // 0..1
}
```
**The gate (canonical):** `pass := checks.allPass && verdict.pass`, **fail-closed** — the parent
re-derives pass (`criteriaMet.every(met) && no blocker`); any blocker forces fail; an
unverifiable/unparseable verdict is a fail, not a pass-by-default; a check timeout is a fail.
**On fail:** thread `ReviewerFeedback` (failed checks + blocker issues) into a re-dispatch
(resume + feedback by default; fresh spawn on crash/rut), retry ≤ 3, then **escalate with
options** ("tried 3×, stuck here: <summary>. A) more rope B) you take the branch C) drop it").
**Log the gate outcome** `(harness, model, task_type) → {passed, retries, drift_events, turns}`
to SQLite every time (feeds the learned model).

### deliver
**Purpose:** the final in-channel message. Persona voice. States what was done, known limits,
the artifact, and any assumptions made (proceed-on-reversible). For an irreversible finish
(merge, send email), include the **delivery handshake** ("PR's up — review or merge?") which
creates a pending action ([Spec 06](./06-identity-memory.md)). Honest terminal state: if the
handshake goes unanswered, the work is still delivered with the irreversible step left undone.

### remember
**Purpose:** persist a durable, cross-task world fact (a new person, a project's status change, a
learned-worker observation) into the knowledge graph.
**Rules (carried forward):** **dedup first** — exact name/alias, phantom upgrade, or
high-similarity description (same type) coerces to an update, not a duplicate; borderline →
ask/flag rather than auto-merge. **Anti-bloat:** never store what the repo, event log, or SQLite
already hold — only durable cross-task facts. Write goes through the `beckett memory remember`
CLI which handles atomic write + backlinks + index regen + git commit.

---

## 4. Authoring conventions

- Each `SKILL.md` is concise and imperative; it states decision rules and formats, not theory.
- Formats that workers/reviewers must follow (criteria, verdict) are quoted verbatim so the
  parent can paste them into spawned-worker prompts.
- Skills reference tools by their `beckett-control` names ([Spec 05](./05-tools-mcp.md)) and the
  memory/identity CLIs, so the parent knows exactly what to call.
- Persona is **not** applied inside skills except `intake`/`deliver`/escalation phrasing —
  reasoning stays businesslike ([Spec 02 §7](./02-doctrine.md)).

## 5. Cross-references
- When each skill is used (the paths) → [Spec 02](./02-doctrine.md)
- Worker spawn/control the skills drive → [Spec 04](./04-workers-and-hooks.md)
- Tool + CLI surface the skills call → [Spec 05](./05-tools-mcp.md)
- Memory recall/remember internals + handshakes → [Spec 06](./06-identity-memory.md)
