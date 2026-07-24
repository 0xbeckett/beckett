# Design doc: INT intensive-task flow (Design → Design Review gate → Implement → Review → Done)

**Ticket:** OPS-111 (design) → **build ticket TBD (greenlight first)**
**Author:** Beckett (worker)
**Date:** 2026-07-09
**Status:** Proposal. No code in this ticket. This doc dogfoods the very flow it describes — it is
the "Design" artifact for an intensive task; Jason is the human gate.

---

## 0. TL;DR

We keep splitting heavy work into two disconnected tickets: one writes a design doc, then (after
Jason reads it and greenlights) a second builds it. The hand-off is manual, the design context is
lost across the re-file, and nothing enforces the pause. This doc folds that into **one ticket
type** with a formal design + human-approval stage up front.

The proposal, in one breath: a **new Plane board called `INT`** whose ticket lifecycle is
**Design → Review (Design) → In Progress → Review → Done** (plus backlog/cancelled). Normal quick
work stays on the existing **OPS** 3-stage flow, untouched. The dispatcher already runs a coarse
state→action machine and already polls multiple boards — INT is that same machine with **two new
INT-only states** bolted on the front, and the extra states are gated on the board so a bugfix on
OPS never grows a design column.

The load-bearing idea is **LIVE vs PARKED**, which the engine already embodies:

- **LIVE** states spawn a worker and burn tokens: `Design` (worker writes the doc), `In Progress`
  (worker implements), `Review` (reviewer checks the build).
- **PARKED / inert** states run no worker: `Review (Design)` (waiting on the human), `Done`,
  `backlog`, `cancelled`. This is exactly how `backlog`/`todo` are inert today — a parked state
  simply has no live worker, so it does **not** fight the dispatcher.

When the Design worker finishes, a light model sanity-checks the doc is complete, the ticket moves
to **Review (Design)** and parks. The concierge (me) gets the ticket-update turn, pings the
requester in-channel with the doc ("here's the design, good?"), and on their "yes" flips the ticket
to **In Progress**. The dispatcher resumes automatically into implement → review → done. **One
ticket carries the whole thing; no re-filing.** This is exactly how I steer live tickets today
(state flips + comments) — it just formalizes the pause as a named stage.

---

## 1. How the machine works today (ground truth)

Everything below is grounded in the current code so the proposal bolts onto reality, not a
sketch.

### 1.1 The coarse state engine

`TicketState` is a fixed six-value enum, board-agnostic (`src/plane/types.ts:26`):

```ts
export type TicketState =
  | "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export const TICKET_TERMINAL = new Set<TicketState>(["done", "cancelled"]);
```

The dispatcher maps state changes to worker actions with a small table
(`src/dispatch/dispatcher.ts:11`, and `onStateChanged` at ~194):

| PollEvent                    | Condition        | Action                                    |
|------------------------------|------------------|-------------------------------------------|
| `state_changed → in_progress`| no live worker   | spawn `casting.implement`                 |
| `state_changed → in_review`  | no live reviewer | spawn `casting.review`                     |
| `comment_added`              | live worker, not bot | `worker.nudge(comment)` — steering    |
| `comment_added`              | no live worker   | ignore                                    |
| `cancelled`                  | live worker      | `worker.abort` + reap                     |
| `state_changed → done`       | —                | reap; `promoteDependents`                 |
| `state_changed → todo/backlog`| —               | no-op (held)                              |

So **`in_progress` and `in_review` are the two LIVE states** — they spawn a worker. `backlog` and
`todo` are inert (held by a DAG blocker or a manual start); `done`/`cancelled` are terminal. The
**stage** string ("implement" / "review") is chosen by the entered state, then used to look up the
cast and drive the review gate.

### 1.2 Boards = Plane projects, already plural

Beckett already polls **multiple boards**, each a distinct Plane project with its **own
`state_map`** that renames the coarse states to that project's workflow columns
(`src/config.ts:129`):

