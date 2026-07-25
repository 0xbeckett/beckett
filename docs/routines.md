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
  one local-maintenance action, and it deliberately does not,
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
    --task "<self-contained browser task>" [--weekly <weekday>] [--name <n>] \
    [--creds <jingle-entry>] [--channel <id>]
beckett routine remove <id>                # a removed built-in stays removed across restarts
beckett routine enable|disable <id>
beckett routine fire <id> --dry-run        # compose + build the dispatch plan, POST NOTHING
beckett routine fire <id> --force          # real, live dispatch through the browser lane
```

`add` creates a `browser`-action routine that runs an arbitrary self-contained task each period.
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
- The action runs on the dedicated background browser agent, never in the scheduler process.
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
   check. A red PR is worse than no PR.
5. **Publish a proposal.** `beckett gh push` of a `beckett/deps-update-<date>` branch, then
   `beckett gh pr create --base main`. Never raw `gh`, never `git push`, never a push to `main`, and
   there is no deploy anywhere in the path. The output is a PR a human merges.
6. **Report one line** to `BECKETT_ROUTINE_CHANNEL_ID` (or the routine's `channelId`) with the PR
   link. It runs unattended every week, so it is deliberately terse — one line, always, including
   when it failed and opened nothing.

Anything the ranges refuse — a major-version jump, or an exact pin the package has outgrown, like
`betterwright: "1.1.3"` → 1.3.1 — is reported as **available, not applied**, in both the summary
line and the PR body. Applying it is a human decision.

### Prove the whole job without touching GitHub

```
bun scripts/ops/deps-update-rehearsal.ts [--source <checkout>]
```

Runs the real clone, real update, real typecheck and real test suite, stubbing only the
`beckett gh` calls — and prints the exact argv it *would* have run. Use it before changing the job;
the unit suite ([`src/ops/deps-update.test.ts`](../src/ops/deps-update.test.ts)) covers the same
guarantees with everything injected.
