# The Concierge browser

Beckett's browser lane used to be a dedicated agent: first the quick-lane computer-use seat,
then the v5.4 background browser agent (issue #58) — either way a blind `claude -p` child with
one BetterWright code tool, an isolated bubblewrap host, and an elaborate
screenshot-question/park/resume/proof pipeline so the sub-agent could reach a human. It worked,
but it had no shared context — when someone asked "how is that browser task going", the
Concierge knew nothing, because the browsing happened in another model's transcript.

Since v5.10 the Concierge drives the browser itself.

## Design

`beckett browser <command…>` is a passthrough (`src/browser/cli.ts`) to the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI (Apache-2.0, Vercel Labs): a
native Rust daemon owns a real Chrome and persists it between CLI invocations. Each command —
`open`, `snapshot -i`, `click @e3`, `fill`, `get text`, `screenshot`, `eval` — is one quick
Bash call from the Concierge's own session.

That single shape change buys every property the old lane engineered by hand:

- **Context & adaptivity** — the Concierge sees each accessibility snapshot and reacts in its
  own turn, with everything it knows about the person and the conversation.
- **Observability** — "how's it going" is answerable from the Concierge's own context, or live
  via `beckett browser get url` / `screenshot`, because the daemon holds the page state
  independent of any turn.
- **Parallelism** — browser state lives outside the turn, so the Concierge batches browser
  work, replies to people between batches, and never blocks other channels (the turn-gate
  semantics are unchanged). Independent jobs run under `--session <name>` with their own
  browser and profile.
- **Human-in-the-loop** — a blocking question is just a channel message now. The entire atomic
  screenshot-question ledger, reply-consumption, tombstone, and proof-outbox machinery is
  retired with the sub-agent that needed it.
- **Routines** — a scheduled fire arrives as a Concierge update turn naming the task and the
  jingle creds entry; the same brain that talks to people runs the scheduled browser job.

The passthrough injects (via agent-browser's documented environment variables, so explicit
flags always win): the default session (`[browser] session`, "beckett"), a persistent
per-session profile dir (`~/.beckett/browser/profiles/<session>` — cookies and signed-in state
survive restarts, and parallel sessions never share a live Chrome profile), and an idle
timeout (`[browser] idle_timeout_secs`) so an abandoned daemon shuts itself down.

Doctrine lives in the `browse` skill; agent-browser additionally ships version-matched usage
skills the Concierge loads on demand (`beckett browser skills get core`).

## Trust boundary

Unchanged in substance: everything running as the `beckett` Unix user is one trusted computing
base, and Chromium has ordinary network access. What changed is that the browser's operator is
now the Concierge itself rather than a disposable model-code evaluator, so the bubblewrap
host, prlimit budgets, and capability-token lease around it are gone along with the evaluator.
Webpage text remains untrusted data; secrets flow through the `jingle` vault, and the browse
skill keeps the ask-before-irreversible rules. Run Beckett on a dedicated machine, not a
multi-tenant host.

## References

- agent-browser: <https://github.com/vercel-labs/agent-browser> (docs: <https://agent-browser.dev>)
- The retired dedicated-agent design is preserved in git history
  (`docs/design/browser-agent.md` before v5.10) and its live eval in
  `docs/evals/browser-agent-gpt-5.6.md`.
