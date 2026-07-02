#!/usr/bin/env bash
# Beckett — install/refresh the systemd user units on the box (idempotent; issue #29).
# Run AS the beckett user on loom-desk:  ~/beckett/deploy/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"

# Symlink every unit in deploy/systemd — the repo is the source of truth; editing the live
# copy under ~/.config drifts silently (that is exactly what this script ends).
for unit in "${REPO_DIR}"/deploy/systemd/*.service; do
  name="$(basename "${unit}")"
  ln -sf "${unit}" "${UNIT_DIR}/${name}"
  echo "linked ${name}"
done

# Retire the dead v0/v2 units if this box still has them (their code was deleted in issue #28).
for stale in beckett.service beckett-v2.service; do
  if [ -e "${UNIT_DIR}/${stale}" ] || [ -L "${UNIT_DIR}/${stale}" ]; then
    systemctl --user disable --now "${stale}" 2>/dev/null || true
    rm -f "${UNIT_DIR}/${stale}"
    echo "removed stale ${stale}"
  fi
done

systemctl --user daemon-reload
systemctl --user enable --now beckett-v3.service
systemctl --user is-active beckett-v3.service
echo "beckett-v3 installed and running"
