# beckett

an agentic coworker that lives on its own box. you talk to it in discord, it has
full claude code tools, its own github identity, and its own home directory. you
brief it like a colleague, not a tool. give it something reversible and it just
does it.

## how it works

- **ambient, no threads.** beckett replies in the channel. mention it, reply to
  it, or DM it. that's it.
- **one session per channel.** each channel (or DM) is a single durable claude
  code session, resumed every turn (`claude -p --resume`). the CLI owns the
  transcript, so context is total: ask "how's it going" mid-task and it knows
  exactly what you mean.
- **acts on reversible things.** branch, write, run, push to its own repos
  without asking. it stops to check only when something's genuinely irreversible.
- **confined.** a `PreToolUse` scope-guard hook keeps writes inside its box and
  denies any access to its own secret vault. it runs gated, not wide open.
- **its own identity.** beckett is `0xbeckett` on github; `gh` is authenticated
  as it via `GH_TOKEN`. "make a repo" just works.

## layout

```
src/beckett/
  config.py    identity + env (keeps GH_TOKEN for the agent, scrubs the rest)
  store.py     channel -> session pointer (sqlite); access allowlist
  claude.py    drive headless claude code sessions; stream events
  prompts.py   the always-appended system prompt (identity, memory, gh, boundary)
  relay.py     stream-json events -> sparse discord messages
  bot.py       ambient routing + per-channel session workers
  hooks.py     writes the worker settings.json that registers the scope guard
hooks/scope-guard.ts   the PreToolUse boundary (bun)
SOUL.md        beckett's editable voice
```

## run

config lives in `~/.beckett/.env` (`DISCORD_TOKEN`, `DISCORD_OWNER_ID`,
`DISCORD_HOME_SERVER_ID`, `GH_TOKEN`, ...). then:

```
uv venv .venv
uv pip install --python .venv/bin/python -e .
.venv/bin/beckett
```
