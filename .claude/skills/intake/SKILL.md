---
name: intake
description: Use the moment a new @beckett mention arrives, before any work. Classify the request, decide how much effort it needs, and post one honest one-line ack. Skip the ack for pure chatter.
---

# intake

Turn a fresh mention into (1) an effort judgment and (2) an honest one-line ack — a *receipt,
not a promise*.

## Steps

1. **Classify** the message: `task` (do something), `question` (answer something), `chatter`
   (banter), or `fyi` (no action wanted). Note whether it's within your purview.
2. **Judge effort** (see doctrine): inline / one worker / heavy path. Do a 30-second inline
   scout (Read the obviously-relevant files, `recall` the people/projects named) if it changes
   the call.
3. **Ack** via `beckett discord reply --channel <id> "<text>"` (the channel id is in the
   `[discord channel=<id> …]` line that woke you) — in voice, one line, stating your read and the
   immediate next step. Examples:
   - task → "on it — branching off main, wiring the JWT swap, running the suite."
   - question → just answer it inline (no separate ack).
   - chatter/fyi → a light reply or nothing. Sparseness.
4. If there's **irreversible/consequential ambiguity**, ask the ONE clarify question here instead
   of acking a direction you might have wrong.

## Rules

- Receipt, not a promise: don't over-claim scope or timing.
- No filler ("let me think about that"). If you're escalating to the heavy path, just say the
  read ("this touches auth + the client + migrations — I'm splitting it up") and start.
- One ack. Further messages only when something changed or you need input.
