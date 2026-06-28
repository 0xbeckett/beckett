# Beckett — Spec 06: Brain & Models

> **The head, not the hands.** This spec defines Beckett's *thinking* layer: the Haiku front door
> that fields every `@beckett` mention, the silent auto-escalation to Opus for genuine judgment, the
> model-routing table for every decision Beckett makes, and the exact `claude -p` invocations +
> structured-output schemas that turn judgment into machine-readable decisions. The governing rule,
> from [Spec 00 §1 — the cost principle](./00-overview.md#the-cost-principle-reframed-for-subscriptions):
> **"Opus is judgment, not the clock."** Reframed for subscriptions: keep the expensive head **asleep**
> between looks; wake it only on a signal or a check-in it scheduled for itself. The brain is **not a
> standing session** — every Opus decision is a stateless `claude -p --json-schema` call with the
> relevant slice + persona + memory injected.
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Canon: [Spec 00](./00-overview.md). Research: [`claude-code-headless.md`](../my-docs/claude-code-headless.md),
> [`open-questions.md`](../my-docs/open-questions.md) (D1 brain, persona/voice).

---

## 0. Where this sits

The brain spans the *whole* canonical loop ([Spec 00 §3](./00-overview.md#3-the-loop-canonical-state-machine)) —
it is the "who" column. Haiku owns the cheap edges (INTAKE, DELIVER, chatter, summaries); Opus owns
the judgment middle (CLARIFY, PLAN, STAFF, drift-read, GATE, INTEGRATE).

```
@beckett ─▶ HAIKU front door ──(within purview)──▶ answer / ack / deliver, in Beckett's voice
                │
                └──(needs judgment: escalate flag)──▶ OPUS  (one stateless --json-schema call)
                                                        │  context = persona + memory + state + the one question
                                                        └──▶ structured Decision ──▶ orchestrator acts
                                                             Opus goes back to sleep.
```

**Three invariants this spec exists to enforce:**
1. **Haiku is always the front door.** Nothing user-facing skips it. Even an Opus decision is
   *spoken* by Haiku (Opus produces the decision + first-person `reason`; Haiku dresses it in persona
   voice for Discord). §1, §8.
2. **Opus is stateless and asleep by default.** No pinned Opus context. Continuity = SQLite +
   Memory ([Spec 08]) re-injected per call. §3.
3. **Internal prompts stay businesslike; persona is user-facing only.** Worker/reviewer/summary
   prompts get no quippy voice — that's a tool-quality risk. §5, §8.

**Boundaries (defer):**
- The supervise loop that *calls* the drift-read brain step (smoke-alarms, check-ins, the `Look`
  pipeline) → **[Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md)**. This spec
  owns *how* Opus is invoked there; Spec 03 owns *when* and *what flows through*.
- Memory format, recall, and the retrieval that produces the injected slice → **[Spec 08 — Memory &
  Knowledge Graph](./08-memory-knowledge-graph.md)** ⚠️ *(not yet written; injection contract below is
  the consumer side and must stay consistent with 08 once it lands).*
- The GATE/REVIEW verdict semantics + criteria format → **[Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md)** ⚠️ *(not yet written)*.
- The static capability-table *data* (which `(harness, model, task_type)` is fit) STAFF consumes →
  **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)** ⚠️ + the learned-model roadmap ([Spec 00 §4]).
- Worker spawn flags, `--append-system-prompt` wiring, `--effort`/`-c model_reasoning_effort`, JSONL
  parsing → **[Spec 02 — Worker Abstraction](./02-worker-abstraction.md)**. The brain *chooses* the
  worker `(harness, model, effort)`; Spec 02 *launches* it.
- Discord delivery mechanics (posting, threads-vs-ambient, escalation routing) → **[Spec 05 — Discord
  Interface](./05-discord-interface.md)** ⚠️.

All model ids and tunables below are **defaults in `~/.beckett/config.toml`** — the canonical `[models]`
block is owned by [Spec 01 §config](./01-architecture.md) and restated/extended in §9.

---

## 1. The hybrid architecture: Haiku front door + auto-escalation

### 1.1 Principle ([open-questions D1 🟢])

Every `@beckett` mention hits **Haiku first** — it is cheap, fast, always-on, and chatty. Haiku does
the mechanical front-of-house work: read the mention, classify it, and either **answer it itself**
(chatter, FYI, a question it can resolve from memory, an ack) or **silently tag in Opus** for anything
that needs real judgment. The user never sees the handoff; from Discord it's all just "Beckett."

> The whole point of the hybrid: Haiku makes Beckett feel *responsive and present* (instant acks,
> conversational), while Opus stays asleep until there's an actual decision to own. A pure-Opus brain
> would be slow, rate-limit-hungry, and overkill for "lgtm 👍". A pure-Haiku brain couldn't plan a DAG
> or judge drift. Hybrid gets both.

### 1.2 The escalation mechanism — Haiku self-assesses purview

Haiku's intake call is a **structured classification** ([`--json-schema`], §1.3). One field is the
escalation switch: `escalate` (bool) + `escalateRole` (which Opus role to wake). Haiku is prompted to
ask itself one question:

> *"Can I finish this completely and safely right now with what I have, or does it need judgment I
> don't own (planning work, deciding to interrupt a worker, gating quality, resolving a conflict,
> committing to an irreversible step)? If the latter — escalate."*

The bias is **conservative**: Haiku escalates whenever there's genuine doubt. Cheap-and-occasionally-
redundant beats a Haiku confidently mis-planning a refactor. Escalation is **silent**: there is no
"let me think harder…" message. Haiku may post an instant ack *first* (so the user gets a receipt),
then the orchestrator routes the task to Opus in the background (see the ack template, §5.3).

What Haiku is allowed to fully own (no escalation):
- **Chatter / social** — "nice", "thanks", "you around?" → conversational reply, no DAG ([Spec 04 T4]).
- **FYI / no-op** — a heads-up that doesn't ask for work → acknowledge, optionally write to Memory ([Spec 08]).
- **Pure-recall questions** — "what's the repo for Project Anaconda?" answerable from Memory alone.
- **The intake ack itself** — the one-line honest read that precedes any real work.
- **The final delivery message** — phrasing Opus's gated result in Beckett's voice (§8).
- **Cheap worker summaries** — the §4.1 compression in the supervise loop ([Spec 03]).

What Haiku **must** escalate (sets `escalate=true`):

| `escalateRole` | When | Opus role woken |
|---|---|---|
| `clarify` | a real task with potential ambiguity → does it need a question before planning? | §4.2 CLARIFY |
| `plan` | a real task that's clear enough to decompose | §4.3 PLAN |
| `staff` | (usually folded into the same PLAN call in v0; §4.4) | §4.4 STAFF |
| `gate` | "is this PR good?" / a quality judgment on existing work | §4.6 GATE → [Spec 11] |
| `integrate` | reconcile diffs / interface mismatch | [Spec 04 §6] integration |
| `decide` | anything that smells like judgment but doesn't fit above (Haiku's escape hatch) | Opus router picks |

