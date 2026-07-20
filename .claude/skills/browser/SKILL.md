---
name: browser
description: Use for ANY browser / computer-use work — a live-site lookup, a signup, a login-and-do-something. Dispatches the dedicated BACKGROUND browser agent via `beckett browser` and returns instantly; the agent pauses for human input mid-run (verification codes, choices) and resumes, credentials injected from the jingle keychain without ever touching a transcript.
---

# browser — the background browser agent

Browser work never runs in your own turn and never in the quick lane. One dispatch command
hands the whole job to a dedicated, stateful background agent driving Beckett's persistent
BetterWright browser; you are free the moment the command returns.

## How to dispatch

```
beckett browser "check https://example.com/status — is the API listed as degraded?"
beckett browser "log in to x.com and post the draft thread pinned in the account" --creds x.com
beckett browser status        # live + recent runs
```

- The command returns **immediately** with a run id — your intake turn never blocks on
  browser work. Ack the person, say it's in motion, end the turn.
- Write the task like a good ticket one-liner: everything the agent needs is IN the task
  text (URLs, the actual goal, any email/name to use, what "done" looks like). It knows
  nothing about the conversation.
- The run is locked to the channel of the authorized request that dispatched it; one browser
  run at a time (it holds the exclusive browser lease). "already working" → wait for it.

## Credentials — `--creds <jingle-entry>`

If the task needs a stored login, pass the jingle keychain entry name. The daemon reads the
entry and exposes it to the agent as a read-only `secrets` object *inside the browser scripts*
(`secrets.email`, `secrets.password`, `secrets.totp` minted fresh per script). The values are
injected below every transcript and scrubbed from everything that flows back — never paste a
credential into the task text, and never ask the person to paste one into chat.

No entry yet? Collect one first with a secret-link (`beckett secret request --fields
username,password --dest keychain --entry <name> …` — see the `jingle` skill), then dispatch.

## While it runs: pause / surface / resume

When only a human can unblock it (a 2FA code from their phone, a credential no `secrets`
field covers, a genuine choice), the agent parks the session and posts **one** question in the
origin channel with a page screenshot. The person answers by **replying directly to that
message** — the reply is consumed and deleted (secrets never linger in chat), and the same
browser session resumes where it stalled. You do nothing to broker this; don't re-dispatch
while a run is waiting.

## The outcome

Completion, failure, or timeout arrives back to you as a `browser-agent outcome` update turn —
including after a daemon restart (a durable ledger re-reports anything stranded). Relay it in
your voice with `beckett discord reply --channel <id>`; when the turn names a proof screenshot,
attach it with `--file <path>`. If it failed or timed out, say so plainly so the person can
retry or unblock it.

## When NOT to use

- Anything that isn't actually a browser task — quick lane or a ticket as usual.
- Owner-gated or destructive actions (payments, deletions) the request didn't authorize —
  bring those to the owner first.
