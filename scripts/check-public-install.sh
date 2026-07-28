#!/usr/bin/env bash
# Run the README's piped public-installer path in a brand-new Ubuntu + systemd container.
# This is intentionally slow: it downloads the real toolchain, Chromium, and bored.
set -Eeuo pipefail
IFS=$'\n\t'

ROOT=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly NAME="beckett-public-install-$$"
readonly BASE_IMAGE="ubuntu:24.04"
readonly IMAGE="beckett-public-install-systemd-$$"
TMP_SOURCE="$(mktemp -d)"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
fi

cleanup() {
  "${DOCKER[@]}" rm -f "${NAME}" >/dev/null 2>&1 || true
  "${DOCKER[@]}" image rm -f "${IMAGE}" >/dev/null 2>&1 || true
  rm -rf "${TMP_SOURCE}"
}
trap cleanup EXIT

"${DOCKER[@]}" info >/dev/null || {
  echo "Docker (or passwordless sudo for Docker) is required." >&2
  exit 1
}
"${DOCKER[@]}" pull "${BASE_IMAGE}" >/dev/null
# A Docker base image does not include PID-1 systemd, unlike the supported VPS images. Build the
# smallest equivalent systemd host; Beckett's own packages are still installed only by install.sh.
"${DOCKER[@]}" build -t "${IMAGE}" - >/dev/null <<EOF
FROM ${BASE_IMAGE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session && rm -rf /var/lib/apt/lists/*
CMD ["/sbin/init"]
EOF
"${DOCKER[@]}" run -d --name "${NAME}" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw "${IMAGE}" /sbin/init >/dev/null
sleep 2

# Make a throwaway git repository from this checkout. The installer sees it only through the
# supported test-only file:// override; every package/tool download is otherwise real.
tar \
  --exclude=.git --exclude=.beckett --exclude=node_modules --exclude=.bun \
  --exclude=playwright --exclude='metrics-dashboard/node_modules' \
  -C "${ROOT}" -cf - . | tar -xf - -C "${TMP_SOURCE}"
git -C "${TMP_SOURCE}" init -b main >/dev/null
git -C "${TMP_SOURCE}" config user.email installer-check@example.invalid
git -C "${TMP_SOURCE}" config user.name installer-check
git -C "${TMP_SOURCE}" add .
git -C "${TMP_SOURCE}" commit -m "installer check snapshot" >/dev/null
"${DOCKER[@]}" exec "${NAME}" mkdir /source
"${DOCKER[@]}" cp "${TMP_SOURCE}/." "${NAME}:/source"
"${DOCKER[@]}" exec "${NAME}" chmod -R a+rX /source

# Match the README's `curl | bash` execution shape (there is no script path/BASH_SOURCE entry).
# `--non-interactive` is needed because this check deliberately has no secrets or a TTY.
"${DOCKER[@]}" cp "${ROOT}/install.sh" "${NAME}:/tmp/install-beckett.sh"
"${DOCKER[@]}" exec "${NAME}" bash -c '
  export BECKETT_ALLOW_LOCAL_REPO=1
  export BECKETT_REPO_URL=file:///source
  cat /tmp/install-beckett.sh | bash -s -- --non-interactive
'

# shellcheck disable=SC2016 # This single-quoted body is intentionally evaluated in the container.
"${DOCKER[@]}" exec "${NAME}" bash -c '
  set -Eeuo pipefail
  sudo -iu beckett systemctl --user is-active --quiet beckett-v4.service
  status="$(sudo -iu beckett beckett status)"
  printf "%s\n" "$status" | jq -e ".state == \"healthy-pending-configuration\"" >/dev/null
  test -f /home/beckett/.beckett/.env
  test -f /home/beckett/.beckett/config.toml
  echo "clean install: healthy-pending-configuration"
'
