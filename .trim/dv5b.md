
**Anything visual is `claude` (Opus), never `pi`** — a canvas toy, a game, an animation, a
particle/physics demo, a landing page, "make it look like X." pi can't see the result, so it
over-engineers and the output is worse. Right cast: **Opus @ `high` with `"reviewTier":"self"`**
→ one pass, no cold reviewer. Save pi for crisp specs with no pixels: APIs, parsers, data layers,
scripts, migrations.

**On any frontend/UI ticket, invoke the [[ui-designer]] skill *before* you write the cast brief**
— house aesthetic plus the source-before-hand-roll workflow (check 21st.dev, then shadcn/ui, then
build). Bake it into the brief: name the skill, tell them to source a base component before
hand-rolling, point them at its rubric for the self-review. (Its usage note has the one-paragraph
brief template.)

A genuinely mixed ticket (backend + UI) is better split in two, so each half gets the right
harness — backend on pi, frontend on claude.

#### Effort — per model, not one ladder

`effort` (`low`/`medium`/`high`/`xhigh`) tunes reasoning depth on both harnesses (claude's
`--effort`, pi's `--thinking`). **Always name one explicitly** — an omitted effort takes the
harness default *and* silently selects the expensive fresh-review gate. The right level depends on
*which model*:

- **`pi` (gpt-5.6-terra, default; gpt-5.6-luna for the cheap lane)** — `medium` when the ticket
  body is really specific; `high` when it has to make real decisions; `xhigh` rare, crucial tasks
  only. Explicit `"model":"gpt-5.6-luna"` for cheap/mechanical low-effort grind.
- **`claude-opus-5`** — `high` for most tasks, `xhigh` for the genuinely harder ones. Never below
  `high`.
- **`claude-sonnet-5`** — `medium` or `high` only. Never `xhigh`.
- **`claude-fable-5`** — `high` as the standard (review or implement); `xhigh` only for the most
  crucial work, and every Fable cast was already confirmed with the human.

`xhigh` is rare fleet-wide — reserved for crucial, hard-to-reverse work where a wrong answer costs
far more than the extra minutes. Casting it more than occasionally means you're mis-sizing tickets.

**`effort` also picks the review gate (v3.1) — your main speed lever.** A worker self-reviews its
diff against the criteria before finishing. The dispatcher reads your cast `effort`:

- **`low`/`medium`** → **one pass**: the worker self-verifies, the ticket goes straight to `done`,
  no separate reviewer. Crisp-spec pi work at `medium` lands here.
- **`high`/`xhigh`, or omitted** → **fresh adversarial reviewer** after implement. Right for
  correctness-critical / hard-to-reverse work (auth, money, data migrations, shared interfaces,
  anything that breaks siblings if it's wrong).
- Force the gate independent of effort with `reviewTier`: `{"implement":{...,
  "reviewTier":"self"}}` (one pass) or `"fresh"` (always review). Since Opus never runs below
  `high`, **`"reviewTier":"self"` is how visual/taste work stays one-pass** — cast it explicitly
  on every visual ticket, or you'll pay a cold reviewer to judge pixels it can't see.

Bias toward one pass (`medium` on pi, or `reviewTier:"self"` on claude). Only spend a fresh review
when a wrong answer is expensive.

#### Cost — read the bill and recalibrate

Every worker comment carries a telemetry footer: `_N turns · M tool calls · X tokens · ~$Y_` (the
$ figure appears whenever the driver has real cost data). **When a ticket finishes, read it.**
Weigh cost against the size of the task — a copy tweak that burned $5, a small fix that took 40
turns, a visual toy that paid for a fresh reviewer are miscasts, and they're *yours*.

When the ratio is off, **remember it and generalize**: use the `remember` skill to record the
pattern, not the incident ("small copy tickets on Opus xhigh cost ~10x what they should — cast
Sonnet medium" beats "#41.1 was expensive"). Recall these before casting similar work.

### Filing — exact commands

Create the task first. Always carry the stamped channel so the daemon can open and route the
workspace named `#N - Task title`:
