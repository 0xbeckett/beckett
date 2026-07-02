---
name: supervise
description: Use when a ticket update reports trouble — a stalled worker, a retry, a repeated failure, or a human asking "what's happening with OPS-N?". Read the ticket's real state and pick the lightest sufficient intervention.
---

# supervise

Something on a ticket needs your judgment. The dispatcher already handles the routine ladder
automatically (a quiet worker gets a status-check nudge, then an abort+retry from its committed
WIP; failed implements retry up to 3×; exhausted tickets are parked in `todo` with a comment).
Your job starts where the automation stops: deciding whether the *approach* is wrong, telling the
person honestly what's going on, and using your levers when a different path is needed.

## Look first

1. `beckett ticket show <id>` — accepts `OPS-42` or the uuid. Read `state` and the comment trail:
   the dispatcher narrates every step there (stall nudges, retries, WIP commits, parks, verdicts).
2. `beckett ticket list --state in_progress` (or `in_review`) — the board at a glance when the
   question is "what's running?"
3. `beckett status` — the live daemon in one JSON blob: every worker (ticket, stage, harness, pid,
   elapsed, last-event age), poller health, Plane API health, your own session stats. The fastest
   answer to "is anything actually moving?"
4. The ticket's Discord progress thread mirrors the worker's play-by-play if you need finer grain.

## Your levers (all real commands)

| Lever | When | How |
|---|---|---|
| do nothing | the automation is mid-ladder (nudge/retry already posted) and the approach is sound | — |
| steer | the worker is working on the wrong thing, or you know something it doesn't | `beckett ticket comment <id> "<guidance>"` — a comment on a staffed ticket is delivered to the live worker as a nudge |
| restaff | the worker is wedged/looping and a fresh start (or a different harness) will do better | `beckett ticket restaff <id> [--harness claude\|codex\|pi]` — aborts (WIP committed), spawns fresh |
| park | the ticket needs a human decision before more tokens are spent | `beckett ticket state <id> todo` + a comment saying why |
| cancel | the work is genuinely not wanted | `beckett ticket state <id> cancelled` |

## Rules

- **A stall signal is a prompt to think, not a verdict.** The dispatcher already nudged and will
  retry; only step in when the *pattern* is wrong — same failure across retries, a worker looping
  on the same command, or work drifting off-scope.
- **Prefer nothing > steer > restaff > park > cancel.** Never cheap-stop good work.
- Same problem across several tickets (every worker hitting the same broken tool/login) → that's
  an infrastructure problem, not a per-ticket one: tell the human and park the affected tickets
  rather than burning retries.
- When a person asks about a ticket, answer from `ticket show` — its real state and the last
  dispatcher comment — not from memory.
