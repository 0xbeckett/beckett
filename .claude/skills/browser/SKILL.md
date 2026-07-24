---
name: browser
description: Use for ANY browser / computer-use work — a live-site lookup, a signup, a login-and-do-something. Long tasks go to the dedicated BACKGROUND browser agent via `beckett browser` (watch it, steer it mid-run, stop it); a genuinely one-shot read can run inline via `beckett browser exec` while the browser is idle. Credentials inject from the jingle keychain without ever touching a transcript.
---

# browser — the browser lane

Two ways in, one persistent BetterWright browser:

- **Background agent** (`beckett browser "<task>"`) — the default for anything with more than
  one step, anything needing credentials, and anything that might take a while. Dispatches a
  dedicated stateful agent and returns instantly.
- **Inline one-off** (`beckett browser exec "<js>"`) — ONE BetterWright script in your own
  turn, for a quick read of a live page when the browser is idle. No agent, no credentials.

## Dispatching the background agent

```
beckett browser "check https://example.com/status — is the API listed as degraded?"
beckett browser "log in to x.com and post the draft thread" --creds x.com \
  --context "Jason wants the thread up before 9am ET; casual tone; this is the account's first post today"
beckett browser status        # live + recent runs (state, task, parked question)
```

- The command returns **immediately** with a run id — your intake turn never blocks on
  browser work. Ack the person, say it's in motion, end the turn.
- Write the task like a good ticket one-liner: everything the agent needs is IN the task
  text (URLs, the actual goal, any email/name to use, what "done" looks like).
- `--context "<background>"` carries conversation color the agent should know but not treat
  as instructions — who asked, preferences, constraints, what was already tried. Use it
  whenever the conversation holds facts that would change how a competent human did the task.
- The run is locked to the channel of the authorized request that dispatched it; one browser
  run at a time drives the browser (it holds the exclusive browser lease).
- **Browser already busy?** Dispatch anyway — a dispatch always succeeds. If another run
  holds the browser, the return says the run is queued (with its position), and it starts
  AUTOMATICALLY the moment the current run finishes — surviving even a daemon restart. Reply
  now, in voice, that theirs is lined up and will start on its own; never make them wait in
  silence, never tell them to re-ask, and never re-dispatch the same task. A queued run can
  still be `watch`ed (state `queued`), `steer`ed (the note folds into its start), or
  `stop`ped before it ever runs.

## Observing and steering a live run

You are not blind while it works:

```
beckett browser watch <run-id>                 # state + activity journal + fresh page screenshot
beckett browser watch <run-id> --no-screenshot --tail 40
beckett browser steer <run-id> "use the annual plan, not monthly — the person just corrected it"
beckett browser stop  <run-id> --reason "person cancelled the request"
```

- **watch** returns the run's journal (every browser evaluation with the active page URL,
  questions, steers) and, while the run is live, a screenshot path — Read it to see the page,
  or attach it to Discord with `beckett discord reply --file <path>`. Use it when someone asks
  "what's it doing?", or before steering.
- **steer** delivers guidance into the agent's next tool result mid-run. If the run is parked
  on a question, steering resumes it with your note instead (the agent re-asks if still
  blocked). Steer when the person changes their mind, adds a constraint, or you can see from
  `watch` that it's going down the wrong path. Same-channel only.
- **stop** kills the run cleanly (state `cancelled`), releases the browser, and still reports
  an outcome turn. Use for "never mind", or a run visibly stuck/wrong beyond steering.

## Credentials — `--creds <jingle-entry>`

If the task needs a stored login, pass the jingle keychain entry name. The daemon reads the
entry and exposes it to the agent as a read-only `secrets` object *inside the browser scripts*
(`secrets.email`, `secrets.password`, `secrets.totp` minted fresh per script). The values are
injected below every transcript and scrubbed from everything that flows back — never paste a
credential into the task text, and never ask the person to paste one into chat.

No entry yet? Collect one first with a secret-link (`beckett secret request --fields
username,password --dest keychain --entry <name> …` — see the `jingle` skill), then dispatch.

Credentials are background-lane only: `exec` scripts get no `secrets` object.

## Inline one-offs — `beckett browser exec`

For a single quick read ("is the site up?", "what does this page say right now?") you can
drive the persistent browser yourself, one script per command:

```
beckett browser exec "await page.goto('https://example.com/status'); return snapshot()"
```

The script is ordinary BetterWright JavaScript with top-level `await`: `page`, `pages`,
`openPage(url?, options?)`, `usePage()`, `closePage()`, `snapshot()` (compact ARIA with
`[ref=eN]` markers; `snapshot({ interactive: true })` for just the actionable elements),
`screenshot({ kind, name })`, `human`, `dialogs`, `captcha`. Act on a ref with
`page.locator('aria-ref=eN')`. Return plain data. Screenshot paths come back in the result —
Read one to see it, or attach with `--file`.

Rules of the inline lane:
- Idle browser only — it refuses while a background run holds the lease (watch/steer that
  run instead).
- One script, then the lease releases. If you're about to chain several `exec` calls or need
  a login, that's a background dispatch, not an inline errand.
- No credentials, no destructive actions — reads and trivial reversible clicks only.

## While it runs: pause / surface / resume

When only a human can unblock it (a 2FA code from their phone, a credential no `secrets`
field covers, a genuine choice), the agent parks the session and posts **one** question in the
origin channel with a page screenshot. The person answers by **replying directly to that
message** — the reply is consumed and deleted (secrets never linger in chat), and the same
browser session resumes where it stalled. You do nothing to broker this; don't re-dispatch
while a run is waiting. If their message is guidance rather than a reply to the question,
relay it with `beckett browser steer`.

## The outcome

Completion, failure, cancellation, or timeout arrives back to you as a `browser-agent outcome`
update turn — including after a daemon restart (a durable ledger re-reports anything stranded).
Relay it in your voice with `beckett discord reply --channel <id>`; when the turn names a proof
screenshot, attach it with `--file <path>`. If it failed or timed out, say so plainly so the
person can retry or unblock it.

## When NOT to use

- Anything that isn't actually a browser task — quick lane or a ticket as usual.
- Owner-gated or destructive actions (payments, deletions) the request didn't authorize —
  bring those to the owner first.
