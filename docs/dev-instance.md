# Beckett [DEV] — the staging/testing instance

A second Beckett daemon runs on loom-desk as the dedicated staging/testing instance. It logs into
Discord as the **`Beckett [DEV]`** bot (user id `1527859594741682347`, reusing the ex-Callie token),
runs from its **own checkout** at `~/beckett-dev`, and keeps **all of its state** under
`~/.beckett-dev`. It is deliberately inert and fully isolated from production — see
[Isolation](#isolation) below.

Production (`beckett-v4.service`, bot id `1520212392733048873`, state in `~/.beckett`) is
**unaffected** by any of this: DEV has its own unit, its own env file, its own state dir, and its own
project root. The two never share a file.

## Layout

| Thing | Production | DEV |
|---|---|---|
| systemd unit | `beckett-v4.service` (enabled at boot) | `beckett-dev.service` (**installed, not enabled** — on demand) |
| checkout (`WorkingDirectory`) | `~/beckett` | `~/beckett-dev` |
| state dir (`BECKETT_DIR`) | `~/.beckett` | `~/.beckett-dev` |
| env file | `~/.beckett/.env` | `~/.beckett-dev/.env` |
| worker repos (`BECKETT_PROJECTS_ROOT`) | `~/Projects` | `~/.beckett-dev/projects` |
| Discord bot | Beckett (`1520212392733048873`) | Beckett [DEV] (`1527859594741682347`) |

## Operating it

The unit is a normal `systemd --user` service; there is no bespoke tooling.

```sh
# START (on demand — DEV is never enabled at boot)
systemctl --user start beckett-dev

# STATUS / is it enabled? (expect: active, and "disabled")
systemctl --user status beckett-dev
systemctl --user is-enabled beckett-dev        # -> disabled

# TAIL logs (its own journal; nothing lands in prod's log channel)
journalctl --user -u beckett-dev -f
journalctl --user -u beckett-dev -n 200 --no-pager

# Confirm it logged in as Beckett [DEV] (bot id 1527859594741682347)
journalctl --user -u beckett-dev --no-pager | grep -i 'ready\|logged in\|gateway'

# STOP
systemctl --user stop beckett-dev
```

`beckett` CLI commands that talk to the DEV daemon must point at its state dir so they reach the DEV
control socket, e.g.:

```sh
BECKETT_DIR=~/.beckett-dev bun ~/beckett-dev/src/cli/beckett.ts status
BECKETT_DIR=~/.beckett-dev bun ~/beckett-dev/src/cli/beckett.ts routine list   # -> empty (all off)
```

## Redeploying DEV (pull new code)

DEV runs from its own checkout, so a redeploy is a pull + restart. The daemon's own graceful-shutdown
drain runs on `stop`.

```sh
systemctl --user stop beckett-dev
git -C ~/beckett-dev pull --ff-only
( cd ~/beckett-dev && bun install --frozen-lockfile )
systemctl --user start beckett-dev
```

If the unit file, staging config, peer list, or routine seed changed in the repo, re-run the seeder
(idempotent; it re-copies `deploy/dev/*` into `~/.beckett-dev`, refreshes the unit, and
`daemon-reload`s — it never prints a secret and never touches `~/.beckett`):

```sh
~/beckett-dev/deploy/dev/seed.sh        # or deploy/dev/seed.sh from any checkout of the repo
systemctl --user restart beckett-dev
```

## First-time setup

Run the seeder once (see `deploy/dev/seed.sh`). It clones `~/beckett-dev`, seeds `~/.beckett-dev`
from `deploy/dev/{config.toml,peers.txt,routines.json}`, writes `~/.beckett-dev/.env` (sourcing the
DEV bot token from prod's `CALLIE_DISCORD_TOKEN` and the owner id from prod's `DISCORD_OWNER_ID`
without ever printing them), and installs the unit **without enabling it**.

## Isolation

DEV is structurally incapable of reaching into production:

- **State** — `BECKETT_DIR=~/.beckett-dev` relocates the db, events, logs, memory, socket, config,
  `.env`, dispatch/resume ledgers, and board/tracker state under `~/.beckett-dev`
  (`resolveBeckettDir`, `src/paths.ts`). Nothing reads or writes `~/.beckett`.
- **Worker repos** — `BECKETT_PROJECTS_ROOT=~/.beckett-dev/projects` (the one root that does *not*
  follow `BECKETT_DIR`, `src/shell/main.ts`) points staging workers away from prod's `~/Projects`,
  so a DEV worktree can never collide with a production one. `BECKETT_HOME=~/.beckett-dev` relocates
  `paths.projects` too.
- **Board / tracker** — the board is NOT under `BECKETT_DIR`; it is an HTTP endpoint
  (`BECKETT_BORED_URL`, default `127.0.0.1:7770` = prod's shared bored). The unit points DEV at a
  loopback port with **no listener** (`127.0.0.1:7788`), so DEV never reads or dispatches the prod
  board — the poller primes nothing and the dispatcher stays a no-op, which is also why "concurrency
  1 + separate projects dir" is enough to guarantee no collision with a production worker.
- **Scheduled routines are all OFF** — `~/.beckett-dev/routines.json` lists every built-in in
  `removedBuiltins`, so none seed and none fire. In particular the X posting / model-news routines
  never run in DEV, so they cannot double-post to the real public account.
- **No narration into prod's channels** — no announce channel (`announce.changes_channel_id = ""`),
  no log-mirror channel (`DISCORD_LOG_CHANNEL_ID` unset), and no alert webhook
  (`DISCORD_ALERT_WEBHOOK_URL` unset; the unit wires no `OnFailure`/`ExecStopPost` alert). The boot
  banner and the status/cards dashboard are suppressed with `BECKETT_STARTUP_CHANNEL_ID=disabled`
  and `BECKETT_CARDS_CHANNEL_ID=disabled` — the cards channel was a raw hardcoded prod snowflake, so
  #141 added the `BECKETT_CARDS_CHANNEL_ID` env seam (with a `disabled` sentinel) it now honors.
- **Concurrency capped at 1** — `[concurrency] max_workers = 1` so a staging worker cannot starve a
  production worker on this shared 4-core box.
- **Deploy & self-restart disabled** — no `CLOUDFLARE_*` in the DEV env, so `beckett deploy`/`dns`
  are unavailable; the deps-update routine (the only autonomous self-repo PR path) is off and DEV
  holds no working `GITHUB_PAT`.