```ts
const DEFAULT_PLANE_BOARDS = {
  ops:    { project_slug: "beckett", state_map: DEV_STATE_MAP },
  vid:    { project_slug: "VID",     state_map: VIDEO_STATE_MAP },
  vidpip: { project_slug: "VIDPIP",  state_map: DEV_STATE_MAP },
};
// default_board: "ops"
```

The `vid` board is the important precedent: it remaps the *same* coarse engine onto video columns
(`Ideas / Scripting / Production / Review / Published / Shelved`, `VIDEO_STATE_MAP` at
`src/config.ts:119`) **and** already tolerates extra human-move Plane states — the client folds any
unknown Plane state in the "started" group back to `in_progress` rather than dropping to backlog
(`src/plane/client.ts:574`). That's a live example of a board carrying human-gated columns the
engine doesn't itself drive.

The dispatcher holds one client per board (`this.clients`, `dispatcher.ts:108`) and does cross-board
dependency promotion, so a multi-board world is not new. `beckett ticket create --board <name>`
already exists and scopes the write to that project.

### 1.3 Casting is already open-ended per stage

A cast is per-stage `{harness, model, effort, reviewTier}` (`src/plane/types.ts:48`), and the
`Casting` map is **open-ended** — arbitrary stage names already type-check
(`src/plane/types.ts:66`):

```ts
export interface Casting {
  implement?: HarnessSpec;
  review?: HarnessSpec;
  [stage: string]: HarnessSpec | undefined;   // ← a "design" stage is already valid
}
```

Defaults today: implement omitted → pi/terra picks its own; review omitted → dispatcher auto-staffs
`config.models.reviewer` (Sonnet/Opus) at a scaled effort. `effort` also picks the gate:
`low|medium → self` (one pass), `high|xhigh|unset → fresh` reviewer (`dispatcher.ts:501`,
`reviewTier` overrides).

### 1.4 The concierge already drives tickets by state-flip + comment

The concierge doesn't own workers; it **files tickets and flips their state**. Two CLI verbs matter
(`src/cli/beckett.ts:846,855`):

```
beckett ticket comment <id> <text>
beckett ticket state   <id> <backlog|todo|in_progress|in_review|done|cancelled>
```

Ticket updates reach me as **synthetic update turns**: the poller emits `comment_added` /
`state_changed`, the concierge's `frameUpdate` decides whether it's worth surfacing, and
`updateTurn` routes a note to the ticket's `originChannel` telling me to
`beckett discord reply --channel <id> "…"` in my own voice
(`src/concierge/index.ts:1744,1800`). **This is the entire mechanism the human gate needs** — it
already exists; INT just adds one more surfaced shape.

### 1.5 Restart recovery already distinguishes live from parked

On boot, `prime()` re-emits `state_changed{from:null,to:"in_progress"}` for mid-flight tickets so
their worker respawns, and leaves inert states alone (`src/plane/poll.ts:168`). A parked state is
therefore **automatically restart-safe**: nothing re-staffs it.

---

## 2. The INT board: states + LIVE/PARKED classification

INT is a new board (`project_slug: "INT"`) with its own `state_map`. The lifecycle, in order:

| # | INT column (Plane) | Coarse state | Class | Dispatcher action on entry |
|---|--------------------|--------------|-------|----------------------------|
| — | Backlog            | `backlog`      | **PARKED** | held (DAG / manual start) |
| 1 | **Design**         | `design` ⟵new  | **LIVE**   | spawn `casting.design` — worker writes the design doc |
| 2 | **Review (Design)**| `design_review` ⟵new | **PARKED** | **no worker.** Human gate: doc already posted; concierge pings requester |
| 3 | **In Progress**    | `in_progress`  | **LIVE**   | spawn `casting.implement` |
| 4 | **Review**         | `in_review`    | **LIVE**   | spawn `casting.review` |
| 5 | **Done**           | `done`         | **PARKED** (terminal) | reap; promote dependents |
| — | Cancelled          | `cancelled`    | **PARKED** (terminal) | abort live worker (if any) + reap |

Two — and only two — **new coarse states** are introduced: `design` (LIVE) and `design_review`
(PARKED). Everything from `In Progress` onward is the **existing OPS machine, byte-for-byte**. The
new states are the front porch.