> **Note:** the *supervise* drift-read (§4.5) is **not** reached through the Haiku front door — it's
> triggered by smoke-alarms/check-ins inside the control plane ([Spec 03 §4]). Haiku still does the
> **cheap summary** that precedes that Opus read, but the trigger is mechanical, not a Discord mention.

### 1.3 Haiku classification schema (the front-door decision)

The exact `--json-schema` payload for the intake call:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind", "withinPurview", "escalate", "ack"],
  "properties": {
    "kind":          { "enum": ["task", "question", "chatter", "fyi"] },
    "withinPurview": { "type": "boolean",
                       "description": "true iff Haiku can fully + safely resolve this now" },
    "escalate":      { "type": "boolean" },
    "escalateRole":  { "enum": ["clarify", "plan", "staff", "gate", "integrate", "decide"] },
    "ack":           { "type": "string", "minLength": 1,
                       "description": "the instant one-line reply in Beckett's voice (Spec 05); for a task this is the honest one-line read" },
    "answer":        { "type": "string",
                       "description": "present iff withinPurview && !escalate — the full conversational/recall reply" },
    "memoryQuery":   { "type": "string",
                       "description": "optional: a recall query the orchestrator runs against Memory (Spec 08) to enrich the escalated Opus call" },
    "memoryWrite":   { "type": "string",
                       "description": "optional: a fact worth persisting (Spec 08), e.g. a new preference stated in passing" }
  }
}
```

Cross-field rules (orchestrator-enforced, JSON Schema can't):
- `escalate===true` ⇒ `escalateRole` present.
- `withinPurview===false` ⇒ `escalate===true` (if Haiku can't own it, *someone* must).
- `answer` present **iff** `withinPurview && !escalate`.
- Validation failure → treat as `{ kind:"task", escalate:true, escalateRole:"decide" }` and let Opus
  sort it out — **never** silently drop a mention (no-silent-failure, [Spec 00 retry/escalate]).

The TS shape:

```ts
interface HaikuClassification {
  kind:          'task' | 'question' | 'chatter' | 'fyi';
  withinPurview: boolean;
  escalate:      boolean;
  escalateRole?: 'clarify' | 'plan' | 'staff' | 'gate' | 'integrate' | 'decide';
  ack:           string;                 // always posted (instant receipt)
  answer?:       string;                 // posted iff handled by Haiku
  memoryQuery?:  string;
  memoryWrite?:  string;
}
```

---

## 2. Model routing table (exhaustive)

Every decision Beckett makes, the model that makes it, and the effort. Model ids are the canonical
ones from [Spec 01 `[models]`](./01-architecture.md): Haiku = `claude-haiku-4-5`, Opus =
`claude-opus-4-8`, worker default = `claude-sonnet-4-5`, Codex = `gpt-5.1-codex`.

### 2.1 Brain roles (decisions Beckett makes *about* the work)

| # | Role | Loop step | Model | Effort | Schema (§4) | Notes |
|---|---|---|---|---|---|---|
| B0 | **intake / classify / ack** | INTAKE | Haiku | low | `HaikuClassification` §1.3 | the front door; always runs first |
| B1 | **chatter / FYI reply** | INTAKE→DELIVERED | Haiku | low | free text (`answer`) | no DAG |
| B2 | **recall answer** | INTAKE | Haiku | low | free text + `memoryQuery` | Memory-only Q&A ([Spec 08]) |
| B3 | **clarify** | CLARIFY | Opus | medium | `ClarifyOutput` §4.2 | proceed-on-reversible bias |
| B4 | **plan** | PLAN | Opus | **high** | `PlanOutput` §4.3 / §6 | the most important call |
| B5 | **staff** | STAFF | Opus | medium | `StaffOutput` §4.4 | v0: fused into B4; splits when learned model lands |
| B6 | **drift-read (supervise)** | SUPERVISE | Opus | medium | `SuperviseDecision` ([Spec 03 §4.3]) | per-look; cheap-summary first (B9) |
| B7 | **gate** | GATE | Opus | high | `GateVerdict` §4.6 → [Spec 11] | high stakes; criteria check |
| B8 | **integrate-reconcile** | INTEGRATE | Opus | high | (decision to spawn integration worker) | conflict/interface mismatch |
| B9 | **cheap worker summary** | SUPERVISE | Haiku | low | `WorkerSummary` ([Spec 03 §4.1]) | compresses transcript before B6 |
| B10 | **self-halt judgment** | SUPERVISE/EXECUTING | Opus | medium | `SuperviseDecision` (`escalate`) | "bigger than scoped — continue?" |
| B11 | **delivery voice** | DELIVER | Haiku | low | free text | dresses B7's gated result in persona |
| B12 | **escalation voice** | any escalation | Haiku | low | free text | dresses Opus's `reason`/`question` for Discord ([Spec 05]) |
| B13 | **email triage classify** | (agency) | Haiku | low | classification ([Spec 07]) ⚠️ | inbox poller; may spawn a task → re-enters B0 |

### 2.2 Worker roles (the *hands* — what the brain dispatches, not the brain itself)

STAFF (B5) assigns each node a worker from the capability table ([Spec 09]/[Spec 02 §7]). These are
*not brain calls* — they're full agent loops with tools. Listed here so the routing picture is complete.

| Worker role | Harness / model | Effort | When STAFF picks it |
|---|---|---|---|
| **workhorse** (default) | Claude `claude-sonnet-4-5` | low–medium | clear, well-scoped implementation; the common case |
| **codex specialist** | Codex `gpt-5.1-codex` | medium–high | per capability table (e.g. tight algorithmic / single-file tasks); failover target ([Spec 00 rate-limits]) |
| **heavy / ambiguous** | Claude `claude-opus-4-8` | high–xhigh | genuinely ambiguous or architecture-critical nodes; granularity scales inversely with strength ([Spec 00 STAFF]) |
| **fresh adversarial reviewer** | Claude `claude-opus-4-8` (cross-provider Codex post-v0) | high | critical-node review: criteria + diff, **no implementer context** ([Spec 11], [open-questions H2]) |
| **integration worker** | Claude `claude-opus-4-8` | high | merge-conflict / interface reconcile ([Spec 04 §6]) |

> ⚠️ **Effort caveat (from [Spec 02 §7.1]).** A `claude --effort` flag is **not verified** in
> [claude-code-headless.md]. Until confirmed on loom-desk, Claude "effort" is realized via **model
> tier** (`--model`) plus a reasoning instruction in the system prompt, not a flag. The `effort`
> column above is the *intent*; §4's invocations show the flag form marked ⚠️ with the model-tier
> fallback. Codex effort *is* wired: `-c model_reasoning_effort='"<level>"'` ([Spec 02 §7.1]).

### 2.3 Routing rules in one place

1. **Mention → always Haiku** (B0). No exceptions.
2. **Judgment → Opus, woken statelessly** (B3–B8, B10). One call, one decision, back to sleep.
3. **Voice → always Haiku** (B11/B12). Opus produces *content*; Haiku produces *phrasing*.
4. **Summaries → Haiku** (B9). Never wake Opus on a raw transcript — compress first (§7).
5. **Work → the capability table** (§2.2). Sonnet by default; Opus only when the *node* needs it,
   independent of the fact that the *brain* is Opus.

---

## 3. "Opus is judgment, not the clock" — the stateless call

### 3.1 No standing session ([open-questions D1])

The brain is **orchestration code (TS/bun) that invokes Opus per decision**, not a pinned Opus chat.
Each Opus call is a fresh `claude -p` subprocess that:
- starts cold (no prior turns),
- receives **everything it needs** assembled by the orchestrator (persona + memory + state + the one
  question),
- emits **one** `--json-schema`-validated decision,
- and exits.

Continuity — Beckett's sense of *who it is and what's going on* — lives in **SQLite + Memory**
([Spec 08]/[Spec 09]) and is **re-injected on every call**. This is what keeps the expensive head
asleep between looks while still feeling like one coherent coworker.

```ts
// The brain is this, repeated — never a long-lived Opus handle:
async function decide<T>(role: BrainRole, q: BrainQuestion): Promise<T> {
  const ctx = assembleContext(role, q);          // §3.2 — persona + memory + state + question
  const res = await callClaude({                 // §3.3 — one-shot subprocess
    model: ctx.model, schema: ctx.schema,
    systemAppend: ctx.systemPrompt, prompt: ctx.userPrompt,
  });
  return res.structured_output as T;             // validated JSON; Opus process has already exited
}
```

### 3.2 Context-assembly pattern (what goes into every Opus call)

Every judgment call is built from the **same five layers**, in this order. This is the heart of the
"stateless but continuous" trick.

```
┌─ system prompt (via --append-system-prompt) ──────────────────────────────┐
│ 1. BASE IDENTITY   "You are Beckett's judgment. First person, you own       │
│                     your decisions. <persona summary — see §5.1>"           │
│ 2. ROLE INSTRUCTION the specific job: PLAN / drift-read / GATE / clarify    │
│                     (businesslike, precise — §5.2). Includes the output     │
│                     contract restated in prose (belt-and-suspenders w/ schema).│
│ 3. INJECTED MEMORY  relevant slice from the knowledge graph ([Spec 08]):    │
│                     people/projects/env facts + learned-worker notes        │
│                     ("Codex over-engineers data layers"). Recall query from │
│                     the task + Haiku's optional memoryQuery (§1.3).          │
└────────────────────────────────────────────────────────────────────────────┘
┌─ user prompt (the -p positional / stdin) ─────────────────────────────────┐
│ 4. TASK STATE       the machine-readable situation: the task text, the DAG  │
│                     so far, node states, WorkerCounters/criteria/envelope   │
│                     ([Spec 03]), the relevant transcript SLICE (not the     │
│                     whole thing — §7), prior assumptions.                    │
│ 5. THE QUESTION     the single decision being asked, e.g. "W3 tripped       │
│                     over_envelope + no_diff_progress. Decide."              │
└────────────────────────────────────────────────────────────────────────────┘
```

```ts
interface BrainContext {
  model: string;                 // §2 routing
  effort: Effort;                // §2 routing (⚠️ flag vs tier — §2.2)
  schema: JSONSchema;            // §4 the role's output contract
  systemPrompt: string;          // layers 1–3 (persona + role + memory)
  userPrompt: string;            // layers 4–5 (state + question)
}

