
**Anything visual is `claude` (Opus), never `pi`** — a canvas toy, a game, an animation, a
particle/physics demo, a landing page, "make it look like X." pi grinds slowly on visual work
(it can't see the result, so it over-engineers) *and* the output is worse. A person judges these
by eye, so the right cast is **Opus @ `high` with `"reviewTier":"self"`** → one pass, no cold
reviewer. Save pi for things with a crisp spec and no pixels: APIs, parsers, data layers,
scripts, migrations.

**On any frontend/UI ticket, invoke the [[ui-designer]] skill *before* you write the cast
brief** — it's the house aesthetic and the source-before-hand-roll workflow (check 21st.dev,
then shadcn/ui, then build). Bake it into the brief so the worker loads the same taste: name the
skill, tell them to source a base component before hand-rolling, and point them at its rubric for
the self-review. (See the usage note at the bottom of the skill for the one-paragraph brief
template.)

If a ticket is genuinely mixed (a feature with both a backend and a UI), prefer splitting it
into two tickets so each gets the right harness — a clean backend ticket (pi) and a clean
frontend ticket (claude). One muddy ticket cast to one harness serves neither half well.

#### Effort — per model, not one ladder

`effort` (`low`/`medium`/`high`/`xhigh`) tunes reasoning depth on both harnesses (claude's
`--effort`, pi's `--thinking`). **Always name one explicitly** — an omitted effort takes the
harness default *and* silently selects the expensive fresh-review gate. The right level
depends on *which model*, not just how hard the task sounds:

- **`pi` (gpt-5.6-terra, default; gpt-5.6-luna for the cheap lane)** — `medium` when the ticket
  body is really specific about what needs to be done (sharp spec → medium is excellent and
  fast); `high` when it has to make real decisions; `xhigh` rare, crucial tasks only. Reach for
  an explicit `"model":"gpt-5.6-luna"` on cheap/mechanical low-effort grind.
- **`claude-opus-5`** — `high` for most tasks (the default choice), `xhigh` for the
  genuinely harder ones. Never below `high`.
- **`claude-sonnet-5`** — `medium` or `high` only. Never `xhigh`.
- **`claude-fable-5`** — `high` as the standard (review or implement); `xhigh` only for the
  most crucial work, and remember every Fable cast was already confirmed with the human.

`xhigh` in general is rare across the whole fleet — reserved for crucial, hard-to-reverse work
where a wrong answer costs far more than the extra minutes. If you're casting `xhigh` more than
occasionally, you're mis-sizing tickets.

**`effort` also picks the review gate (v3.1) — this is your main speed lever.** A worker
self-reviews its own diff against the criteria before finishing, so a second cold reviewer is
often wasted relay time. The dispatcher reads your cast `effort`:

- **`low`/`medium`** → **one pass**: the worker self-verifies and the ticket goes straight to
  `done`. No separate reviewer. This is where crisp-spec pi work at `medium` lands.
- **`high`/`xhigh`, or omitted** → **fresh adversarial reviewer** runs after implement. Right
  for correctness-critical / hard-to-reverse work (auth, money, data migrations, shared
  interfaces, anything that breaks siblings if it's wrong).
- You can force the gate independent of effort with `reviewTier`: `{"implement":{...,
  "reviewTier":"self"}}` (one pass) or `"fresh"` (always review). Since Opus never runs below
  `high`, **`"reviewTier":"self"` is how visual/taste work stays one-pass** — cast it
  explicitly on every visual ticket, or you'll pay a cold reviewer to judge pixels it can't
  see.

Bias toward one pass (`medium` on pi, or `reviewTier:"self"` on claude). Only spend a fresh
review when a wrong answer is expensive.

#### Cost — read the bill and recalibrate

Every worker comment on a ticket carries a telemetry footer: `_N turns · M tool calls · X
tokens · ~$Y_` (the $ figure appears whenever the driver has real cost data). **When a ticket
finishes, read it.** Weigh the cost against the size of the task — a copy tweak that burned
$5, a small fix that took 40 turns, a visual toy that paid for a fresh reviewer: those are
miscasts, and they're *your* miscasts, because you wrote the cast.

When the cost/task ratio is off, **remember it and generalize**. Use the `remember` skill to
record the pattern, not the incident: "small copy tickets on Opus xhigh cost ~10x what they
should — cast Sonnet medium" beats "#41.1 was expensive". Recall these before casting similar
work; the roster above is a starting map, and the cost feedback loop is how it gets corrected
by reality.

### Filing — exact commands

Create the task first. Always carry the stamped channel so the daemon can open and route the
workspace named `#N - Task title`:
