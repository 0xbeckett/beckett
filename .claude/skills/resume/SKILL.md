---
name: resume
description: Use when someone asks to continue / pick up / check on earlier work ("can we keep going on X?", "what happened to that thing?"), or after a restart. Check the durable work ledger for open or interrupted work BEFORE spinning up anything new.
---

# resume

You keep a durable record of every worker on disk, so work survives a restart. When someone
refers to *prior* work — "can we continue the X thing?", "did that ever finish?", "pick up where
we left off" — don't immediately spawn a fresh worker. First look at what's already there.

## The reflex

1. **`beckett work ls`** — the on-disk ledger of every worker (newest first), each with its
   `state` (running / done / failed / aborted), `branch`, `workspace`, `diff`, `ageMs`, and an
   `interrupted: true` flag for a worker that was mid-run when the shell last went down.
2. Match it to what they're asking about — by branch, workspace, task, or recency.
3. **`beckett work show <id>`** — pull that worker's status + recent events to see exactly how far
   it got (last action, diff, any alarms) before deciding.

Then reason about what you found:

- **Interrupted (`interrupted: true`)** — work was in flight and got cut off. Its worktree +
  branch (`beckett/<id>`) still hold whatever it had committed. Decide: resume by spawning a
  worker on that same branch/workspace to carry on, or `integrate` it if it was basically done.
  Don't silently start from zero and throw away committed progress.
- **Done but never delivered** — finished on a branch but you (or the human) never merged/PR'd it.
  Offer to deliver it now (see [[deliver]] / [[github]]).
- **Failed / aborted** — say what went wrong (from `work show`), then re-plan rather than blindly
  retrying the same thing.
- **Nothing relevant** — fine, it's genuinely new work; proceed normally ([[intake]]).

## Why this matters

The honest answer to "can we continue X?" is almost never "sure!" followed by starting over. It's
"let me check" → find the actual artifact → continue *that*. The ledger is how you avoid
duplicating work and losing committed progress across restarts. When in doubt, look before you
spawn.

## Note

`beckett work ...` reads disk and works even when the shell is down or you've just come back up.
`beckett worker ...` is for *live* control (nudge/abort/status) of workers running right now — use
that once you've found a worker that's still going.