function assembleContext(role: BrainRole, q: BrainQuestion): BrainContext {
  const persona  = loadPersona();                       // §5.1, cached
  const memory   = memory.recall(q.recallQuery, role);  // [Spec 08] — relevant slice only (§7)
  const roleTmpl = ROLE_PROMPTS[role];                  // §5.2
  return {
    model:  routeModel(role),                           // §2
    effort: routeEffort(role),
    schema: ROLE_SCHEMAS[role],                         // §4
    systemPrompt: [persona.base, roleTmpl.system, memory.asMarkdown()].join("\n\n---\n\n"),
    userPrompt:   roleTmpl.renderUser(q.state, q.question),
  };
}
```

> **Persona in judgment calls is *thin*.** Layer 1 gets a one-paragraph persona *summary* so Opus
> stays in character for its `reason` field, but the role instruction (layer 2) is businesslike and
> dominates. The full quippy persona is applied later by Haiku (§8) when the decision is *spoken*. We
> do not want Opus being quippy *while planning a DAG*.

### 3.3 Exact `claude -p` invocation for a brain call

One-shot, non-streaming, schema-validated. Brain calls need **no tools** (pure reasoning over injected
context), so tools are denied and turns capped at 1.

```bash
claude -p "$USER_PROMPT" \
  --model claude-opus-4-8 \
  --output-format json \
  --json-schema "$SCHEMA_JSON" \
  --append-system-prompt "$SYSTEM_PROMPT" \
  --max-turns 1 \
  --disallowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch" \
  --permission-mode dontAsk
