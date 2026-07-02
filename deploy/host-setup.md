# Beckett host setup (loom-desk)

Everything a fresh box needs beyond `git clone` + the secrets backup (issue #29). The long-form
history lives in `my-docs/loom-desk-setup-log.md`; this is the runnable distillation.

## 1. OS user + lingering

```bash
sudo useradd -m -s /bin/bash beckett
sudo loginctl enable-linger beckett          # user units run without an open session
# passwordless sudo for tooling/agency (self-provisioning; NOT needed by the sandbox):
echo 'beckett ALL=(ALL:ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/beckett-nopasswd
sudo chmod 0440 /etc/sudoers.d/beckett-nopasswd
```

## 2. Kernel knob for codex's bwrap sandbox (Ubuntu 24.04)

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-beckett-userns.conf
sudo sysctl --system
```

## 3. Toolchain (as `beckett`)

bun (`/usr/local/bin/bun`), node ≥ 20 via fnm into `~/.local/bin`, `claude`, `codex`, `pi`,
`gh`, `rg`/`fd`/`jq`/`yq`, cloudflared. See `my-docs/loom-desk-setup-log.md` and the
beckett-self-provisions-tools principle: this is a baseline, Beckett installs what it needs.

## 4. Credentials (from the secrets backup — never in git)

| File | What |
|---|---|
| `~/.beckett/.env` | `DISCORD_TOKEN`, `PLANE_API_TOKEN`, `GITHUB_PAT`, `DISCORD_ALERT_WEBHOOK_URL`, … — the committed `.env.example` is the full inventory (`beckett doctor` flags drift) |
| `~/.claude/.credentials.json` | claude subscription login |
| `~/.codex/auth.json` | codex ChatGPT login |
| `~/.pi/agent/auth.json` | pi OAuth login |
| `~/.beckett/config.toml` | runtime overrides (validated strict — prune keys when the schema prunes) |

## 5. Clone + units

```bash
git clone https://github.com/0xbeckett/beckett.git ~/beckett
cd ~/beckett && bun install --frozen-lockfile
./deploy/install.sh        # links deploy/systemd/* (units + timers), enables beckett-v3 + heartbeat
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

## Clone roles (the anti-drift contract)

| Clone | Role | Rule |
|---|---|---|
| `beckett@loom-desk:~/beckett` | **deploy checkout** — what systemd runs | never edited by hand, never by workers; only `deploy-prod.sh` touches it |
| `beckett@loom-desk:~/Projects/<slug>` | worker checkouts (one per ticket project) | Beckett's own repo included: self-improvement tickets run in `~/Projects/beckett` and flow through PRs to `origin main` like everything else |
| dev clones (Mac, claude@loom-desk) | humans + interactive agents | short-lived feature branches off main, pushed same-day; no version-named long-lived branches |

Version identity: `package.json` is the ONE source (`BECKETT_VERSION` reads it); bump it with the
CHANGELOG in the PR; `deploy-prod.sh` tags `v<version>` at deploy.
