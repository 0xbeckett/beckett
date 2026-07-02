#!/usr/bin/env bash
# Beckett — weekly ops heartbeat (issue #30). Runs `beckett doctor` and posts the result to the
# alert webhook. With a heartbeat, alert-channel silence actually MEANS "healthy" instead of
# "maybe the alerting is broken too". Fired by beckett-heartbeat.timer.
set -u

WEBHOOK="${DISCORD_ALERT_WEBHOOK_URL:-}"
[ -z "${WEBHOOK}" ] && exit 0

cd "${HOME}/beckett" || exit 0
REPORT="$(/usr/local/bin/bun src/cli/beckett.ts doctor 2>&1 | head -40)"

# Discord caps messages at 2000 chars; jq -Rs turns the multi-line report into a safe JSON string.
{ printf '💓 loom-desk weekly heartbeat\n```\n%s\n```' "${REPORT}"; } | head -c 1900 \
  | jq -Rs '{content: .}' \
  | curl -fsS -m 30 -H 'Content-Type: application/json' -d @- "${WEBHOOK}" >/dev/null 2>&1 || true
exit 0