# ⚠️ effort: when a real --effort flag is verified on loom-desk, add `--effort high`.
#    Until then, effort = model tier (claude-opus-4-8 vs claude-sonnet-4-5) + a reasoning
#    instruction in $SYSTEM_PROMPT. See Spec 02 §7.1.
```

Read the result:
```bash
#   .structured_output  → the validated decision object (NOT .result, which is free text)
#   .subtype === "success"        → use it
#   .subtype === "error_max_structured_output_retries" → schema never satisfied → §3.4 fallback
```

Notes:
- **No `--bare`.** `--bare` skips keychain/OAuth and requires `ANTHROPIC_API_KEY` ([claude-headless
  §0]); Beckett runs on the **subscription** login in `~/.claude` ([Spec 00 secrets]), so brain calls
  run *non-bare* and rely on persisted subscription auth. We pass context explicitly anyway (CLAUDE.md
  auto-discovery is irrelevant — the prompt is self-contained).
- **`--output-format json`** (not `stream-json`): brain decisions are one-shot; we want the single
  final object with `structured_output`. (Streaming is for *workers*, [Spec 02].)
- **Idempotent + retryable.** A stateless call is safe to retry on transient failure ([Spec 01
  failure table]); just re-run it. No session to corrupt.

### 3.4 When a brain call fails

Per the no-silent-failure principle ([Spec 00 retry/escalate]):
- **Transient** (`error_during_execution`, network) → retry with backoff (≤3), it's stateless.
- **Schema never satisfied** (`error_max_structured_output_retries`) → re-issue once with the schema
  restated more forcefully in the system prompt; if it still fails, **degrade gracefully per role**:
  drift-read → `{action:"continue"}` + a short check-in (never abort a worker on a brain glitch);
  PLAN/GATE → **pause the task and escalate** to Discord ("I can't reach my planning step right now")
  rather than dispatch/gate blind ([Spec 01 failure table]).
- **Rate-limited** → §7.4 (failover / queue+backoff).

---

## 4. Structured decision schemas (per brain role)

Each Opus/Haiku role emits exactly one schema-validated object. JSON Schema is the literal
`--json-schema` payload; the TS interface is the consumer shape.

### 4.1 Front door — `HaikuClassification` (B0)

Defined in **§1.3**.

### 4.2 CLARIFY — `ClarifyOutput` (B3)

Encodes the proceed-on-reversible / ask-once-on-irreversible bias ([Spec 00 clarify-bias], [Spec 04
T2/T3]).

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["needsClarify"],
  "properties": {
    "needsClarify": { "type": "boolean" },
    "question":     { "type": "string",
                      "description": "required iff needsClarify; ONE crisp question about the irreversible/consequential ambiguity" },
    "assumptions":  { "type": "array", "items": { "type": "string" },
                      "description": "iff proceeding: the reversible assumptions to report at delivery" },
    "pushback":     { "type": "string",
                      "description": "optional: standing-to-push-back (Spec 00 pillar 3) — 'this spec contradicts itself: …'" }
  }
}
```
```ts
interface ClarifyOutput {
  needsClarify: boolean;
  question?:    string;        // ⇒ Discord ONE question (Spec 05), task → CLARIFY
  assumptions?: string[];      // ⇒ proceed to PLAN, surface at delivery
  pushback?:    string;        // ⇒ may route to ESCALATED (Spec 04 T6/T10)
}
```
Cross-field: `needsClarify===true` ⇒ `question` non-empty. `pushback` present ⇒ orchestrator may
escalate instead of plan ([Spec 04 T10]).

### 4.3 PLAN — `PlanOutput` (B4) — the DAG + criteria + staffing + check-ins