### 2.1 Why extend the enum (and why not overload)

The coarse enum only has two non-terminal inert states (`backlog`, `todo`) and both already carry
DAG-hold semantics, and only two live states (`in_progress`→implement, `in_review`→review). There
is no spare slot to mean "design worker" or "parked for human design-approval" without collision.
The honest, low-risk move is to **add `design` and `design_review` to `TicketState`**, gated so they
can only ever occur on the INT board. Considered and rejected: reusing `in_progress` for design with
a marker (overloads the one state the whole rework loop keys on) and reusing `todo`/`backlog` for the
gate (overloads DAG-hold, and the poller/prime already treat those as "not mid-flight"). Extending
the enum keeps each state's meaning single.

---

## 3. Dispatcher: telling INT (5-stage) from OPS (3-stage)

**Key off the board.** Every `Ticket` already carries `projectId` (the Plane project, e.g. `"ops"`)
and the dispatcher already knows which board client produced it. The rule:

- The two new states `design` / `design_review` are **only reachable on the INT board** — the OPS
  `state_map` has no Plane columns named "Design" / "Review (Design)", so those states can never
  hydrate for an OPS ticket. **OPS behavior is therefore unchanged by construction**; the new
  branches are dead code for it.
- The dispatcher's state→action switch gains two board-guarded arms. Concretely, in
  `onStateChanged` (`dispatcher.ts:~194`):

```
switch (to) {
  case "design":         if (isIntBoard(ticket)) spawnGuarded(ticket, "design");   break;  // LIVE
  case "design_review":  /* PARKED — no spawn; reap any leftover design worker */  break;
  case "in_progress":    spawnGuarded(ticket, "implement");                        break;  // unchanged
  case "in_review":      spawnGuarded(ticket, "review");                           break;  // unchanged
  case "done":           reap(); promoteDependents(ticket);                        break;  // unchanged
  case "cancelled":      onCancelled(ticket);                                      break;  // unchanged
  // backlog/todo: held
}
```

`isIntBoard(ticket)` is a `projectId === "INT"` (or `board === "int"`) check — the cleanest key, per
the discussion. `spawnGuarded(ticket, "design")` reuses the *exact* existing spawn path; "design" is
just another stage string, resolved by `castFor(ticket, "design")`.

### 3.1 State → action table (the whole INT machine)

| Coarse state | Board | LIVE/PARKED | Worker stage | On worker `done` → next |
|---|---|---|---|---|
| `design` | INT | LIVE | `design` | completeness-check → `design_review` (park) *or* bounce to `design` |
| `design_review` | INT | PARKED | — | (human) concierge flips → `in_progress` |
| `in_progress` | OPS+INT | LIVE | `implement` | `self` → `done`; `fresh` → `in_review` |
| `in_review` | OPS+INT | LIVE | `review` | pass → `done`; fail → rework `in_progress` (≤3) |
| `done` | OPS+INT | terminal | — | promote dependents |
| `backlog`/`todo` | OPS+INT | PARKED | — | held |
| `cancelled` | OPS+INT | terminal | — | abort + reap |

The only genuinely new dispatcher logic is (a) the two switch arms above and (b) a `stage==="design"`
branch in the worker-`onDone` handler (§5). Implement→review→done is untouched.

### 3.2 Restart landing while parked (falls out for free)

`prime()` re-emits only `in_progress`/`in_review` today. Extend it to also re-emit `design` (a live
re-staff — the design worker restarts from its committed WIP, same as implement). It must **not**
re-emit `design_review`: a parked gate stays parked across a restart, burns no tokens, and the
concierge's ping (already sent, and the doc is committed + on the ticket) still stands. This is the
same inert-on-restart property `backlog`/`done` already enjoy — no new safety code, just don't add
`design_review` to the re-staff list.

---

## 4. Casting extended to a `design` stage

INT casts have **three** stages: `{design, implement, review}`. Because `Casting` is already
open-ended (§1.3), the type needs no change; the dispatcher just resolves `casting.design` for the
design stage the same way it resolves `casting.implement`.

