#!/usr/bin/env bash
# Beckett — encrypted secrets backup (issue #34). Run FROM the Mac after any secret change:
#   ./deploy/backup-secrets.sh
#
# Pulls the recovery-critical files off loom-desk, tars them, and age-encrypts the archive to
# ~/.beckett-backups/ on THIS machine. The age PRIVATE key lives only on the Mac
# (~/.config/age/beckett-backup.key) — the box being lost or seized never exposes the backup.
#
# NOTE: backups are deliberately NOT committed — this repo is PUBLIC, and public git history is
# forever (a future key leak would decrypt every historical version). Only this script (and the
# public recipient below) belongs in git.
#
# Restore on a fresh box (see deploy/host-setup.md):
#   age -d -i ~/.config/age/beckett-backup.key ~/.beckett-backups/<newest>.tar.age | ssh beckett@HOST 'tar -x -C ~'
set -euo pipefail

HOST="${BECKETT_HOST:-beckett@loom-desk}"
OUT_DIR="${HOME}/.beckett-backups"
# The Mac backup key's PUBLIC half — safe in git; encryption needs only this.
RECIPIENT="age1e2chek2xwjucvt2nye8dkdmq08df5l7kd7j58vm40jm2yaz6g3squ74aue"

# Everything a box rebuild needs beyond `git clone` (paths relative to the beckett user's $HOME):
#   .beckett/.env               — all runtime secrets (see .env.example for the inventory)
#   .beckett/config.toml        — runtime config overrides (deploy/config.toml.example = defaults)
#   .claude/.credentials.json   — claude subscription login
#   .codex/auth.json            — codex ChatGPT login
#   .pi/agent/auth.json         — pi OAuth login
FILES=".beckett/.env .beckett/config.toml .claude/.credentials.json .codex/auth.json .pi/agent/auth.json"

command -v age >/dev/null || { echo "FATAL: age not installed (brew install age)" >&2; exit 1; }

mkdir -p "${OUT_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT_DIR}/beckett-secrets-${STAMP}.tar.age"

# tar on the box (missing optional files are skipped with a warning, not a failure), encrypt here.
# shellcheck disable=SC2086
ssh "${HOST}" "cd ~ && tar -cf - \$(for f in ${FILES}; do [ -f \"\$f\" ] && echo \"\$f\" || echo \"WARN: missing \$f\" >&2; done)" \
  | age -r "${RECIPIENT}" -o "${OUT}"

chmod 600 "${OUT}"
# Sanity: the archive must decrypt and list on this machine (proves the PRIVATE key works too).
age -d -i "${HOME}/.config/age/beckett-backup.key" "${OUT}" | tar -t >/dev/null
echo "== backed up + decrypt-verified: ${OUT} =="
ls -lh "${OUT_DIR}" | tail -5
