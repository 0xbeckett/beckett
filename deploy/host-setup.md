# Beckett host setup (manual/advanced)

The supported fresh-host path is the repository-root `install.sh`; it performs these steps
idempotently and stages the service until credentials are ready. This document keeps the manual
recovery/operator path. The long-form history of the original host lives in
`my-docs/loom-desk-setup-log.md`.

Host requirements: Ubuntu 22.04, 24.04, or 26.04, or Debian 12 or 13, with systemd, x64/arm64,
4 GB RAM, and 5 GB free disk. The public installer also installs `sudo` so its printed operator
commands work on minimal root-first Debian images.

## 1. OS user + lingering

```bash
sudo useradd -m -s /bin/bash beckett
sudo loginctl enable-linger beckett          # user units run without an open session
```

Do not give this account unrestricted passwordless sudo on a public/shared host: every model
worker runs with the account's privileges. Install host-level tools as an administrator instead.

## 2. The Concierge browser (agent-browser)

Beckett drives a real browser itself through the agent-browser CLI (`beckett browser …`,
Apache-2.0, vercel-labs/agent-browser). A native daemon owns the browser and persists it between
CLI invocations; per-session profiles live under `~/.beckett/browser/profiles/<session>` so
cookies and signed-in state survive daemon restarts. The deploy script runs
`agent-browser install` (Chrome for Testing under the beckett account; an existing
Chrome/Chromium is auto-detected) and then the end-to-end check:

```bash
sudo -u beckett -H bash -lc 'cd ~/beckett && bun run browser:smoke'
```

The daemon idles out after `[browser] idle_timeout_secs` (default 30 minutes), taking its
Chrome with it; the next `beckett browser` command restarts both transparently.

There is no bubblewrap/prlimit sandbox around the browser anymore: the browser is operated by
the Concierge itself (the same trust domain as every other `beckett` process), not by a
disposable model-code evaluator. Chromium has ordinary network access, and everything running
as the `beckett` Unix user remains one trusted computing base — keep Beckett on a dedicated
machine rather than a multi-tenant host, exactly as before. Secrets belong in the `jingle`
vault flow, never in channel text; blocking questions are ordinary channel conversation now
(the atomic screenshot-question ledger and its Manage Messages requirement are retired).

## 3. Toolchain (as `beckett`)

Node 24 LTS under `~/.local/bin`, Bun under `~/.bun/bin`, the native `claude` and `codex`
installers, Pi's current `@earendil-works/pi-coding-agent` package, plus `gh`, `rg`, `fd`, and
`jq`. The public installer uses vendor-supported install paths and verifies Node's published
SHA256 before extraction. Cloudflared is optional.

## 4. Credentials (from the encrypted backup — never in git)

| File | What |
|---|---|
| `~/.beckett/.env` | `DISCORD_TOKEN`, `GITHUB_PAT`, `DISCORD_ALERT_WEBHOOK_URL`, … — the committed `.env.example` is the full inventory with per-key mint/scope notes (`beckett doctor` flags drift) |
| `~/.claude/.credentials.json` | claude subscription login |
| `~/.codex/auth.json` | codex ChatGPT login |
| `~/.pi/agent/auth.json` | pi OAuth login |
| `~/.beckett/config.toml` | runtime overrides (validated strict — prune keys when the schema prunes; `deploy/config.toml.example` = every key at its default) |

### The encrypted backup (issue #34)

All five files are backed up age-encrypted to the **Mac** (`~/.beckett-backups/`); the age private
key (`~/.config/age/beckett-backup.key`) exists ONLY there. Backups are deliberately not committed
— this repo is public, and public git history is forever.

- **After any secret change** (rotation, new key), from the Mac: `./deploy/backup-secrets.sh`
  (pulls, encrypts, and decrypt-verifies in one step).
- **Restore onto a fresh box**, from the Mac:

  ```bash
  age -d -i ~/.config/age/beckett-backup.key \
    ~/.beckett-backups/beckett-secrets-<newest>.tar.age | ssh beckett@HOST 'tar -x -C ~'
  ```

  Then continue at step 5 below. A from-scratch environment is `git clone` + this one command +
  `./deploy/install.sh` — zero source-reading.

## 5. Clone + units

```bash
git clone https://github.com/0xbeckett/beckett.git ~/beckett
cd ~/beckett && bun install --frozen-lockfile
./deploy/install.sh --no-start  # links units and keeps any existing daemon disabled/stopped
# After credentials are ready:
./deploy/install.sh
```

### Tracker (bored)

Beckett files, steers, and completes every ticket through the [bored](https://github.com/frgmt0/bored)
tracker, so a box with no tracker has a bot that chats but can never ship. The public `install.sh`
provisions it automatically; on a hand-built box, install it the same way bored's own installer
does — clone, build, and enable a loopback `bored.service` user unit. `--worker /bin/false` with
`--max-workers 1` keeps bored a pure ticket store: Beckett drives every worker itself over the
control bus, never through bored's seat runner.

```bash
git clone https://github.com/frgmt0/bored.git ~/bored
~/bored/scripts/install-systemd-user-service.sh \
  --source ~/bored --repo ~/beckett --root ~/.local/state/bored \
  --port 7770 --worker /bin/false --max-workers 1 --owner-dm owner --start
curl -fsS http://127.0.0.1:7770/health   # {"ok":true}
```

The port must match `BECKETT_BORED_URL` (default `http://127.0.0.1:7770`). Re-running the script
rebuilds the checkout and rewrites `~/.config/bored/bored.env` in place; `beckett doctor`'s
`tracker: bored` check reports whether the live daemon can reach it.

## Ops visibility (issue #30)

- `bun src/cli/beckett.ts status --pretty` — what the live daemon is doing right now.
- `bun src/cli/beckett.ts doctor` — would Beckett work right now (binaries under the daemon PATH,
  live token probes, env drift, leaked worker processes)? Non-zero exit on any failing check.
- Crash alerts: every unclean unit death posts to `DISCORD_ALERT_WEBHOOK_URL` via `deploy/alert.sh`
  (rate-limited); a crash loop past the start limit fires `beckett-alert@<unit>` and stays down.
- `beckett-heartbeat.timer` posts a weekly doctor report — silence in the alert channel means
  healthy, not "alerting is broken too".

## 6. Deploys

From the Mac, after a PR merges to main:

```bash
./deploy/deploy-prod.sh
```

That is the entire deploy story: ff-only pull of origin/main → `bun install` → typecheck gate →
restart → health read-back → version tag. It refuses a dirty checkout by design.

**Rolling back across the v4 rename** (v4.0.0 renamed the unit `beckett-v3` → `beckett-v4`; the
unit symlinks point INTO the repo, so a checkout of an older release dangles the v4 unit): on the
box, `systemctl --user stop beckett-v4.service` **first** — the old release's `install.sh`
predates beckett-v4 and will not stop it, so skipping this step leaves two daemons on one Discord
token — then `git checkout v<previous>` in `~/beckett`, `bun install --frozen-lockfile`, and run
that checkout's `./deploy/install.sh` (re-links and starts the old unit). Rolling forward again is
just `./deploy/deploy-prod.sh` (its install-guard heals the unit rename cutover automatically).

## Clone roles (the anti-drift contract)

| Clone | Role | Rule |
|---|---|---|
| `beckett@loom-desk:~/beckett` | **deploy checkout** — what systemd runs | never edited by hand, never by workers; only `deploy-prod.sh` touches it |
| `beckett@loom-desk:~/Projects/<slug>` | worker checkouts (one per ticket project) | Beckett's own repo included: self-improvement tickets run in `~/Projects/beckett` and flow through PRs to `origin main` like everything else |
| dev clones (Mac, claude@loom-desk) | humans + interactive agents | short-lived feature branches off main, pushed same-day; no version-named long-lived branches |

Version identity: `package.json` is the ONE source (`BECKETT_VERSION` reads it); bump it with the
CHANGELOG in the PR; `deploy-prod.sh` tags `v<version>` at deploy.
