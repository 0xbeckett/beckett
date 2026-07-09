# Design doc: model cast presets + cost/intelligence routing

**Ticket:** OPS-109 (design) → **OPS-110 (build, shipped)**
**Author:** Beckett (worker)
**Date:** 2026-07-09
**Status:** **Shipped** in OPS-110. §§1–4 (the roster + the vocabulary of presets) still stand.
The invocation actually built differs from the §5 proposal in a few deliberate ways — see the
**Shipped** section at the very bottom for the authoritative usage. Where the two disagree, the
Shipped section wins.

---

## 0. TL;DR

Today every ticket carries a hand-written `--cast` JSON. That's flexible but it means the same
half-dozen good combinations get re-typed (and occasionally mis-typed) on every ticket, and it
puts the whole cost/intelligence trade in my head each time instead of in a named, reviewable
list. This doc proposes **named cast presets** — a small vocabulary of vetted harness/model/effort
combos, each mapped to the exact `--cast` JSON it expands to, invoked as
`beckett ticket create --preset <name>` and overridable per-stage.

The point is to **cast at the intelligence a ticket actually needs** — stop paying Opus-xhigh
money for a copy tweak, stop sending a genuinely hard concurrency fix to terra-medium and eating
a bounce. Presets make the right cast the cheap default and the wrong cast the thing you have to
opt into.

The one thing this doc treats skeptically: **gpt-5.6-terra is three weeks old** (preview end of
June 2026). Its benchmark story is good on terminal-style tasks and *unproven* on real-repo
patching, and OpenAI's own family has a documented long-context drift / over-engineering failure
mode. §2 lays that out honestly. Presets should lean on terra where it's proven and route around
it where it isn't — which is exactly what a named list lets us encode and revise.

---

## 1. Background: how casting works today

Casting is per-stage. A ticket's `--cast` is a JSON object `{ "<stage>": { "harness", "model",
"effort" } }` where `harness` is `pi` or `claude`, `model` picks the brain, and `effort` is
`low|medium|high|xhigh`. The two stages are `implement` and `review`. (Ground truth:
`src/concierge/concierge.md`, "The cast block".)

Rules that any preset has to respect:

- **Default cast** is `{"implement":{"harness":"pi","effort":"medium"}}` — terra at medium, one
  pass. Most routine backend tickets should land here.
- **Don't cast `review` for normal work.** If `review` is omitted, the dispatcher staffs
  **Sonnet 5** at an effort scaled from the implement cast. That's the correct choice for the
  common case.
- **`effort` also picks the review gate (v3.1).** `low`/`medium` → **one pass** (worker
  self-verifies, straight to done, no cold reviewer). `high`/`xhigh`/**omitted** → a **fresh
  adversarial reviewer** runs after implement. An *omitted* effort silently selects the expensive
  fresh-review tier — so presets must always name an explicit effort.
- **`reviewTier`** forces the gate independent of effort: `"self"` = one pass, `"fresh"` = always
  review. Since Opus never runs below `high`, `"reviewTier":"self"` is how visual/taste work
  stays one-pass.
- **Fable is confirm-before-cast.** Any cast that puts `claude-fable-5` in a seat requires a
  one-line human OK on channel first. A preset name does **not** bypass that handshake (see §5).
- **pi tier limits:** only `gpt-5.6-terra` (default) and `gpt-5.6-luna` are castable on `pi`. SOL
  and bare `gpt-5.6` are hard-blocked on our ChatGPT-account tier — never propose them.

---

## 2. Research: gpt-5.6-terra as an implement model (skeptical read)

terra is new. It was previewed as part of the GPT-5.6 family (**Sol / Terra / Luna**) via the
OpenAI API and Codex around **25–26 June 2026**, with a wider public launch reported for **9 July
2026** — i.e. it is roughly **two to three weeks old at the time of writing.** Access during
preview was gated to approved orgs. Treat every number below as early and partly vendor-shaped.

### 2.1 Where it genuinely shines

- **Terminal / agentic command tasks.** On **TerminalBench 2.1**, terra is reported at **84.3%**,
  which *matches Claude Fable 5* (84.3%) and edges out the prior GPT-5.5 default (**83.4%**), while
  sitting ahead of **Opus 4.8 at 78.9%**. (One outlet lists terra a point lower at **82.5%** on
  the same board — see §2.5 on variance.) TerminalBench measures driving a shell to complete
  tasks: install/build/run/fix loops, scripted infra, CLI plumbing. This is terra's home turf and
  it is genuinely near the frontier there. [1][2][6]
- **Crisp-spec code grind at ~half the price.** OpenAI positions terra as "GPT-5.5-level quality
  at ~half the cost" — $2.50/$15 per Mtok vs Sol's $5/$30. For well-specified implementation —
  APIs, data layers, parsers, business logic, scripts, migrations, test suites, module porting —
  it churns out correct code fast when the spec is sharp and the acceptance criteria are
  checkable. This matches our own operating experience of it as the pi implement default. [3][4]
- **Long-diff review for "was the asked-for thing actually done".** It grinds a big diff without
  fatigue and is strong at the blunt criteria-vs-reality check. (Internal doctrine; consistent
  with the terminal-task strength.)

### 2.2 Where it falls down

- **No eyes.** terra can't see rendered output, so visual/UI work degenerates into
  over-engineering and slow burn. This is categorical, not a tuning issue — anything judged by eye
  is the wrong ticket for it.
- **No taste on fuzzy specs.** Ambiguous or judgment-heavy specs get a literal, joyless reading.
  It implements what the words say, not what you meant.
- **Real-repo patching is unproven for the whole 5.6 line.** OpenAI has **not published a GPT-5.6
  SWE-bench (Pro) number.** On the most realistic autonomous-patch evals (patches against real OSS
  repos), **Fable 5 leads** — one report puts Fable at **29.3%** on the Diamond subset vs **13.4%**
  for Opus 4.8 and **5.7%** for GPT-5.5. terra is not separately benchmarked there, but it's a
  ~5.5-parity model, so on *this* axis it is closer to the 5.5 line than to Fable. **TerminalBench
  strength does not transfer to "correctly patch a large unfamiliar codebase."** Do not read
  terra's 84.3% as "as good as Fable at real coding." [1][7]
- **Weak reasoning-scaling.** On the hard agentic eval, the GPT-5.x line stays roughly flat (~5–6%)
  regardless of thinking effort, whereas Fable climbs from ~11.5% (low) to ~30.9% (max). Practical
  read: **turning terra up to xhigh buys much less than turning a Claude model up.** If a task
  needs deep reasoning, spend on a bigger model, not a hotter terra. [1]

### 2.3 Failure modes to watch

- **Long-context instruction drift.** The GPT-5.x family's best-known failure mode is drifting
  from earlier constraints deep into a long task — starting correctly, then contradicting an
  architectural decision made 20 steps back. 5.5/5.6 improved this but did not erase it. For us
  that means: on **long, multi-file tickets**, terra can silently violate a constraint stated in
  the body. Mitigation baked into presets: pair long terra implement with a **fresh reviewer**
  (Sonnet or, for stakes, Fable) rather than one-pass. [1][8]
- **Over-engineering / exceeding intent.** The family (documented on Sol) shows a tendency to
  exceed explicit user intent — unprompted "radical" refactors that break legacy code. terra
  inherits the disposition. On a hard-to-reverse surface, a fresh reviewer is the guard. [8]

### 2.4 Where it's the *wrong* call (summary)

Anything visual or vibe-specified; anything correctness-critical shipped one-pass without a
reviewer; anything where the spec is really a question ("make it good") rather than an
instruction; and anything betting on xhigh terra to out-think a hard problem (spend on Fable/Opus
instead). terra is a superb **spec executor**, not a **problem solver**.

### 2.5 Honesty notes on the sourcing

- **Benchmark variance is real.** terra's TerminalBench 2.1 number appears as both **84.3%** and
  **82.5%** across outlets; treat it as "low-to-mid 80s, ≈Fable, ahead of Opus 4.8." Our own
  doctrine records 84.3.
- **Vendor-shaped and young.** Much of the coding narrative traces to OpenAI's own preview framing
  and third-party recaps of it, not independent replication, and the model is ~3 weeks old. The
  *one* independently-flavored, skeptical data point — real-repo patching — is exactly the one
  where terra looks weakest. That asymmetry is why the presets below keep a reviewer on terra
  whenever stakes or length go up.

---

## 3. Cost-vs-intelligence map (every model we can cast)

Prices are $ per **million tokens (input/output)**. "Relative burn" is a rough per-ticket ordering
driven mostly by output price and whether a fresh reviewer runs — not a promise.

| Model | Harness | $/Mtok (in/out) | Rel. speed | Best-fit work | Worst-fit work |
|---|---|---|---|---|---|
| **gpt-5.6-luna** | `pi` | **$1 / $6** | Fastest | Rote/mechanical grind: bulk renames, obvious edits, boilerplate, codemods where even terra is overkill | Anything needing judgment, design, or a non-trivial decision; visual work |
| **gpt-5.6-terra** | `pi` (default) | **$2.50 / $15** | Fast | Crisp-spec backend/systems: APIs, parsers, data layers, migrations, test suites, scripts, infra; long-diff "was it done?" review | Visual/UI; fuzzy/vibe specs; unproven on real-repo patching; hard problems at xhigh (poor reasoning-scale) |
| **claude-sonnet-5** | `claude` | **$2 / $10** intro (→ **$3 / $15** after 2026-08-31) | Fast | The default **review** seat — reads a diff vs criteria excellently cheap; mechanical implement in the claude toolchain | Review gate on critical work; anything at `xhigh` (burns time, no smarter) |
| **claude-opus-4-8** | `claude` (default) | **$5 / $25** | Medium | Taste & frontend: visual, interaction, component architecture, copy, UX; judgment-heavy backend with a fuzzy spec; stronger-than-default reviewer | Rote spec-grind pi does faster/cheaper; running below `high` |
| **claude-fable-5** | `claude` | **$10 / $50** | Slowest | The heavy seat: review on correctness-critical / hard-to-reverse / `--project beckett`; implement on the rare genuinely-hard design problem (sweeping refactor, subtle concurrency, foundational API). **Leads real-repo patching evals.** | Routine implement or review; anything a cheaper seat handles — casting it is pure burn. **Confirm with the human first, always.** |

Not castable, for completeness: **Sol** and bare **gpt-5.6** are hard-blocked on our tier;
**Haiku 4.5** runs one fixed non-cast seat (ambient triage). Don't propose these.

**Intelligence-per-dollar intuition:** luna < terra ≈ sonnet < opus < fable on raw capability;
terra and sonnet are the two "cheap but real" seats and should carry the bulk of tickets. Fable is
5× Opus on output and ~3.3× terra — its price *is* the confirm-first gate.

---

## 4. Proposed named cast presets

Each preset below lists the **exact `--cast` JSON it expands to**, when to reach for it, the review
gate it implies, and a rough cost profile. Presets are ordered cheapest → most expensive.

> Cost profile legend (rough, per typical ticket): 💲 = luna/one-pass territory · 💲💲 =
> terra/sonnet one-pass · 💲💲💲 = a cheap seat + a fresh cheap reviewer, or Opus one-pass · 💲💲💲💲
> = Opus/Fable in a seat · 💲💲💲💲💲 = Fable implement **and** review. The gate matters as much as the
> seat: a fresh reviewer roughly doubles the token bill.

### 4.1 `cheap-lane` — mechanical grind
```json
{"implement":{"harness":"pi","model":"gpt-5.6-luna","effort":"low"}}
```
- **When:** rote renames, obvious mechanical edits, bulk boilerplate, mechanical codemods — work
  with zero judgment where even terra is more than the task needs.
- **Gate:** one pass (low effort). No cold reviewer.
- **Cost:** 💲 — the floor. Cheapest seat, one pass.

### 4.2 `backend` — the default (a.k.a. terra-work)
```json
{"implement":{"harness":"pi","effort":"medium"}}
```
- **When:** the everyday backend/systems ticket with a **really specific** spec and checkable
  criteria. This is the house default; most tickets should land here.
- **Gate:** one pass (medium effort). Worker self-verifies.
- **Cost:** 💲💲 — terra at medium, no reviewer. Best intelligence-per-dollar for spec-grind.

### 4.3 `backend-hard` — spec leaves decisions
```json
{"implement":{"harness":"pi","effort":"high"}}
```
- **When:** backend/systems where terra has to make real decisions the spec didn't pin down, but
  the work isn't visual or hard-to-reverse.
- **Gate:** fresh reviewer (high effort) → dispatcher staffs Sonnet 5 at scaled effort. This is
  the guard against terra's long-context drift.
- **Cost:** 💲💲💲 — terra high + a cheap fresh Sonnet reviewer.

### 4.4 `taste-lane` — frontend / visual / design
```json
{"implement":{"harness":"claude","effort":"high","reviewTier":"self"}}
```
- **When:** anything judged by eye — UI, canvas/animation, landing pages, layout, copy, "make it
  look like X." Opus 4.8 implements; **explicit `reviewTier:"self"`** keeps it one-pass (a cold
  code reviewer can't judge pixels anyway).
- **Gate:** one pass, forced via `reviewTier` (Opus never runs below `high`, which would otherwise
  trip the fresh gate).
- **Cost:** 💲💲💲💲 — Opus in the seat, but one pass keeps it from doubling.

### 4.5 `judgment` — fuzzy spec, non-visual
```json
{"implement":{"harness":"claude","effort":"high"}}
```
- **When:** judgment-heavy backend where the spec is really a question and the worker must decide
  what "good" means (API ergonomics, refactors, doctrine/persona/skills). No pixels.
- **Gate:** fresh reviewer (high effort) → Sonnet 5 at scaled effort.
- **Cost:** 💲💲💲💲 — Opus high + a fresh Sonnet reviewer.

### 4.6 `long-haul` — long ticket, risk is *missing work*
```json
{"implement":{"harness":"pi","effort":"high"},
 "review":{"harness":"pi","effort":"high"}}
```
- **When:** a big, multi-file ticket where the main risk isn't subtle wrongness but **silently
  skipped acceptance criteria**. terra implements; a second **terra** review does the blunt
  criteria-vs-reality sweep it's strong at, without reviewer fatigue.
- **Gate:** explicit pi `review` stage (fresh, by construction).
- **Cost:** 💲💲💲 — two terra passes; still cheaper than putting a claude seat on either end.

### 4.7 `fable-review+terra-work` — critical, cost-aware ⚠️ confirm first
```json
{"implement":{"harness":"pi","effort":"high"},
 "review":{"harness":"claude","model":"claude-fable-5","effort":"high"}}
```
- **When:** the work itself is well-specified enough for terra to *implement* cheaply, but it's
  **correctness-critical or hard-to-reverse** — auth, money, data migrations, shared interfaces —
  so the *review* gate needs the heaviest seat. terra does the grind; Fable adjudicates.
- **Gate:** explicit Fable `review`. **Requires a one-line human OK on channel before filing**
  (§5). The preset name does not waive this.
- **Cost:** 💲💲💲💲 — terra implement is cheap, but Fable review at $50/Mtok output dominates the bill.

### 4.8 `critical` — hard-to-reverse *and* hard-to-get-right ⚠️ confirm first
```json
{"implement":{"harness":"claude","model":"claude-fable-5","effort":"high"},
 "review":{"harness":"claude","model":"claude-fable-5","effort":"high"}}
