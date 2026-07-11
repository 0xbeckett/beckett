# Beckett host setup (manual/advanced)

The supported fresh-host path is the repository-root `install.sh`; it performs these steps
idempotently and stages the service until credentials are ready. This document keeps the manual
recovery/operator path. The long-form history of the original host lives in
`my-docs/loom-desk-setup-log.md`.

Host requirements: Ubuntu 20.04+ or Debian 10+ with systemd, x64/arm64, 4 GB RAM, and 5 GB free
disk. The public installer also installs `sudo` so its printed operator commands work on minimal
root-first Debian images.

## 1. OS user + lingering

```bash
sudo useradd -m -s /bin/bash beckett
sudo loginctl enable-linger beckett          # user units run without an open session
```

Do not give this account unrestricted passwordless sudo on a public/shared host: every model
worker runs with the account's privileges. Install host-level tools as an administrator instead.

## 2. Optional kernel knob for Codex's bwrap sandbox (Ubuntu 24.04)

The shipped Codex worker defaults to `danger-full-access` and does not need this. Only make this
host-wide AppArmor change if you deliberately switch Codex back to `workspace-write` and accept
the security tradeoff:

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-beckett-userns.conf
sudo sysctl --system
```

## 3. Toolchain (as `beckett`)

Node 24 LTS under `~/.local/bin`, Bun under `~/.bun/bin`, the native `claude` and `codex`
installers, Pi's current `@earendil-works/pi-coding-agent` package, plus `gh`, `rg`, `fd`, and
`jq`. The public installer uses vendor-supported install paths and verifies Node's published
SHA256 before extraction. Cloudflared is optional.

## 4. Credentials (from the encrypted backup — never in git)

| File | What |
|---|---|
| `~/.beckett/.env` | `DISCORD_TOKEN`, `PLANE_API_TOKEN`, `GITHUB_PAT`, `DISCORD_ALERT_WEBHOOK_URL`, … — the committed `.env.example` is the full inventory with per-key mint/scope notes (`beckett doctor` flags drift) |
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
