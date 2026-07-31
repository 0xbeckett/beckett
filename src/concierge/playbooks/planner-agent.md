## The planner agent — a draft to file, never a decision to forward

`beckett agent invoke planner "<the ask>"` spends a read-only Opus seat on turning a fuzzy request
into work you can file. It reads the real repo before it answers and comes back with either one
sharp ticket or the exact `beckett plan` JSON — cast, checkable criteria, a stated ceiling, risks
flagged. **It files nothing**: no write tools, no filing authority. You file.

**Reach for it when the shape of the work is the question.** The ask is fuzzy, spans code you
haven't read, or names an outcome instead of a change — "make X faster", "why is Y flaky", "should
this be one ticket or four". Same call when you're about to guess at acceptance criteria for a repo
you don't know: a criterion about a symbol that doesn't exist is unbuildable, and the worker eats
the rework cycle for your guess.

**Skip it when you can already file.** A crisp ask you could write criteria for right now is pure
latency through the planner. So is anything conversational, and anything where you already know the
file and the fix. It is not a research agent, not a code reviewer, and it does not touch the
browser — those go to `quick`, to a review cast, and to the browser skill. It's Opus on high doing
real repo reads, so it is not free; that cost is the whole reason this paragraph exists.

**Hand it everything the Discord turn gave you** — it can't see the conversation, only your string:

```
beckett agent invoke planner "Dashboard search is slow; owner wants it under 300ms. Project slug:
atlas (~/Projects/atlas). Constraint: don't touch the ingest pipeline. Done looks like: typing in
the box feels instant on a 10k-row account." --timeout 300
```

The raw request in the person's own words, the repo/project slug, every constraint they stated (a
hold, a deadline, "don't touch Z"), and what *done* would look like if you know. Paste the board
(`beckett task list`) in too when a duplicate is plausible — it will say so in a `NOTE:` line
instead of speccing the same thing twice.

**Two output shapes come back, and you check one before you trust it.**

- `SHAPE: one ticket` — `TITLE` / `PROJECT` / `CAST` / `BODY` / `CRITERIA`. The default and usually
  right.
- `SHAPE: plan — <the shape in plain words>` followed by the JSON `beckett plan` consumes.

In both: the criteria are actually checkable (a name, a path, an observable behavior — never "works
well"), the ceiling is present so a worker can't gold-plate an unbounded ask, the `PROJECT` slug is
a repo that really exists, and every cast is a seat on the roster in `how-to-start-a-task.md`. The
planner *proposes* a cast; **where it disagrees with that playbook, that playbook wins** — including
effort and the review gate. It's told to raise correctness-critical work in a `NOTE:` line rather
than cast Fable itself, and a Fable review still needs the human confirm exactly as if you'd
chosen it. `NOTE:` lines are addressed to you alone: a risk, a routing call it isn't allowed to
make, something it couldn't verify. Anything stamped `UNVERIFIED:` is a claim it ran out of clock
on — check it or cut it. For a plan, hold the DAG to the bar in `splitting-work.md` before you
believe the split.

**Then you make it real.** One ticket → `beckett task create` with its title, `--project` and the
`[channel:…]` id, then `beckett task start '#N.1'` carrying its body, its criteria as the
`;`-separated list, and its cast. A plan → the `plan` skill: put your channel id in the top-level
`channel` field (the planner leaves that for you) and file the DAG in one shot. Edit on the way
through — trim a criterion, re-cast a stage, drop a node, split what it merged. **The concierge
files. The planner never does.** Its output is a draft you're accountable for, not a decision you
forward, and once filed it reads as your ticket, because it is.

**What to distrust:**

- **It has no memory between invokes.** Every call starts cold. The agent schema carries a
  `persistent` flag and nothing honors it yet — a follow-up invoke has no idea what the last one
  said, so re-state the context every time instead of writing "like before".
- **It can't make routing calls it isn't allowed to make.** `--project beckett` and
  `--confirm-beckett` stay with you: it flags Beckett-source work in a `NOTE:` line, and the
  routing judgment in `how-to-start-a-task.md` is yours.
- **It read the repo at invoke time.** On a fast-moving branch that snapshot ages in minutes —
  verify the paths and symbols it cites still exist before you file criteria against them.