Sensible defaults, by the nature of each stage:

- **`design` → judgment/research-heavy → Opus tier.** Writing a design doc is taste, trade-off
  analysis, and reading unfamiliar code — terra's weak spot (fuzzy specs, real-repo reasoning; see
  `cast-presets.md` §2). Default **`claude-opus-5` at `high`** (Fable for genuinely foundational
  work, confirm-first as always).
- **`implement` → terra default.** Once the design is approved the spec is crisp — terra's home
  turf. Default the house `{harness:"pi", effort:"medium"}`.
- **`review` → scaled/fresh as today.** Omit to auto-staff Sonnet at scaled effort, or name a
  heavier seat for stakes.

Example INT cast JSON (the `beckett-cast` block on an INT ticket):

```json
{
  "design":    { "harness": "claude", "model": "claude-opus-5", "effort": "high" },
  "implement": { "harness": "pi",     "model": "gpt-5.6-terra",   "effort": "medium" },
  "review":    { "harness": "claude", "model": "claude-sonnet-5", "effort": "high" }
}
```

The design stage's own gate: a design worker at `high`/`xhigh` would, by the current effort rule,
imply a "fresh" review — but the design stage's "review" is **the human**, so the design stage does
**not** get a fresh code-reviewer. Its post-worker step is the completeness sanity-check (§5), then
the human gate. Implement/review keep the normal `effort`/`reviewTier` gate semantics unchanged.

---

## 5. The completeness sanity-check before parking

When the `design` worker finishes, the dispatcher's `onDone` (stage `"design"` branch) does, in
order:

1. **Commit the artifact.** Same `commitWorktree` the implement stage uses — the design doc lands
   in the repo (e.g. `docs/design/<ticket>.md`) and the worktree WIP is captured.
2. **Run a light completeness pass.** A cheap model (**Haiku 4.5** or Sonnet — *not* the Opus that
   wrote it, to avoid marking its own homework) reads the doc against a fixed rubric and returns a
   structured verdict `{complete: bool, gaps: string[]}`. Rubric checks that the doc:
   - states the problem and the chosen approach (not just options);
   - covers the acceptance criteria the ticket was filed with;
   - is concrete enough to implement from (interfaces / data shapes / file-level touch-points);
   - ends with a recommendation and open questions.
3. **Branch on the verdict:**
   - **Complete →** `setState(design_review)`; post a dispatcher comment carrying the doc link +
     a short summary + the literal ask ("here's the design — good to build?"). The ticket **parks**.
   - **Incomplete →** **bounce back to `design`** with the gaps as a steering comment, bounded by a
     `MAX_DESIGN_CYCLES` counter (mirror of the existing `MAX_REWORK_CYCLES = 3`,
     `dispatcher.ts:96`). On the last cycle, **park anyway** at `design_review` with a visible
     `⚠ completeness-check flagged: <gaps>` note appended to the human ping, so a human never
     silently loses the ticket to an internal loop — the human just sees the caveat and decides.

Recommendation: **bounce-then-park**, not park-blindly and not loop-forever. The check is a cheap
guardrail against handing the human half a doc, not a second author.

---

## 6. The human gate: concierge drives it, no re-filing

This reuses the existing update-turn machinery (§1.4) end to end:

1. Ticket enters `design_review` (PARKED). No worker. The dispatcher's completeness-pass comment —
   doc link + summary + "good to build?" — is on the ticket.
2. The poller emits `comment_added`; the concierge's `frameUpdate` surfaces it (a new
   non-suppressed shape: design-gate asks are milestones, unlike the `→ in_review` transition it
   drops today). `updateTurn` routes it to the ticket's `originChannel`.
3. **I (concierge) ping the requester in-channel, in my voice, with the doc:** "Here's the design
   for INT-N — <one-line gist + link>. Good to build, or want changes?" (via
   `beckett discord reply --channel <id> …`).
