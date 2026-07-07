#!/usr/bin/env bash
# Beckett — install/refresh the systemd user units on the box (idempotent; issue #29).
# Run AS the beckett user on loom-desk:  ~/beckett/deploy/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"

# Symlink every unit in deploy/systemd — the repo is the source of truth; editing the live
# copy under ~/.config drifts silently (that is exactly what this script ends).
for unit in "${REPO_DIR}"/deploy/systemd/*.service "${REPO_DIR}"/deploy/systemd/*.timer; do
  [ -e "${unit}" ] || continue
  name="$(basename "${unit}")"
  ln -sf "${unit}" "${UNIT_DIR}/${name}"
  echo "linked ${name}"
done

# Retire the dead v0/v2/v3 units if this box still has them (v0/v2 code was deleted in issue
# #28; the v3 unit was renamed to beckett-v4 in the 4.0.0 multiplayer release).
# ORDER MATTERS on a rename cutover: after `git pull` the old unit's symlink dangles, and on
# systemd 255 `disable --now` FAILS on a dangling unit ("Unit file does not exist") WITHOUT
# stopping the running process — leaving two daemons on one Discord token. `stop` still works
# on the loaded unit, so stop explicitly first, then disable, then remove every trace: the
# unit symlink AND the default.target.wants enablement link (disable can't clean what it
# can't load). Any drop-in dir (e.g. a TEMP log-level override) migrates to beckett-v4 so it
# keeps applying rather than being silently orphaned.
for stale in beckett.service beckett-v2.service beckett-v3.service; do
  if [ -e "${UNIT_DIR}/${stale}" ] || [ -L "${UNIT_DIR}/${stale}" ]; then
    systemctl --user stop "${stale}" 2>/dev/null || true
    systemctl --user disable "${stale}" 2>/dev/null || true
    rm -f "${UNIT_DIR}/${stale}" "${UNIT_DIR}/default.target.wants/${stale}"
    if [ -d "${UNIT_DIR}/${stale}.d" ]; then
      if [ "${stale}" = "beckett-v3.service" ]; then
        mkdir -p "${UNIT_DIR}/beckett-v4.service.d"
        mv "${UNIT_DIR}/${stale}.d"/*.conf "${UNIT_DIR}/beckett-v4.service.d/" 2>/dev/null || true
        echo "migrated ${stale}.d drop-ins to beckett-v4.service.d"
      fi
      rm -rf "${UNIT_DIR}/${stale}.d"
    fi
    echo "removed stale ${stale}"
  fi
done

systemctl --user daemon-reload
systemctl --user enable --now beckett-v4.service
# Weekly doctor heartbeat (issue #30) — a no-op until DISCORD_ALERT_WEBHOOK_URL is set.
systemctl --user enable --now beckett-heartbeat.timer
systemctl --user is-active beckett-v4.service
echo "beckett-v4 installed and running"