The canonical plan object. Full prompt treatment in **§6**.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "nodes"],
  "properties": {
    "summary": { "type": "string", "minLength": 1,
                 "description": "the one-line read already acked, refined; first person" },
    "scopeNote": { "type": "string",
                   "description": "optional big-swing resource note for the ack (Spec 04 plan-gate): 'another team + ~2h'" },
    "nodes": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "intent", "dependsOn", "scopePaths", "criteria", "suggestedWorker", "envelope"],
        "properties": {
          "id":        { "type": "string", "description": "stable node id, e.g. 'n1'" },
          "title":     { "type": "string", "minLength": 1 },
          "intent":    { "type": "string", "minLength": 1,
                         "description": "what this node must accomplish — becomes the worker's task brief" },
          "dependsOn": { "type": "array", "items": { "type": "string" },
                         "description": "node ids that must complete first; [] = root (parallelizable)" },
          "scopePaths":{ "type": "array", "items": { "type": "string" }, "minItems": 1,
                         "description": "owned path globs (the worktree write boundary, Spec 02 hook)" },
          "network":   { "type": "boolean", "description": "node needs network (npm/git push); default false (Spec 00)" },
          "criteria": {
            "type": "object", "additionalProperties": false,
            "required": ["checks", "nl"],
            "properties": {
              "checks": { "type": "array", "items": { "type": "string" },
                          "description": "executable commands; exit 0 = pass (tests/build/lint) — Spec 11" },
              "nl":     { "type": "array", "items": { "type": "string" }, "minItems": 1,
                          "description": "natural-language criteria for the reviewer — Spec 11" }
            }
          },
          "suggestedWorker": {
            "type": "object", "additionalProperties": false,
            "required": ["harness", "model", "effort"],
            "properties": {
              "harness": { "enum": ["claude", "codex"] },
              "model":   { "type": "string", "description": "e.g. claude-sonnet-4-5 / claude-opus-4-8 / gpt-5.1-codex" },
              "effort":  { "enum": ["low", "medium", "high", "xhigh"] },
              "rationale": { "type": "string", "description": "why this worker fits (feeds learned model, Spec 09)" }
            }
          },
          "reviewTier": { "enum": ["self", "fresh"], "description": "self for simple, fresh adversarial for critical (Spec 11)" },
          "envelope": {
            "type": "object", "additionalProperties": false,
            "required": ["turnTarget", "wallClockSecs"],
            "properties": {
              "turnTarget":    { "type": "integer", "minimum": 1 },
              "wallClockSecs": { "type": "integer", "minimum": 1 }
            }
          },
          "initialCheckIn": {
            "type": "object", "additionalProperties": false,
            "required": ["reason"],
            "properties": {
              "afterTurns": { "type": "integer", "minimum": 1 },
              "afterSecs":  { "type": "integer", "minimum": 1 },
              "reason":     { "type": "string", "minLength": 1, "description": "note to future-self (Spec 03 §3)" }
            }
          }
        }
      }
    }
  }
}
```

The orchestrator validates the DAG is **acyclic** and **every node has criteria** before STAFF ([Spec
04 T9]); a self-contradicting/undecomposable spec yields `nodes: []` + a `pushback`-style escalate
([Spec 04 T10]). `suggestedWorker` is PLAN's *proposal*; STAFF (§4.4) confirms or overrides it against
the capability table. `initialCheckIn` is fed straight into `scheduler.schedule()` ([Spec 03 §3.3]) at
dispatch.

### 4.4 STAFF — `StaffOutput` (B5)

STAFF reconciles PLAN's `suggestedWorker` against the **capability table** ([Spec 09]) + learned
outcomes. **v0: STAFF is fused into the PLAN call** — Opus emits `suggestedWorker` per node and the
orchestrator accepts it directly (no separate call). STAFF **splits into its own call** when the
learned capability model is live ([Spec 00 learned-model "design-for, build-later"]), so adaptive
staffing can override the planner with real `(harness, model, task_type)` stats.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["assignments"],
  "properties": {
    "assignments": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["nodeId", "harness", "model", "effort"],
        "properties": {
          "nodeId":  { "type": "string" },
          "harness": { "enum": ["claude", "codex"] },
          "model":   { "type": "string" },
          "effort":  { "enum": ["low", "medium", "high", "xhigh"] },
          "overrodePlan": { "type": "boolean", "description": "true if this differs from PLAN's suggestion" },
          "rationale":    { "type": "string" }
        }
      }
    }
  }
}
```
```ts
interface StaffOutput { assignments: WorkerAssignment[]; }
interface WorkerAssignment {
  nodeId: string; harness: 'claude'|'codex'; model: string;
  effort: 'low'|'medium'|'high'|'xhigh'; overrodePlan?: boolean; rationale?: string;
}
```

### 4.5 SUPERVISE drift-read — `SuperviseDecision` (B6/B10)

**Owned by [Spec 03 §4.3]** — this spec does not redefine it. The brain's job here: take the
`WorkerSummary` (B9) + counters + criteria + the firing alarm(s)/check-in, assemble per §3.2, and emit
the Spec 03 `SuperviseDecision` (`continue|nudge|pause|abort|reschedule` + `reason` + optional
`nextCheckIn`/`escalate`). The `--json-schema` payload is **literally Spec 03 §4.3's JSON Schema**.
Self-halt (B10) is the same schema with `escalate.severity:"needs_input"` ("bigger than scoped —
continue?").

### 4.6 GATE — `GateVerdict` (B7)

**Semantics owned by [Spec 11]** ⚠️ (not yet written). The brain contract: GATE = executable checks
passed (mechanical, run by the orchestrator) **AND** review confirms NL criteria ([Spec 00 GATE]).
Provisional schema (reconcile when [Spec 11] lands):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "reason"],
  "properties": {
    "verdict": { "enum": ["pass", "fail"] },
    "reason":  { "type": "string", "minLength": 1, "description": "first person; logged + may surface" },
    "unmetCriteria": { "type": "array", "items": { "type": "string" },
                       "description": "iff fail: which NL/exec criteria failed → feedback for re-dispatch (Spec 11)" },
    "feedback":      { "type": "string", "description": "iff fail: the steering note for the retry worker" },
    "escalate":      { "type": "boolean", "description": "iff retries exhausted (≤3) → options to Jason (Spec 04/11)" }
  }
}
```

### 4.7 Voice roles — `delivery` / `escalation` (B11/B12)

Free text (no schema needed — it's prose for Discord). Haiku takes the structured upstream object
(GATE result, Opus `reason`, clarify `question`) + persona and returns the message string. Templates
in §8.

---

## 5. Prompt architecture

### 5.1 `persona.md` — loading & application

`~/.beckett/persona.md` ([Spec 00 §5], [open-questions persona]) defines the voice: *chill, quippy,
young, energetic-but-relaxed, talks like Jason — casual, lowercase-friendly, dry wit.* Loaded once at
daemon start, cached, hot-reloadable on file change.

```ts
interface Persona {
  base:    string;   // a ONE-paragraph summary injected into Opus layer-1 (thin — §3.2)
  full:    string;   // the complete voice guide injected into Haiku user-facing calls (B0/B1/B11/B12)
  examples: string[];// few-shot voice samples (§8) appended to Haiku voice calls
}
function loadPersona(): Persona { /* parse persona.md frontmatter + body, cache by mtime */ }
```

**Application rule (the invariant):**

| Call type | Persona applied? | Which slice |
|---|---|---|
| Haiku user-facing (B0 ack, B1 chatter, B11 delivery, B12 escalation) | **yes, fully** | `persona.full` + `persona.examples` |
| Opus judgment (B3–B8, B10) | **thin only** | `persona.base` (one paragraph, for the `reason` field) |
| Worker/reviewer/summary prompts (Spec 02; B9) | **no** | businesslike — [Spec 02 §4.3] worker persona is plain |

> Why: persona is a *delivery* property, not a *reasoning* property. A quippy DAG planner makes worse
> DAGs; a businesslike worker writes better code. The voice belongs at the Discord surface only.

### 5.2 Role-instruction templates (the businesslike layer-2)

Stored as TS template strings keyed by role (`ROLE_PROMPTS`). Each restates the output contract in
prose (belt-and-suspenders with the `--json-schema`) and the role's decision principles. Two real ones:

**`drift-read` system (layer 2):**
```
You are Beckett's judgment, looking at ONE worker because a signal fired. You decide one thing:
continue / nudge / pause / abort / reschedule. Principles:
- A fired alarm is a PROMPT TO THINK, never a verdict. Do not cheap-stop good work (Spec 03 §7).
- High turns + zero diff can be legitimate mapping before a big atomic edit. Look for a coherent plan
  and signals of progress before judging it stuck.