```
- **When:** the rare genuinely-hard, high-stakes design problem — a sweeping cross-module refactor,
  a subtle concurrency fix, a foundational API surface, or core `--project beckett` work where a
  bad merge breaks me. Fable both implements and reviews. (If the *implementation* is actually
  routine and only the *stakes* are high, prefer `fable-review+terra-work` instead — don't pay for
  Fable to implement what terra can.)
- **Gate:** Fable implement + Fable review, `xhigh` only for the most crucial cases.
- **Cost:** 💲💲💲💲💲 — the ceiling. Both seats at $10/$50. **Confirm first, every time.**

### 4.9 Preset → gate → cost, at a glance

| Preset | implement | review | gate | cost |
|---|---|---|---|---|
| `cheap-lane` | luna low | — | one pass | 💲 |
| `backend` | terra medium | — | one pass | 💲💲 |
| `backend-hard` | terra high | Sonnet (auto) | fresh | 💲💲💲 |
| `long-haul` | terra high | terra high | fresh | 💲💲💲 |
| `taste-lane` | Opus high | — (`reviewTier:self`) | one pass | 💲💲💲💲 |
| `judgment` | Opus high | Sonnet (auto) | fresh | 💲💲💲💲 |
| `fable-review+terra-work` ⚠️ | terra high | **Fable** high | fresh | 💲💲💲💲 |
| `critical` ⚠️ | **Fable** high | **Fable** high | fresh | 💲💲💲💲💲 |

⚠️ = human-confirm-before-cast (any preset with Fable in a seat).

---

## 5. Proposed invocation shape (described, not built)

### 5.1 Basic form
```
beckett ticket create \
  --title "…" --project … --body "…" --criteria "…" --channel <id> \
  --preset backend \
  --state in_progress
```
`--preset <name>` looks the name up in a preset table and expands it into the full `--cast` block
before the ticket is filed. `--preset` and an explicit `--cast` are **mutually exclusive** — if
both are passed, error out rather than guess which wins.

### 5.2 Per-stage overrides (presets are a starting point, not a cage)
The doctrine is explicit that the roster is "a starting map" corrected by cost feedback, so presets
must stay overridable. Two override styles, in increasing power:

- **Scalar overrides** bump one field of one stage:
  `--preset backend --implement-effort high` → terra at high instead of medium (and thus flips the
  gate to fresh). Analogous `--review-effort`, `--implement-model`, etc.
- **JSON merge override** deep-merges a partial cast over the expanded preset:
  ```
  --preset fable-review+terra-work --cast-override '{"implement":{"effort":"xhigh"}}'
  ```
  Merge semantics: object-deep-merge per stage; a provided key replaces the preset's; unspecified
  keys keep the preset's value. This lets a preset be 90% right and get nudged the last 10%
  without re-typing the whole block.

### 5.3 Resolution order (proposed)
1. Start from `--preset` expansion (or the house default if neither `--preset` nor `--cast`).
2. Apply `--cast-override` deep-merge (if any).
3. Apply scalar overrides (if any) last, so they always win.
4. Validate the result against the caster rules (§5.4) before filing.

### 5.4 Guardrails the resolver should enforce
- **Fable confirmation is not waivable by a preset name.** If the *resolved* cast lands
  `claude-fable-5` in any seat, the tool should refuse to file with `--state in_progress` unless a
  `--fable-confirmed` flag (or equivalent) is set — the flag being the thing I only pass *after*
  the human says yes on channel. Presets `fable-review+terra-work` and `critical` therefore can't
  silently spend Fable.
- **No omitted effort.** Every stage in a resolved cast must name an explicit effort (an omitted
  one silently selects the expensive fresh-review tier). Presets already do; overrides must not
  delete it.
- **Reject blocked models.** `gpt-5.6` / `sol` in a `pi` seat → hard error (not on our tier).
- **`--list-presets`** prints the table in §4.9 with the expanded JSON, so the vocabulary is
  discoverable and self-documenting.

### 5.5 What this does *not* change
Presets are pure sugar over the existing `--cast` string — same dispatcher, same v3.1 gate logic,
same `reviewTier`. Nothing about the runtime changes; this is an authoring-ergonomics + consistency
layer. That's deliberate: it keeps the build small and the blast radius near zero.

---

## 6. Open questions for Jason

1. **Preset set — right grain?** Eight presets (§4). Too many (just ship `cheap` / `backend` /
   `taste` / `critical`)? Too few (want a `docs`/`copy` lane, or a `beckett-core` preset that
   pre-bakes the `--project beckett` + Fable-review convention)?
2. **Names.** `fable-review+terra-work` is descriptive but clunky. Prefer terse (`hardened`?
   `guarded`?) or keep self-documenting long names?
3. **Should `backend` be the *implicit* default** when neither `--preset` nor `--cast` is passed,
   replacing the raw default cast? Or keep presets strictly opt-in so nothing changes unless I ask?
4. **Fable guardrail mechanism.** Is a `--fable-confirmed` flag the right gate, or do you want the
   tool to *block outright* and force a manual `--cast` for anything Fable, so presets can never be
   the thing that spends the heavy seat?
5. **Where do presets live?** A checked-in table in the repo (versioned, reviewable, what I'd
   default to) vs. a config file I can edit without a deploy. Given the cost-feedback loop, a
   versioned table with a normal PR to change it seems right — confirm.
6. **terra trust level.** Given §2 — strong on terminal tasks, *unproven* on real-repo patching,
   with a live drift/over-engineering failure mode — are you comfortable with terra as the
   one-pass default (`backend`), or do you want terra tickets to carry a fresh reviewer until we
   have our own cost/quality data on it? (My rec below takes a middle path.)

## 7. Recommendation

**Build it, small and versioned.** Ship the eight presets in §4 as a checked-in table, invoked via
`--preset` with the override + guardrail semantics in §5. Keep presets **opt-in** at first (don't
silently repoint the implicit default) so the change is observable, and add `--list-presets` so the
vocabulary is discoverable.

On terra specifically, I'd **keep `backend` (terra medium, one pass) as the cheap default for
genuinely crisp specs**, because that's exactly the terminal-task/spec-grind sweet spot where terra
is proven — but I'd make `backend-hard` (terra + fresh Sonnet reviewer) the *reflexive* choice the
moment a ticket is long or leaves decisions, precisely because terra's one skeptic-flavored weak
spot (real-repo work) and its one live failure mode (long-context drift) both bite hardest there.
That keeps us cheap where terra is safe and reviewed where it isn't — and the telemetry footer on
every ticket gives us the cost/quality data to move the line later.

Net: presets convert the casting doctrine from "in my head each time" into a small reviewable
vocabulary, make the cost-right cast the default, and make the expensive cast something you have to
name (and, for Fable, confirm). That's the whole win. Greenlight and I'll file the build ticket.

---

## 8. Shipped (OPS-110) — authoritative usage

The build landed with **one deliberate refinement over §5**, per Jason: presets are **user-defined
flows in an external, hot-reloaded config file**, not a checked-in versioned table. You pick, say,
Fable as the reviewer and Sonnet 5 as the implementer, name it whatever you want, and reuse it by
name. These live *outside* the daemon so iterating on them needs **no rebuild and no restart**.

### 8.1 Where presets live
`~/.beckett/presets.json` — plain JSON, one object:
```json
{
  "<preset-name>": { "implement": {"harness":"…","model":"…","effort":"…"}, "review": {…} },
  "jason-review": {
    "implement": {"harness":"claude","model":"claude-sonnet-5","effort":"high"},
    "review":    {"harness":"claude","model":"claude-fable-5","effort":"high"}
  }
}
```
- **Arbitrary names**, **any stage combo** — a preset may be partial (e.g. only a `review` stage).
- The file is **read fresh on every `beckett ticket create` and `beckett plan`** — there is no cache,
  so a preset you just edited applies to the very next ticket. Editing/adding a preset = editing this
  file; nothing is compiled into the binary.
- **Missing file → auto-created**, seeded with four presets from §4: `cheap-lane`, `taste-lane`,
  `fable-review+terra-work`, `critical`. Delete the file to re-seed.
- **Validated on load** against the roster (the same cast validation the queue uses): a blocked
  model (**SOL**, bare **gpt-5.6**) or a malformed `harness`/`model`/`effort` throws a clear error
  naming the offending preset. A broken cast is never silently filed.

### 8.2 Invocation
```
beckett ticket create --title "…" --preset jason-review [--cast '{…}'] …
```
- `--preset <name>` expands that preset into the cast. An **unknown name fails loudly** and lists the
  available names.
- **Precedence — explicit `--cast` overrides the preset per stage:** for every stage the explicit
  `--cast` names, the explicit spec **replaces** the preset's for that stage; stages the `--cast`
  omits keep the preset's. So `--preset fable-review+terra-work --cast '{"implement":{"harness":"pi","effort":"xhigh"}}'`
  keeps the preset's Fable `review` and swaps in the explicit `implement`. (This supersedes §5.1's
  "mutually exclusive" — the refinement makes them compose instead.)
- The **resolved** cast is validated before filing (§8.1 rules), so an override can't sneak a blocked
  model or bad effort through.

### 8.3 Inspection
- `beckett preset ls` — every preset name + its expanded cast, plus the file path.
- `beckett preset show <name>` — one preset's expanded cast (unknown name fails loudly).

### 8.4 In `beckett plan`
A plan node may carry `"preset": "<name>"` (expanded exactly like `--preset`, with the node's `"cast"`
overriding per stage). Presets are read fresh once per plan; a malformed `presets.json` or an unknown
preset fails the **whole** plan before any node is filed.

### 8.5 Not in this build (unchanged from §5's proposal)
- No `--cast-override` deep-merge and no scalar `--implement-effort`-style flags — a per-stage `--cast`
  covers the override need. (§5.2's deeper merge can be added later if the per-stage swap proves too
  coarse.)
- **No `--fable-confirmed` guardrail flag** (§5.4). Fable-in-a-seat confirmation stays a
  human/doctrine step: the `fable-review+terra-work` and `critical` seeds carry a ⚠ note, and the
  Concierge still confirms on channel before casting Fable. Scope here was CLI + config-loading only;
  **the running daemon's behavior is unchanged** — presets are pure sugar over the existing `--cast`
  block, resolved at file time.

---

## Sources

All accessed 2026-07-09. GPT-5.6 is ~2–3 weeks old; treat coding claims as early and partly
vendor-shaped (§2.5).

1. [GPT-5.6 vs Claude Fable 5 — July 2026 Live Benchmarks (explainx.ai)](https://explainx.ai/blog/gpt-5-6-vs-claude-fable-5-comparison-2026) — TerminalBench 2.1 terra 84.3% = Fable, vs GPT-5.5 83.4%; real-repo Diamond subset Fable 29.3% / Opus 4.8 13.4% / GPT-5.5 5.7%; reasoning-scaling (Fable 11.5%→30.9%, GPT-5.x flat ~5–6%).
2. [GPT-5.6 Sol Benchmarks Deep Dive (lushbinary.com)](https://lushbinary.com/blog/gpt-5-6-sol-benchmarks-terminalbench-agentic-deep-dive/) — TerminalBench 2.1 board; Sol 88.8% (announced 2026-06-26).
3. [A preview of GPT-5.6 Sol, Terra, and Luna (OpenAI Help Center)](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-56-sol-terra-and-luna) — official family framing; Terra "strong lower-cost option," Luna "fastest / most cost-efficient"; preview via API + Codex, gated access.
4. [GPT-5.6 Pricing 2026: Sol, Terra and Luna Tiers (finout.io)](https://www.finout.io/blog/gpt-5.6-pricing-2026-sol-terra-and-luna-tiers-explained) — Sol $5/$30, Terra $2.50/$15, Luna $1/$6 per Mtok; Terra ≈ GPT-5.5 quality at ~2× cheaper.
5. [OpenAI unveils GPT-5.6 Sol, Terra and Luna (VentureBeat)](https://venturebeat.com/technology/openai-unveils-gpt-5-6-sol-terra-and-luna-models-but-only-accessible-to-limited-preview-partners-for-now-per-us-gov) — limited-preview / gated-access framing, late June 2026.
6. [Claude Sonnet 5 vs. GPT-5.6: Benchmarks, Pricing, Access (DataCamp)](https://www.datacamp.com/blog/claude-sonnet-5-vs-gpt-5-6) — TerminalBench 2.1 terra 82.5%, Opus 4.8 78.9%; "no single shared benchmark" caveat; Sonnet 5 intro $2/$10.
7. [GPT-5.6 Sol Benchmarks / SWE-bench note (aitoolsreview.co.uk)](https://aitoolsreview.co.uk/insights/gpt-5-6) — OpenAI has not published a GPT-5.6 SWE-bench Pro number; Fable retains real-coding lead.
8. [GPT-5.6 Review: Sol, Terra & Luna Architecture (ai.cc)](https://www.ai.cc/blogs/gpt-5-6-openai-sol-terra-luna/) — long-context drift history and 5.5/5.6 improvement; Sol tendency to exceed intent / unprompted "radical" refactors.
9. [Anthropic Claude API Pricing 2026 (aipricing.guru)](https://www.aipricing.guru/anthropic-pricing/) — Fable 5 $10/$50, Opus 4.8 $5/$25, Sonnet 5 $2/$10 intro → $3/$15 after 2026-08-31.
10. [GPT-5.6: Public Launch July 9 — Sol, Terra, Luna (explainx.ai)](https://explainx.ai/blog/gpt-5-6-release-date-features-benchmarks-2026) — public launch date 2026-07-09.
</content>
</invoke>
