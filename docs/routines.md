# Routines — humanized recurring tasks (issue #62)

A **routine** is a named, recurring scheduled task whose fire time is *humanized*, not a
clockwork cron tick. Instead of firing at exactly 12:00 every day, a routine fires at a random
minute inside a **window** — e.g. somewhere in `12:00–13:00 America/Los_Angeles`, so one day
it's 12:07 and the next it's 12:41. The point is human-irregular timing.

## Model

Each routine has:

- an **id / name** (kebab-case, e.g. `daily-x-shitpost`),
- an **action** — what to run when it fires (always dispatched OFF the scheduler process
  through the `beckett browser` background lane; never inline),
- a **schedule** = a base **cadence** (`daily` today; the union in
  [`src/routine/types.ts`](../src/routine/types.ts) is the seam for `weekly` / `interval`)
  plus a **fuzz window** (`start`–`end` wall-clock in a named IANA timezone).

Each period the scheduler picks one concrete fire time **uniformly at random inside the
window** and fires exactly once.

## Persistence & restart safety

Routine definitions and the current period's already-chosen fire time persist to
`<beckettDir>/routines.json` (atomic tmp+rename, same discipline as the task registry). On a
daemon restart:

- the day's chosen time is **restored verbatim** — it is *not* re-rolled, and
- firing is **idempotent per period** via a `lastFiredPeriodKey`, so a restart mid-window
  neither double-fires nor loses a due fire (it catches up once).

The scheduler claims the period on disk *before* dispatching, so a crash mid-dispatch can never
double-post.

## The RNG is testable

The fuzz randomness is injectable (`rng: () => number`). Tests feed a seeded PRNG
(`seededRng` in [`src/routine/compose.ts`](../src/routine/compose.ts)) to prove both that the
chosen minute *varies run-to-run* and that a given seed reproduces a run deterministically. See
[`src/routine/schedule.test.ts`](../src/routine/schedule.test.ts) and
[`scheduler.test.ts`](../src/routine/scheduler.test.ts).

## CLI

```
beckett routine list                       # every routine + its next concrete fire time
beckett routine inspect <id>               # full detail incl. persisted state
beckett routine add <id> --window 09:00-09:40 --tz America/New_York \
    --task "<self-contained browser task>" [--name <n>] [--creds <jingle-entry>] [--channel <id>]
beckett routine remove <id>                # a removed built-in stays removed across restarts
beckett routine enable|disable <id>
beckett routine fire <id> --dry-run        # compose + build the dispatch plan, POST NOTHING
beckett routine fire <id> --force          # real, live dispatch through the browser lane
```

`add` creates a `browser`-action routine that runs an arbitrary self-contained task each period.

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