- Prefer the lightest intervention that works: a nudge over a pause, a reschedule over an abort.
- If unsure whether it's drift or a big legit plan, reschedule a check-in and look again.
- ALWAYS give a first-person `reason` you'd stand behind. You own this call.
Output ONLY the SuperviseDecision JSON.
```

**`plan` system (layer 2):** see §6.

### 5.3 Real template — intake ack (Haiku, B0)

The instant receipt. Persona-full applied. The ack is honest — a receipt, not a promise ([Spec 00 INTAKE]).

```
[system: persona.full + persona.examples]
You are Beckett answering an @beckett mention in Discord. Read it and produce the
HaikuClassification JSON. The `ack` is your INSTANT one-line reply in your own voice — for a real
task it's an honest one-line read of what you're about to do (a receipt, not a promise; no progress
spam later — sparseness is law, Spec 00). If you can fully + safely handle it now, also fill `answer`
and set escalate=false. If it needs planning, gating, conflict-resolution, or an irreversible commit,
set escalate=true with the right escalateRole — but STILL write a warm ack first.

[user: the raw mention text + channel + author + any quoted message]
```

Example output (task → escalates to plan, but acks instantly):
```json
{ "kind":"task", "withinPurview":false, "escalate":true, "escalateRole":"plan",
  "ack":"on it — gonna branch off main and wire JWT into the auth layer, keeping the old cookie path working. back in a bit." }
```

---

## 6. The PLAN prompt in depth (B4 — the most important Opus call)

PLAN is where judgment compounds: a bad DAG wastes every downstream worker. It is **Opus, effort
high**, and it must produce, in one shot, the *entire executable plan* — the `PlanOutput` of §4.3.

### 6.1 What PLAN must emit (the four products)

1. **The DAG** — nodes + `dependsOn` edges. Parallel where independent, sequenced where dependent
   ([Spec 00 glossary]). Non-overlapping `scopePaths` per node (the worktree contract, [Spec 02]).
2. **Per-node acceptance criteria** — `checks` (executable: tests/build/lint exit codes) **and** `nl`
   (for the reviewer). **Mandatory** — no node without a "done" ([Spec 00 criteria]). This is what
   GATE checks against, so it's written *now*, at plan time ([Spec 00 PLAN]).
3. **Worker staffing** — `suggestedWorker` per node `(harness, model, effort)` from the capability
   table, with rationale. Granularity scales **inversely** with worker strength ([Spec 00 STAFF]):
   stronger workers get coarser nodes.
4. **Initial check-ins** — `initialCheckIn` per node: Opus scheduling its own first look ("by +6 turns
   edits should be landing across the 14 sites"). Fed to the scheduler at dispatch ([Spec 03 §3]).

### 6.2 The PLAN system prompt (layer 2, businesslike)

```
You are Beckett's planner. Decompose this task into the SMALLEST DAG that gets it done well — not the
most nodes, the RIGHT nodes. For each node emit: a scoped intent, non-overlapping owned path globs,
acceptance criteria (executable checks + natural-language), a suggested worker, a resource envelope,
and an initial self-check-in. Rules:

- CRITERIA ARE MANDATORY. Every node needs a machine-checkable "done" (a command that exits 0) AND
  natural-language criteria a fresh reviewer could judge. If you can't state "done," the node is wrong.
- SCOPE IS A CONTRACT. Path globs must NOT overlap between concurrent nodes — each runs in its own
  worktree and may only write its own paths. Overlap = a merge conflict you're choosing now.
- STAFF BY FITNESS, NOT HABIT. Default to the Sonnet workhorse. Reserve Opus workers for genuinely
  ambiguous / architecture-critical nodes. Use Codex per the capability notes in memory. Coarser nodes
  for stronger workers; finer nodes for weaker ones.
- ENVELOPES ARE ESTIMATES, NOT CAPS. turnTarget/wallClockSecs are what you EXPECT; the supervisor uses
  them as a prompt-to-look at ~1.5x, never a kill switch (Spec 03).
- CHECK IN ON YOURSELF. For any node that'll take real work, schedule an initialCheckIn describing what
  SHOULD be true by then ("edits landing across the 14 sites; if diff is still 0 it IS stuck").
- DEPENDENCIES: depend only on what truly must come first. Maximize the parallel frontier.
- If the task self-contradicts or can't be decomposed, emit nodes:[] and say why (you have standing to
  refuse a bad plan — Spec 00 pillar 3).

