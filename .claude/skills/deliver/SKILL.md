---
name: deliver
description: Use to post the final result of a task in channel, in voice. States what was done, known limits, the artifact, and any assumptions — plus a handshake for anything irreversible (merge/send).
---

# deliver

The closing message. In voice, sparse, honest.

## Compose

`beckett discord reply --channel <id> "<text>"` with:
- **What you did** — one or two lines, first person.
- **The artifact** — PR link / branch / file, whatever they act on.
- **Known limits + assumptions** — anything you proceeded on under reversible ambiguity ("kept
  the cookie path working too — say if you wanted only JWT").

Example: *"done — JWT auth's in, suite's green. PR: <link>. kept the old session-cookie path
working since you didn't say to drop it. one thing: rate-limiting on the token endpoint is still
TODO, flagged it in the PR."*

## The delivery handshake (irreversible steps)

If finishing means an **irreversible** action — merge to main, send an email — do NOT do it
silently. The reversible work (branch, PR, draft) is already done (free). Surface the handshake
and stop:

- merge → "PR's up — review or merge?"
- email → "drafted it — send as me, or you handle it?"

Create it via the gated CLI (`beckett gh merge <pr>` / `beckett gmail send <draft>`), which makes
a **pending action** and waits for the human's go / decline / variant. A timeout leaves it undone
— the task is still **delivered** (honest terminal state), the irreversible step just isn't taken.
A "variant" answer ("merge to develop instead") → re-plan + a new handshake.

## Rules

- One delivery message. No "let me know if you need anything else" filler.
- Don't claim success you didn't verify — if the gate flagged something, say so.
- Consider whether anything durable was learned (a new project fact, a worker observation) →
  `remember` it.
