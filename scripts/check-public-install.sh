#!/usr/bin/env bash
# Run the README's piped public-installer path in a brand-new Ubuntu + systemd container.
# This is intentionally slow: it downloads the real toolchain, Chromium, and bored.
set -Eeuo pipefail
IFS=$'\n\t'

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly NAME="beckett-public-install-$$"
readonly IMAGE="ubuntu:24.04"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
fi

cleanup() {
  "${DOCKER[@]}" rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${DOCKER[@]}" info >/dev/null || {
  echo "Docker (or passwordless sudo for Docker) is required." >&2
  exit 1
}
"${DOCKER[@]}" pull "${IMAGE}" >/dev/null
"${DOCKER[@]}" run -d --name "${NAME}" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw "${IMAGE}" /sbin/init >/dev/null

# Make a throwaway git repository from this checkout. The installer sees it only through the
# supported test-only file:// override; every package/tool download is otherwise real.
tar \
  --exclude=.git --exclude=.beckett --exclude=node_modules --exclude=.bun \
  --exclude=playwright --exclude='metrics-dashboard/node_modules' \
  -C "${ROOT}" -cf - . |
  "${DOCKER[@]}" exec -i "${NAME}" bash -c '
    set -Eeuo pipefail
    mkdir /source
    tar -xf - -C /source
    cd /source
    git init -b main
    git config user.email installer-check@example.invalid
    git config user.name installer-check
    git add .
    git commit -m "installer check snapshot"
    chmod -R a+rX /source
  '

# Match the README's `curl | bash` execution shape (there is no script path/BASH_SOURCE entry).
# `--non-interactive` is needed because this check deliberately has no secrets or a TTY.
"${DOCKER[@]}" cp "${ROOT}/install.sh" "${NAME}:/tmp/install-beckett.sh"
"${DOCKER[@]}" exec "${NAME}" bash -c '
  export BECKETT_ALLOW_LOCAL_REPO=1
  export BECKETT_REPO_URL=file:///source
  cat /tmp/install-beckett.sh | bash -s -- --non-interactive
'

"${DOCKER[@]}" exec "${NAME}" bash -c '
  set -Eeuo pipefail
  sudo -iu beckett systemctl --user is-active --quiet beckett-v4.service
  status="$(sudo -iu beckett beckett status)"
  printf "%s\n" "$status" | jq -e '"'"'.state == "healthy-pending-configuration"'"'"' >/dev/null
  test -f /home/beckett/.beckett/.env
  test -f /home/beckett/.beckett/config.toml
  echo "clean install: healthy-pending-configuration"
'
