# Routines — humanized recurring tasks (issue #62)

A **routine** is a named, recurring scheduled task whose fire time is *humanized*, not a
clockwork cron tick. Instead of firing at exactly 12:00 every day, a routine fires at a random
minute inside a **window** — e.g. somewhere in `12:00–13:00 America/Los_Angeles`, so one day
it's 12:07 and the next it's 12:41. The point is human-irregular timing.

## Model

Each routine has:

- an **id / name** (kebab-case, e.g. `daily-x-shitpost`),
- an **action** — what to run when it fires, always dispatched OFF the scheduler process, never
  inline. Most actions go to the `beckett browser` background lane; `deps-update` (below) is the
  one local-maintenance action and `self` (below) is the one that wakes Beckett's own concierge,
  and neither of those touches the browser,
- a **schedule** = a base **cadence** (`daily` or `weekly <weekday>`; the union in
  [`src/routine/types.ts`](../src/routine/types.ts) is still the seam for `interval`)
  plus a **fuzz window** (`start`–`end` wall-clock in a named IANA timezone).

Each period the scheduler picks one concrete fire time **uniformly at random inside the
window** and fires exactly once.

### Cadences

| Cadence | Period key | Fires |
|---|---|---|
| `daily` | the tz-local date, `2026-07-26` | every day, at a random minute in the window |
| `weekly` | the tz-local **ISO week**, `2026-W30` | once that week, on the named weekday, at a random minute in the window |

ISO weeks run Monday→Sunday and belong to the year holding their Thursday, so a Sunday routine
fires on day 7 of the week it is keyed to — and a New Year that splits a week (2026-12-28 through
2027-01-03 are all `2026-W53`) still gets exactly one fire. Sunday's fire is chosen and persisted
as soon as any tick that week runs, so `routine ls` on a Monday already shows the coming Sunday's
concrete minute, and a restart on the Wednesday in between neither re-rolls it nor re-fires a week
that already ran.

## Persistence & restart safety

Routine definitions and the current period's already-chosen fire time persist to
`<beckettDir>/routines.json` (atomic tmp+rename, same discipline as the task registry). On a
daemon restart:

- the period's chosen time is **restored verbatim** — it is *not* re-rolled, and
- firing is **idempotent per period** via a `lastFiredPeriodKey`, so a restart mid-window
  neither double-fires nor loses a due fire (it catches up once).

Weekly works through the *same* guard — the key is just wider (an ISO week instead of a date), so
a restart at any point in the week sees the period already claimed.

The scheduler claims the period on disk *before* dispatching, so a crash mid-dispatch can never
double-post.

## The RNG is testable

The fuzz randomness is injectable (`rng: () => number`). Tests feed a seeded PRNG
(`seededRng` in [`src/routine/schedule.ts`](../src/routine/schedule.ts)) to prove both that the
chosen minute *varies run-to-run* and that a given seed reproduces a run deterministically. See
[`src/routine/schedule.test.ts`](../src/routine/schedule.test.ts) and
[`scheduler.test.ts`](../src/routine/scheduler.test.ts).

## CLI

```
beckett routine list                       # every routine + its next concrete fire time
beckett routine inspect <id>               # full detail incl. persisted state
beckett routine add <id> --window 09:00-09:40 --tz America/New_York \
    ( --task "<self-contained browser task>" | --self "<prompt Beckett gives itself>" ) \
    [--weekly <weekday>] [--name <n>] [--creds <jingle-entry>] [--channel <id>]
beckett routine remove <id>                # a removed built-in stays removed across restarts
beckett routine enable|disable <id>
beckett routine fire <id> --dry-run        # compose + build the dispatch plan, POST NOTHING
beckett routine fire <id> --force          # real, live dispatch through the browser lane
```

`add` creates a `browser`-action routine that runs an arbitrary self-contained task each period,
unless you pass `--self` instead of `--task` — then it creates a `self`-action routine that wakes
Beckett itself (see the self lane below). `--task` and `--self` are **mutually exclusive**: a
routine is either a browser task or a self-directed wake, and passing both fails at add time.
Pass `--weekly sunday` (any weekday name) to make it weekly instead of daily; `routine ls` and
`routine inspect` then show the cadence as `weekly (sunday)` and the next fire with its weekday
spelled out, e.g. `Sun, 2026-07-26, 09:44 America/Los_Angeles`.

## Built-in: `daily-x-shitpost`

