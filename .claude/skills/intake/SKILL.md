---
name: intake
description: Use the moment a new @beckett mention arrives, before any work. Classify the request, size the effort (inline answer / one ticket / a plan), and for work requests post the fast ack FIRST.
---

# intake

Turn a fresh mention into (1) an effort judgment and (2) the right first move. For work
requests, the first move is an ack — a *receipt, not a promise* — sent before you spend the
turn working.

## Steps

1. **Read the stamp.** Every turn arrives as `[channel:<id>] [user:<id> address:"…" msg:<id>]`.
   The `channel:` id is what you ack to and stamp on any ticket (`--channel`); `address:` is what
   to call them; different `user:` ids are different people.
2. **Classify** the message: `task` (do something), `question` (answer something), `chatter`
   (banter), or `fyi` (no action wanted).
3. **Size it** (doctrine: *Dynamic effort*): answer inline · dispatch a QUICK AGENT (the
   no-ticket lane — see the `quick` skill) · file ONE ticket · `beckett plan` a DAG (rare —
   only genuinely big work with real structure). A 30-second inline scout (Read the
   obviously-relevant files, `recall` the people/projects named) is fine if it changes the call.
   The quick lane is for errands: a live-site lookup (`computer-use`), a small one-off script
   (`quick-code`), a repo summarized (`repo-explorer`). Real work — reviewable, multi-file,
   project-repo — is still a ticket.
4. **Move:**
   - `question`/`chatter` → just reply; your turn text auto-sends. Do NOT run
     `beckett discord reply` — that double-posts.
   - errand → ack first (same as a task — quick runs take minutes), then
     `beckett quick <agent> "<task>" --channel <id>`, then relay the report with a second
     `beckett discord reply` (your CLI ack claimed this turn's reply, so plain turn text
     won't post). If it answers "detached", the ack already covers it — end the turn; the
     result comes back to you as an update turn.
   - `task` → **ack FIRST**: `beckett discord reply --channel <id> "<one honest line>"` before any
     recall/ticket work, so they hear from you in seconds. Then file the ticket and end the turn
     with no further message — the machinery guarantees the ack was your one reply, and progress
     threads + the done ping carry the rest.
   - Honest ack phrasing: filing a ticket queues the work (the dispatcher picks it up within
     seconds) — say "on it — queuing the JWT swap now", not "the tests are running", which isn't
     true yet.
5. If there's **irreversible/consequential ambiguity**, ask the ONE clarify question instead of
   acking a direction you might have wrong. Don't file a vague ticket — a bad ticket wastes a
   worker.

## Rules

- Receipt, not a promise: don't over-claim scope or timing.
- No filler ("let me think about that"). If it's a plan, say the read ("this touches auth + the
  client + migrations — splitting it into three tickets") and file it.
- One ack. Further messages only when something changed or you need input.
