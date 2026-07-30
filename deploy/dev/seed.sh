#!/usr/bin/env bash
# Seed & install the Beckett [DEV] staging instance on this box. Idempotent — safe to re-run.
#
#   - clones/updates a SEPARATE checkout at ~/beckett-dev (never touches prod's ~/beckett),
#   - seeds ~/.beckett-dev/{config.toml,peers.txt,routines.json} from deploy/dev/,
#   - writes ~/.beckett-dev/.env, sourcing DISCORD_TOKEN from prod's CALLIE_DISCORD_TOKEN and
#     DISCORD_OWNER_ID from prod's DISCORD_OWNER_ID — WITHOUT ever printing either value,
#   - installs the systemd unit but does NOT enable it (staging is started on demand).
#
# It does NOT start the daemon; see docs/dev-instance.md for start/stop/tail/redeploy.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_ENV="${HOME}/.beckett/.env"
DEV_DIR="${HOME}/.beckett-dev"
DEV_CHECKOUT="${HOME}/beckett-dev"
UNIT_DST="${HOME}/.config/systemd/user/beckett-dev.service"

# 1. Separate checkout. Clone from the prod checkout (a local, no-hardlink clone) if absent.
if [ ! -d "${DEV_CHECKOUT}/.git" ]; then
  git clone --no-hardlinks "${HOME}/beckett" "${DEV_CHECKOUT}"
fi
( cd "${DEV_CHECKOUT}" && bun install --frozen-lockfile 2>/dev/null || bun install )

# 2. Seed state dir (config / peers / routines). These carry no secrets.
mkdir -p "${DEV_DIR}" "${DEV_DIR}/projects"
chmod 700 "${DEV_DIR}"
cp "${HERE}/config.toml"   "${DEV_DIR}/config.toml"
cp "${HERE}/peers.txt"     "${DEV_DIR}/peers.txt"
cp "${HERE}/routines.json" "${DEV_DIR}/routines.json"

# 3. .env — never echo a secret. Derive DISCORD_TOKEN + DISCORD_OWNER_ID from prod's .env by name.
umask 077
CALLIE_TOKEN="$(grep -E '^\s*(export\s+)?CALLIE_DISCORD_TOKEN=' "${PROD_ENV}" | tail -1 | sed -E 's/^\s*(export\s+)?CALLIE_DISCORD_TOKEN=//; s/^["'"'"']//; s/["'"'"']\s*$//')"
OWNER_ID="$(grep -E '^\s*(export\s+)?DISCORD_OWNER_ID=' "${PROD_ENV}" | tail -1 | sed -E 's/^\s*(export\s+)?DISCORD_OWNER_ID=//; s/^["'"'"']//; s/["'"'"']\s*$//')"
if [ -z "${CALLIE_TOKEN}" ]; then echo "seed: CALLIE_DISCORD_TOKEN not found in ${PROD_ENV}" >&2; exit 1; fi
if [ -z "${OWNER_ID}" ]; then echo "seed: DISCORD_OWNER_ID not found in ${PROD_ENV}" >&2; exit 1; fi
{
  printf '# Beckett [DEV] staging secrets — machine-seeded by deploy/dev/seed.sh. Do not commit.\n'
  printf 'DISCORD_TOKEN=%s\n' "${CALLIE_TOKEN}"
  printf 'DISCORD_OWNER_ID=%s\n' "${OWNER_ID}"
  printf 'GITHUB_PAT=disabled-in-dev-staging\n'
} > "${DEV_DIR}/.env"
chmod 600 "${DEV_DIR}/.env"
unset CALLIE_TOKEN OWNER_ID

# 4. Install the unit (NOT enabled — on-demand only).
mkdir -p "$(dirname "${UNIT_DST}")"
cp "${HERE}/../systemd/beckett-dev.service" "${UNIT_DST}"
systemctl --user daemon-reload

echo "seeded ~/.beckett-dev and installed beckett-dev.service (not enabled)."
echo "start it with:  systemctl --user start beckett-dev"