Seeded on first load: once a day at a random minute in **12:00–13:00 America/Los_Angeles**, it
composes a short, dumb, in-voice shitpost (Beckett's persona — *"if i eat a clock is that time
consuming"* energy) and posts it to **X / @beckposting** by dispatching `beckett browser` with a
self-contained post task.

- The X credentials live in the **jingle keychain** under `x.com`. They are passed to the
  browser lane via `--creds x.com` and resolved *below the model's transcript* (issue #58) —
  **no secret is ever hardcoded or inlined** into the routine, the task string, or the plan.
- The action runs on the dedicated background browser agent, never in the scheduler process. Browser
  tasks can attach a screenshot captured earlier in the same run when the post needs an image;
  arbitrary local files are never uploadable from a lane.
- `channelId` / `requesterId` (where the lane reports its outcome/questions) are resolved at
  fire time from `BECKETT_ROUTINE_CHANNEL_ID` and `DISCORD_OWNER_ID` — no id is baked into
  source.

### Prove the wiring without posting

```
beckett routine fire daily-x-shitpost --dry-run
```

This composes the shitpost and prints the exact browser task + `--creds x.com` entry that
*would* be dispatched, but **posts nothing**.

### Trigger a REAL fire

A real post requires the daemon running (it owns the browser lane) and the origin env set:

```
export BECKETT_ROUTINE_CHANNEL_ID=<discord-channel-id>   # where the lane reports back
export DISCORD_OWNER_ID=<owner-id>                        # who the run is attributed to
# X creds must already be in the jingle vault under `x.com` (see docs/jingle.md)

beckett routine fire daily-x-shitpost --force
```

`--force` bypasses the schedule and dispatches immediately; the background browser agent logs
in from the injected session, posts the composed shitpost to @beckposting, and reports the
proof/URL back to the channel as a browser-agent update turn. Left alone, the scheduler fires it
automatically once per day inside the window.

## Built-in: `weekly-deps-update` (issue #85)

Seeded on first load: **Sunday mornings, a random minute in 08:00–10:00 America/Los_Angeles**,
Beckett updates its own dependencies as far as the `package.json` ranges allow and opens a PR. The
motivating case was `betterwright` sitting at 1.1.3 locally while 1.3.1 was published — the point
is that nobody hand-bumps deps any more.

This is the one action that does **not** go through the browser lane. It is a local maintenance job:
no web session, no credentials, no agent. `buildDispatchPlan` gives it its own `deps-update` lane
and the dispatcher forks on that lane *before* it resolves the browser agent at all, so the two can
never be confused. The lane launches `beckett routine deps-update` as its own detached process —
a clone + install + full test suite runs for minutes, which has no business inside a scheduler tick.

What one run does, in order ([`src/ops/deps-update.ts`](../src/ops/deps-update.ts)):

1. **Clone.** `git clone --no-hardlinks <source> <tmp>`. The live checkout at `~/beckett` is only
   ever a clone *source*; every mutating command runs with its cwd inside the throwaway clone, which
   is deleted in a `finally`. An in-place `npm update` on the tree the daemon is running out of is
   exactly the failure mode this shape exists to prevent.
2. **Detect managers from lockfiles present** — `package-lock.json`/`npm-shrinkwrap.json` → npm,
   `bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm. A manager with no lockfile is skipped
   entirely, so all three are supported and only the ones actually in use ever run. (Beckett's own
   repo is bun-only today.)
3. **Update in range.** The bare `update` verb for each detected manager — never `--latest`, so
   `package.json` ranges are respected. Nothing outside the ranges is applied.
4. **Prove it.** `<manager> run typecheck` then `<manager> run test`, in the clone. If either goes
   red the run **stops here**: no branch pushed, no PR opened, and the summary names the failed
   check. A red PR is worse than no PR. Staging (step 5) is limited to the paths the update itself
   changed — captured *before* the checks ran — so nothing the suite leaves in the tree can end up in
   the PR.
5. **Publish a proposal.** `beckett gh push` of a `beckett/deps-update-<date>` branch, then
   `beckett gh pr create --base main`. Never raw `gh`, never `git push`, never a push to `main`, and
   there is no deploy anywhere in the path. The output is a PR a human merges.
6. **Report one line** to `BECKETT_ROUTINE_CHANNEL_ID` (or the routine's `channelId`) with the PR
   link. It runs unattended every week, so it is deliberately terse — one line, always, including
   when it failed and opened nothing.

Anything the ranges refuse — a major-version jump, or an exact pin the package has outgrown, like
`betterwright: "1.1.3"` → 1.3.1 — is reported as **available, not applied**, in both the summary
line and the PR body. Applying it is a human decision.

### Known limit: the checks are not state-sandboxed

`bun run test` runs Beckett's own suite, which writes per-run artifact dirs (`browser-agent/`,
`quick/`, `agent-runs/`, …) under the resolved `beckettDir` — so a weekly run leaves the same residue
under `~/.beckett` that a developer's own `bun test` does. The obvious fix, pointing `BECKETT_DIR` at
a scratch dir for the check phase, was tried and **reverted**: `BECKETT_DIR` is the
highest-precedence path override ([`src/paths.ts`](../src/paths.ts)), so it also overrides the
`paths.beckett_dir` that 34 browser/config tests set for themselves, and the suite goes red — a guard
that aborts the routine every week is worse than the residue.

The constraint that matters is intact: the **source checkout** is never mutated (that is what the
clone is for), and nothing in the run writes `routines.json`, the database, or config. True isolation
here needs a sandbox (`bwrap`, already an install dependency) rather than an env var; it is not worth
it for additive artifact dirs.

### Prove the whole job without touching GitHub

```
bun scripts/ops/deps-update-rehearsal.ts [--source <checkout>]
```

Runs the real clone, real update, real typecheck and real test suite, stubbing only the
`beckett gh` calls — and prints the exact argv it *would* have run. Use it before changing the job;
the unit suite ([`src/ops/deps-update.test.ts`](../src/ops/deps-update.test.ts)) covers the same
guarantees with everything injected.

## Built-in: `model-news-watch` (issue #1) — the event-listener action

Every other routine fires on a **schedule**; `watch` fires on an **event**. It polls a feed on a
plain interval and, on a genuinely new item, dispatches through the SAME `agent` lane
`daily-x-shitpost` uses — an event post instead of waiting for the next scheduled lane. A `watch`
routine has **no `schedule`** (see the `RoutineAction` union in
[`src/routine/types.ts`](../src/routine/types.ts)) — its timing is `pollIntervalMinutes`, not a
fuzz window, and it is driven by its own interval loop
([`src/routine/watch.ts`](../src/routine/watch.ts)`::startWatchLoop`), not
`startRoutineScheduler`'s once-per-humanized-period tick.

Seeded on first load, **enabled**, polling **every 15 minutes**: `https://ai-tracker.ssh.codes/api/v1/model-news?type=model&new_models=true`
— a changelog of newly-shipped models — for the `social-media` agent (`@beckposting`).

### Qualification, dedup, and the hard rate limits

An item only fires when it is **unseen**, `newModel === true`, and `publishedAt` is inside the
**last 24h** ([`isQualifyingItem`](../src/routine/model-news.ts)). Every item the feed returns —
qualifying or not — is marked seen the moment it's evaluated, so nothing is ever reconsidered.

On top of qualification, three rails apply and are **not configurable**:

- **never twice about the same model id** — checked against the routine's own post history, not
  just this round's items;
- **at most one extra qualifying item survives per round** — the earliest-published candidate
  wins; every other qualifying item that round is marked seen and logged as *dropped*, never
  queued for later;
- **1 event post per hour, 3 per rolling 24h** ([`WATCH_RATE_LIMIT`](../src/routine/rate-limit.ts))
  — hard caps, independent of anything on the routine's own config.

### Cold start never backfills

The very first poll after `model-news-watch` starts running — a fresh install, or a state file
that was deleted — records every item currently in the feed as seen and **posts nothing**. Only an
item that shows up in a *later* poll can ever qualify. This is the one behavior the feature fails
without: a cold start that treats a week's worth of history as breaking news.

### A broken feed never posts

A non-200 response, a timeout, unparseable JSON, or an unexpected top-level shape
([`fetchModelNewsFeed`](../src/routine/model-news.ts)) is logged and the round is skipped — the
seen-set and post history are untouched, and the same feed is tried again next interval. A single
malformed item inside an otherwise-good response is dropped without failing the round; unknown
fields on an item are ignored rather than crashing the parse.

### Dry-run: watch a day of decisions without posting

```
beckett routine watch-mode model-news-watch dry-run   # ambient — every future poll simulates
beckett routine watch-mode model-news-watch live       # back to posting for real
```

In dry-run mode the routine still polls, still qualifies, still dedups, and still rate-limits for
real — the only thing that changes is the last step: instead of dispatching the agent, it posts a
one-line `[dry-run] would post about …` preview to the report channel. Its accounting lives in a
**separate bucket** from real posts, so flipping back to `live` never treats a simulated post as
one that actually happened (and vice versa).

`beckett routine fire model-news-watch --dry-run` is a second, independent lever: a ONE-SHOT,
**read-only** simulation against whatever is currently persisted — it fetches the live feed (so
the preview is real, not a guess) but never mutates the seen-set/post-history and never posts,
regardless of the routine's ambient `dryRun` setting. Unlike every other routine's `--dry-run`
(which is pure/offline), this one needs the network to say anything useful — it still never touches
the daemon or the bus, so it works even if the daemon isn't running:

```
beckett routine fire model-news-watch --dry-run
```

### Disabling

```
beckett routine disable model-news-watch
```

Takes effect on the poll loop's very next tick — no daemon restart. `enable`/`inspect`/`fire` all
work exactly like every other routine.

### Where a real fire posts, and what shows up in Discord

A qualifying fire dispatches the `social-media` agent with the item's title, model id(s), summary,
and `source.url` as its subject — the agent still does its own research, verifies at `source.url`,
and writes in voice before the background browser lane publishes (issue #1's prompt-side patch to
`agents.json`/`routines.json` covers that half; this routine only supplies WHEN and WHICH item).
The post-live confirmation rides the SAME browser-lane outcome relay every other routine post
does — one short line to `BECKETT_ROUTINE_CHANNEL_ID` (or the routine's `channelId`) with the URL.

### Unit tests

[`src/routine/model-news.test.ts`](../src/routine/model-news.test.ts) covers the qualification
predicate and the feed's defensive parsing; [`src/routine/rate-limit.test.ts`](../src/routine/rate-limit.test.ts)
covers the 1/hour + 3/24h caps; [`src/routine/watch-store.test.ts`](../src/routine/watch-store.test.ts)
covers the seen-set/post-history persistence and its age/count bounds; and
[`src/routine/watch.test.ts`](../src/routine/watch.test.ts) covers the cold-start seed-no-backfill
path, dedup by model id (including across two different feed items), the rate limiter wired into a
full cycle, dry-run's separate accounting bucket, `previewWatchCycle`'s read-only guarantee, and
the poll loop's live enable/disable + per-routine interval gating.

## The `self` lane (issue #26) — a routine that wakes Beckett, not the browser

Every other lane wakes something *other* than Beckett — a browser task, a registered agent, a
local maintenance subprocess, a polled feed. The `self` lane is the one that wakes **Beckett's own
concierge**: the seat with the doctrine, the memory graph, the Bash tool, and the ability to file
tickets. A `self` routine puts Beckett on its own open-loop ledger a few times a day.

```
beckett routine add morning-sweep --window 08:00-09:00 --tz America/Los_Angeles \
    --self "Look over the ticket board and anything left half-finished; if something needs a nudge, say so."
```

- The action is `{ kind: "self", prompt, channelId?, requesterId? }`. `--self` and `--task` are
  mutually exclusive.
- Like `deps-update`, this action **does not go through the browser lane** and carries **no
  credentials**. `buildDispatchPlan` gives it its own `self` lane (no `browserTask`, no
  `depsUpdate`, no `credsEntry`), and the dispatcher forks on that lane *before* it resolves the
  browser agent / agent registry / agent runner at all — so it is structurally impossible for a
  self routine to reach a web session.
- The fire is a single control-bus post (`routine.self`) to the concierge, which frames a **SYSTEM
  turn** and hands it to `askUpdate` — the exact `SYSTEM_SCOPE` lane ticket updates and incoming
  email (`notifyIncomingEmail`) already run on. The prompt is Beckett's *own* text from a routine
  definition, not third-party content, so it needs no untrusted-input quoting — but it is still
  framed as SYSTEM, never as a message from a user. The turn is told it is a scheduled self-directed
  sweep, carries the routine id and the origin channel, and is instructed to report in voice with
  `beckett discord reply --channel <id> "<message>"` **or do nothing** if there is nothing worth
  saying.
- **One fire is one turn.** The lane never loops, retries into a second turn, or schedules anything;
  per-period idempotency in the scheduler is the only fire guard, and that is enough.

`beckett routine fire <id> --dry-run` prints lane `self` and the prompt (the plan is pure — it
wakes nothing). The sweep routine *definitions* are config, created after this ships; this is the
seam that lets a routine wake Beckett at all.