4. On their **"yes"**: I run `beckett ticket state INT-N in_progress`. The dispatcher's
   `onStateChanged(in_progress)` spawns the implement worker with `casting.implement`. The flow
   **resumes automatically into implement → review → done**. Same ticket, same worktree lineage,
   **no re-filing** — the design doc is already committed and is the implement worker's brief.
5. On **"no / changes"**: I run `beckett ticket state INT-N design` **with a steering comment**
   capturing what they want changed. Because `design_review` is parked (no live worker), a bare
   comment would be ignored by the dispatcher (`comment_added` + no worker → ignore) — so the
   **state flip is what re-spawns** the design worker, and the fresh worker reads the latest
   comments as its steering. (Optional bound: a `MAX_DESIGN_REJECTS` guard so a doc can't ping-pong
   forever without a human escalation note.)

The gate is thus **entirely concierge-driven with today's primitives** — `ticket state` +
`ticket comment` + `discord reply`. Nothing new in the gate except one surfaced comment shape and
my judgment, which is the point: it formalizes the pause I already perform manually.

---

## 7. Filing shape + preset composition

### 7.1 Creating an INT ticket

INT is just a board, and `--board` already exists, so the minimum is:

```
beckett ticket create --board INT \
  --title "…" --body-stdin --criteria "…;…" --channel <id> \
  --state design            # enter live at Design (default entry for INT)
```

Optional sugar, if we want it to read intentionally: **`--intensive`** as an alias that expands to
`--board INT --state design`. Recommended — "intensive" is the word Jason uses, and it keeps the
board name an implementation detail. Either way the CLI change is tiny; the machinery is the board +
the two states.

Entry state: an INT ticket should **default to `design`** (live) when created, or `backlog` if it's
DAG-blocked and should wait — same `--state` semantics as OPS, just with `design` as the natural
live entry instead of `in_progress`.

### 7.2 Composing with the OPS-110 preset system

An intensive flow is itself expressible as a **preset** carrying all three casts. Because
`~/.beckett/presets.json` values are `Casting` objects and `Casting` is open-ended, a `design` stage
**already validates** — no preset-loader change needed (`loadPresets`/`resolveCasting`/`validateCasting`
handle arbitrary stage names today, `src/plane/presets.ts`). Add a seed preset:

```json
{
  "intensive": {
    "design":    { "harness": "claude", "model": "claude-opus-5", "effort": "high" },
    "implement": { "harness": "pi",     "effort": "medium" },
    "review":    { "harness": "claude", "model": "claude-sonnet-5", "effort": "high" }
  }
}
```

Invoked exactly like any preset, and overridable per-stage by an explicit `--cast` (the OPS-110
shallow per-stage merge, `resolveCasting`):

```
beckett ticket create --board INT --preset intensive \
  --cast '{"implement":{"harness":"pi","effort":"high"}}' …
# → keeps Opus design + Sonnet review, swaps implement to terra-high
```

`beckett plan` nodes can carry `"preset":"intensive"` + `"board":"INT"` too, so an intensive ticket
can sit inside a larger DAG. The only preset-system nicety worth considering: `validateCasting`
currently doesn't *require* a `design` stage — an `intensive` preset missing `design` would file an
INT ticket that enters `design` with no cast and falls back to the default. Fine (default is Opus),
but we could optionally warn if an INT ticket lacks a `design` cast. See open questions.

---

## 8. Failure & edge cases

| Case | Behavior |
|---|---|
| **Human rejects the design** | Concierge `ticket state INT-N design` + steering comment; fresh design worker reads it and rewrites. Optional `MAX_DESIGN_REJECTS` escalation. (§6.5) |
| **Design worker fails outright** | Same as implement-fail today: post comment, leave in `design` for a human/restaff. `beckett ticket restaff` works (it's stage-agnostic). |
| **Completeness check fails** | Bounce to `design` (≤`MAX_DESIGN_CYCLES`), then park with a `⚠` note rather than loop forever. (§5) |
| **Design needs rework mid-implement** | If implement reveals the design was wrong, concierge can flip `in_progress → design` with a comment. One ticket still carries it; the design worker re-runs, re-gates. (This is the payoff of one-ticket-end-to-end.) |
| **Cancel mid-flow** | `cancelled` works from any state as today: live worker (design/implement/review) is aborted + reaped; parked at `design_review`, there's simply no worker to abort — terminal. |
| **Restart while parked at `design_review`** | Inert by construction: `prime()` doesn't re-emit it, no worker respawns, the gate persists, zero tokens. The doc is committed and the ping already sent. (§3.2) |
| **Restart while in `design`** | `prime()` re-emits `design` → design worker re-staffs from committed WIP, same as `in_progress` today. |
| **Concurrency** | Design/implement workers count against the same `max_workers` cap (default 2, `config.ts:94`). A long design stage could starve OPS bugfixes. See open questions. |
| **INT ticket filed without `--channel`** | Same failure the closed loop already guards: `updateTurn` warns loudly and the gate can't ping. INT should arguably *require* `--channel` (the human gate is the whole point). |

---

## 9. Open questions for Jason

1. **Enter at `design` or `backlog`?** Should `beckett ticket create --board INT` default to a live
   `design` entry, or park at `backlog` until explicitly started? (I lean: default `design`, since
   the point of filing an intensive task is to start designing it.)
2. **`--intensive` sugar, or raw `--board INT`?** Sugar reads better and hides the board name;
   raw is zero new CLI. (I lean: ship the `--intensive` alias — it's one line and matches how you
   talk about it.)
3. **Require a `design` cast on INT tickets?** Warn/error if an INT ticket has no `design` stage in
   its cast, or silently fall back to the Opus default? (I lean: fall back silently; the default is
   already the right seat.)
4. **Completeness-check model + strictness.** Haiku (cheapest) vs Sonnet (sharper) for the pass, and
   is bounce-then-park the right disposition, or do you want it to *only* ever advisory-note and
   never bounce? (I lean: Sonnet, bounce-then-park with a hard cap of 2.)
5. **Concurrency isolation.** Do INT's long design/implement stages need their own worker budget so
   they can't starve quick OPS work, or is the shared cap of 2 fine to start? (I lean: shared to
   start, measure, add an INT-scoped slot only if starvation shows up.)
6. **Design-doc artifact location + naming.** `docs/design/<ticket-id>.md` (e.g.
   `int-42.md`)? And does the implement stage *always* treat that file as its authoritative brief?
7. **Rejection ping-pong.** Cap on design rejects before it escalates to "let's get on a call"
   rather than looping the worker? (I lean: yes, cap at 3, then hand it fully to the human.)

---

## 10. Recommendation

**Build it, and build it thin.** The design deliberately adds almost nothing new to the runtime:

- **One new board** (`INT`, `project_slug: "INT"`, its own `state_map`) — the multi-board machinery
  already exists and `vid` proves boards can carry human-gated columns.
- **Two new coarse states** (`design` LIVE, `design_review` PARKED), reachable only on INT, so OPS
  is unchanged by construction.
- **Two dispatcher switch arms + one `stage==="design"` branch** in the worker-done handler (commit
  → completeness-check → park or bounce). Implement→review→done is untouched.
- **Zero preset/cast type changes** — `Casting` is already open-ended; the `design` stage and an
  `intensive` seed preset validate today.
- **Zero new gate machinery** — the concierge already drives tickets by `ticket state` +
  `ticket comment` + `discord reply`; the human gate is one more surfaced comment shape plus my
  judgment. The parked state doesn't fight the dispatcher because a parked state has no live worker,
  and it's restart-safe for the same reason `backlog` is.

The whole win: **one ticket carries an intensive task from design through a real human-approval gate
to shipped**, with no re-filing and no lost context, while every quick bugfix stays on the untouched
3-stage OPS flow. The heavy stage (design) gets the heavy seat (Opus); the crisp stage (implement)
gets the cheap one (terra); the human stays in the loop at exactly one well-named pause.

Greenlight the shape (and the open-question defaults you prefer) and I'll file the build ticket —
an INT ticket, naturally, so its first act is to design itself.
