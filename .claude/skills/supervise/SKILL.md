---
name: supervise
description: Use when the shell wakes you with a worker signal (smoke-alarm, check-in, or worker-finished). Read the digest and decide the lightest sufficient intervention.
---

# supervise

A signal woke you. Decide what to do about a running (or finished) worker — the lightest move
that's right.

## Steps

1. `worker_status { workerId }` → the digest: turns, last action, diff stats, fired alarms,
   criteria summary, envelope, blocked-on.
2. Only if the digest is ambiguous: `read_worker_log { workerId, lastTurns: 5 }` for a slice.
3. Decide one action, with a one-line first-person reason:

| Action | When | How |
|---|---|---|
| `continue` | making real progress, alarm is a false positive | do nothing |
| `reschedule` | fine, but worth re-checking later | `schedule_checkin { workerId, afterTurns\|afterSecs, reason }` |
| `nudge` | drifting/missing something, but the work is salvageable | `nudge_worker { workerId, text }` (lands next turn for Claude; next resume for codex/pi) |
| `pause` | you need to inspect before deciding | stop it, look, then resume or abort |
| `abort` | genuinely off the rails (wrong scope, rewriting what it doesn't own, stuck rut) | `abort_worker { workerId, reason }` then re-dispatch from the node |

## Rules

- **A smoke-alarm is a prompt to think, not a verdict.** Over-envelope + real progress →
  `continue`. Zero diff progress or repeated identical tool calls → look, then usually `nudge`.
- **Prefer continue/reschedule > nudge > pause > abort.** Never cheap-stop good work.
- A `scope_violation` alarm means the scope-guard hook already *blocked* a bad write — the worker
  is contained; decide whether to nudge it back on track or re-scope.
- If finished (`finished` signal): move to `review`.
- If you're seeing the same problem across many workers or retries, consider self-halt (doctrine).
