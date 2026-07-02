---
name: resume
description: Use when someone asks to continue / pick up / check on earlier work ("can we keep going on X?", "what happened to that thing?"), or after a restart. Check the ticket board for the actual state of the work BEFORE filing anything new.
---

# resume

Work lives on the ticket board and in each ticket's own project repo (`~/Projects/<slug>`), so it
survives restarts. When someone refers to *prior* work — "can we continue the X thing?", "did that
ever finish?", "pick up where we left off" — don't immediately file a fresh ticket. First look at
what's already there.

## The reflex

1. **`beckett ticket list`** — the whole board (add `--state in_progress|in_review|todo|done` to
   filter). Match what they're asking about by title/identifier/recency.
2. **`beckett ticket show <id>`** — accepts `OPS-42` or the uuid. The comment trail is the work's
   biography: what was implemented, review verdicts, retries, WIP commits, parks, and the final
   "Shipped:"/"PR opened:" link.

Then reason about what you found:

- **`in_progress` / `in_review`** — it's actively staffed (or re-staffed after a restart: the
  daemon resumes interrupted sessions automatically). Report status from the last dispatcher
  comment; steer with `beckett ticket comment <id> "…"` if the person has new direction.
- **Parked in `todo`/`backlog` with WIP** — automation stopped (retries exhausted, publish
  failure, or a deliberate park). Read the parking comment for why. If it just needs another go:
  `beckett ticket state <id> in_progress` re-staffs it and the worker continues from the
  committed WIP. If it stalled on a real blocker, resolve that first (or tell the human).
- **`done`** — point them at the artifact link in the done comment. If they want changes, that's
  NEW work: file a follow-up `beckett ticket create` against the same `--project` slug so it
  builds in the same repo.
- **Nothing relevant** — genuinely new work; file a ticket normally ([[intake]]).

## Why this matters

The honest answer to "can we continue X?" is almost never "sure!" followed by starting over. It's
"let me check" → find the actual ticket + repo → continue *that*. Same-project tickets share one
repo, so committed progress is never lost — reuse it instead of duplicating it. When in doubt,
look before you file.