Memory below carries learned-worker notes (e.g. "Codex over-engineers data layers") and project/env
facts — USE THEM when staffing and scoping. Output ONLY the PlanOutput JSON.
```

(Layer 1 = `persona.base`; layer 3 = injected memory slice; layer 4/5 = the task text + any clarify
assumptions + repo/env facts. Assembled per §3.2.)

### 6.3 PLAN invocation

```bash
claude -p "$TASK_AND_STATE" \
  --model claude-opus-4-8 \
  --output-format json \
  --json-schema "$PLAN_SCHEMA" \
  --append-system-prompt "$PERSONA_BASE\n\n---\n\n$PLAN_SYSTEM\n\n---\n\n$MEMORY_SLICE" \
  --max-turns 1 \
  --disallowedTools "Bash,Edit,Write,Read,Glob,Grep" \
  --permission-mode dontAsk
# ⚠️ add `--effort high` once the flag is verified (Spec 02 §7.1); until then effort = Opus tier + the
#    "think hard about the decomposition" framing already in $PLAN_SYSTEM.
```

> **Should PLAN have repo-read tools?** v0: **no** — PLAN reasons over the task + injected memory/env
> facts + (optionally) a pre-computed repo digest in the user prompt, keeping it a clean stateless
> one-shot. ⚠️ If real plans need to *explore* the repo before decomposing, a future variant grants
> PLAN read-only tools (`Read,Glob,Grep`, `--permission-mode plan`) and lifts `--max-turns` — at the
> cost of a slower, multi-turn Opus call. Defer until v0 plans prove too blind. (Flagged in §10.)

---

## 7. Cost / attention discipline (rate limits + attention, no dollars)

[Spec 00 §1] reframed the cost principle for subscriptions: **no dollar budget**; the scarce resources
are **rate limits + wall-clock + attention**. The brain's job is to keep the expensive head asleep.

### 7.1 Haiku is the shock absorber
Every mention, every summary, every voice message is Haiku. Opus is reached **only** for the six
judgment roles (B3–B8) and self-halt (B10). In a typical task Opus is woken a small, bounded number of
times: once for clarify (maybe), once for plan(+staff), a handful of drift-reads (most ending
`continue`), once per gate. Everything else is Haiku or mechanical.

### 7.2 Never wake Opus on raw metrics or raw transcripts
- A smoke-alarm is a *counter predicate* ([Spec 03 §2]) — pure TS, no model.
- The look pipeline inserts a **Haiku cheap summary** (B9) *before* Opus ([Spec 03 §4.1]): Opus reads
  a 6-field `WorkerSummary`, not 3 turns of JSONL. Opus pulls the raw slice **only** when the summary
  is insufficient ([Spec 03 §4.2]). This is the single biggest attention lever.
- Counters/metrics never directly trigger an Opus call; they trigger a *look*, which is summarized
  first.

### 7.3 Batching & coalescing
- **Coalesce alarms** per worker into one look ([Spec 03 §2.3]) → one summary, one Opus read.
- **Debounce/cooldown** per-kind ([Spec 03 §2.3]) so a flapping worker can't alarm-storm Opus.
- **Check-in supersession** — one pending check-in per worker; a new one supersedes the old ([Spec 03
  §3.3]) so looks never pile up.
- **Fuse PLAN+STAFF** in v0 (§4.4) — one Opus call instead of two.
- ⚠️ **Look concurrency cap** — many workers alarming at once could fan out concurrent Opus looks;
  share the worker concurrency cap ([Spec 01], [Spec 03 §9]) for looks too.

### 7.4 Respecting subscription rate limits ([Spec 00 rate-limits], [Spec 01 failover])
Brain calls draw on the same Claude subscription as Claude workers. When a brain call hits a cap:
- **Workers** failover to the other harness ([Spec 00]). The **brain (Haiku/Opus) is Claude-only** —
  there's no Codex equivalent for `--json-schema` judgment in v1 — so a brain rate-limit means
  **queue + backoff** the decision (it's stateless, safe to defer), not failover. Workers already
  running keep running under read-only SUPERVISE ([Spec 01 failure table]).
- Notify Jason **only if blocked a meaningfully long time** ([Spec 00 rate-limits]); brief backoff is
  silent. v0 is Claude-only, so v0 brain behavior = queue+backoff.
- Drift-reads degrade safely under pressure: a deferred drift-read defaults to `continue` + a short
  check-in rather than blocking the worker (§3.4).

### 7.5 Context reuse / caching
- **Persona cached** in memory (mtime-invalidated); never re-read from disk per call.
- **Memory recall** returns only the *relevant* slice ([Spec 08]), not the whole graph — smaller
  prompts, faster calls, less rate-limit pressure.
- **Prompt-cache friendliness** ⚠️: persona+role layers (1–2) are stable prefixes across calls of the
  same role; ordering them first (§3.2) lets Claude's prompt cache (`cache_read_input_tokens`,
  [claude-headless §6]) hit on the static prefix while only state/question (layers 4–5) vary. (Cache
  is a latency/throughput win on subscriptions, not a dollar win.)

---

## 8. Persona application — Beckett's voice (user-facing only)

Per §5.1, persona is applied **only** to Haiku user-facing calls (B0/B1/B11/B12). The content always
originates upstream (Haiku's own answer, or Opus's `reason`/`question`/gated result); persona governs
*phrasing*, never *substance* — Beckett never quips away a real caveat.

### 8.1 Delivery (B11) — Opus gated `pass` → Haiku speaks it

Input: GATE `GateVerdict{verdict:"pass", reason}` + the artifact (PR url) + assumptions from CLARIFY +
known limits. Persona-full applied. The delivery carries the **handshake** for any irreversible step
([Spec 00 DELIVER], [Spec 07]).

> **PR's up** — JWT auth's wired in, old session-cookie path still works so nothing breaks on
> rollout. one assumption: i kept the 24h token expiry from the old config, lmk if you want it shorter.
> tests green. want to eyeball it yourself or should i merge it to main?

### 8.2 "I'm stuck" (B12) — Opus self-halt/escalation → Haiku speaks it

Input: `SuperviseDecision{escalate:{severity:"needs_input", question}}` or a retries-exhausted GATE.
First-person, owns it, gives options ([Spec 00 §2 pillar 4], [Spec 04 §6]).

> heads up — this is bigger than i scoped. the migration touches 3 services i didn't expect, so it's
> another worker + maybe 2 hours. i can keep going, or we cut it to just the user-service for now and
> circle back. your call.

### 8.3 Intake ack (B0) — instant receipt

(Schema in §1.3; example in §5.3.) The vibe: warm, honest, one line, no promise of constant updates.

> on it — digging into why the build's flaky. if it's the test ordering thing again i'll just fix it,
> otherwise i'll come back with what i find.

> ⚠️ **Voice calibration is empirical.** These are first-draft samples; the real `persona.md` +
> few-shot `examples` get tuned against Jason's actual Discord voice. Tone that's too cute risks
> burying real caveats — the delivery (8.1) deliberately keeps the assumption + the handshake plain.

---

## 9. Configuration (`~/.beckett/config.toml`)

Extends the canonical `[models]` block ([Spec 01 §config]). Brain-specific tunables:

```toml
[models]
# Brain routing (model ids — Spec 01 owns these; restated for completeness)
front_door   = "claude-haiku-4-5"   # B0/B1/B2/B9/B11/B12 — intake, chatter, summary, voice
judgment     = "claude-opus-4-8"    # B3–B8, B10 — clarify, plan, staff, drift-read, gate, integrate, self-halt
reviewer     = "claude-opus-4-8"    # fresh adversarial reviewer (Spec 11)
worker_default = "claude-sonnet-4-5"# STAFF default worker (Spec 02/09)

[brain]
# effort routing (⚠️ realized via model tier until --effort verified — §2.2 / Spec 02 §7.1)
plan_effort        = "high"
gate_effort        = "high"
clarify_effort     = "medium"
drift_effort       = "medium"
staff_effort       = "medium"
fuse_plan_staff    = true     # v0: emit suggestedWorker in PLAN, skip the separate STAFF call (§4.4)
plan_gets_tools    = false    # v0: PLAN is a blind one-shot over injected context (§6.3) ⚠️
escalate_conservative = true  # Haiku errs toward escalation on doubt (§1.2)
brain_retry_max    = 3        # stateless brain-call retries on transient failure (§3.4)
persona_thin_in_opus = true   # persona.base only in Opus calls; persona.full only in Haiku voice (§5.1)
```

---

## 10. Open gaps ⚠️

- **⚠️ `claude --effort` unverified** ([Spec 02 §7.1]). The §2 effort column + §9 `[brain]` efforts
  are *intent*; until the flag is confirmed on loom-desk, brain effort = model tier + reasoning
  framing. Wire `--effort` into §3.3/§6.3 invocations once verified.
- **⚠️ Specs 08/09/11 not yet written.** Memory-injection contract (§3.2), the capability-table data
  STAFF consumes (§4.4), and the GATE verdict semantics (§4.6) are the *consumer* side — reconcile
  when those land. `GateVerdict` (§4.6) is provisional.
- **⚠️ PLAN blindness** (§6.3). v0 PLAN can't explore the repo (one-shot, no tools). If plans are too
  blind, grant read-only tools + multi-turn — at a latency/rate-limit cost. Needs a real-task call.
- **⚠️ Haiku planning ambition.** The conservative-escalation bias (§1.2) is a guess; if Haiku
  over-escalates trivial tasks (waking Opus needlessly) or under-escalates (mis-handling real work),
  tune the front-door prompt + add a "Haiku confidence" field. No real-traffic calibration yet.
- **⚠️ Brain has no failover.** Judgment is Claude-only (§7.4); a sustained Claude cap stalls *all*
  judgment (plan/gate), not just one worker. A Codex-backed `--json-schema` judgment path (or a local
  fallback model) is a post-v1 resilience upgrade.
- **⚠️ Prompt-cache assumptions** (§7.5) depend on Claude's cache keying on the static prefix; unverified
  for `claude -p` one-shots across separate subprocess invocations — measure before relying on it.
- **⚠️ Voice/substance bleed** (§8). Persona must never soften a real caveat or handshake; needs a
  delivery-prompt guard ("never omit assumptions or the merge/send question") and review of real outputs.

---

## 11. Cross-links

- **[Spec 00 — Overview & Canon](./00-overview.md)** — cost principle, hybrid-brain decision, persona, economics (no $).
- **[Spec 01 — Architecture](./01-architecture.md)** — the `[models]` config block, Brain components (Haiku/Opus), scheduler, failure table.
- **[Spec 02 — Worker Abstraction](./02-worker-abstraction.md)** — worker spawn, `--append-system-prompt`, `--effort`/`-c model_reasoning_effort`, businesslike worker persona.
- **[Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md)** — the `Look` pipeline, `WorkerSummary` (B9), `SuperviseDecision` (B6) schema, check-ins.
- **[Spec 04 — State Machine](./04-state-machine.md)** — INTAKE/CLARIFY/PLAN/STAFF/GATE transitions, escalation routing, integration worker.
- **[Spec 05 — Discord Interface](./05-discord-interface.md)** ⚠️ — how acks/deliveries/escalations (B0/B11/B12) post; sparseness.
- **[Spec 07 — Identity & Agency](./07-identity-agency.md)** ⚠️ — delivery handshake (merge/send), email triage (B13).
- **[Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md)** ⚠️ — recall/injection (§3.2 layer 3), learned-worker notes for PLAN/STAFF.
- **[Spec 09 — Persistence & Data Model](./09-persistence-data-model.md)** ⚠️ — capability table (STAFF), outcome logging feeding the learned model.
- **[Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md)** ⚠️ — `GateVerdict` semantics, criteria format, fresh-reviewer call, retry/escalate.
