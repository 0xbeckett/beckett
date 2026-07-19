#!/usr/bin/env bash
# Beckett public host installer. Run as root on a fresh Ubuntu/Debian system.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
IFS=$'\n\t'

readonly INSTALLER_VERSION="1"
readonly DEFAULT_REPO_URL="https://github.com/0xbeckett/beckett.git"
readonly DEFAULT_REPO_REF="main"
readonly BECKETT_USER="beckett"
readonly BECKETT_HOME="/home/${BECKETT_USER}"
readonly BECKETT_REPO="${BECKETT_HOME}/beckett"
readonly BECKETT_STATE="${BECKETT_HOME}/.beckett"
readonly NODE_BASE_URL="https://nodejs.org/dist/latest-v24.x"
readonly PI_PACKAGE="@earendil-works/pi-coding-agent"

REPO_URL="${BECKETT_REPO_URL:-${DEFAULT_REPO_URL}}"
REPO_REF="${BECKETT_REPO_REF:-${DEFAULT_REPO_REF}}"
NON_INTERACTIVE=0
NO_START=0
TEMP_PATHS=()
DOWNLOADED_INSTALLER=""

# Capture supported non-interactive inputs, then remove secrets from the exported root
# environment before apt, curl, vendor installers, or repository scripts can inherit them.
INPUT_DISCORD_TOKEN="${BECKETT_DISCORD_TOKEN:-}"
INPUT_DISCORD_OWNER_ID="${BECKETT_DISCORD_OWNER_ID:-}"
INPUT_DISCORD_OWNER_NAME="${BECKETT_DISCORD_OWNER_NAME:-}"
INPUT_GITHUB_PAT="${BECKETT_GITHUB_PAT:-}"
INPUT_GITHUB_USER="${BECKETT_GITHUB_USER:-}"
INPUT_ENABLE_PI="${BECKETT_ENABLE_PI:-}"
INPUT_ENABLE_CODEX="${BECKETT_ENABLE_CODEX:-}"
unset BECKETT_DISCORD_TOKEN BECKETT_DISCORD_OWNER_ID BECKETT_DISCORD_OWNER_NAME
unset BECKETT_GITHUB_PAT BECKETT_GITHUB_USER
unset BECKETT_ENABLE_PI BECKETT_ENABLE_CODEX

log() {
  printf '[beckett] %s\n' "$*"
}

warn() {
  printf '[beckett] warning: %s\n' "$*" >&2
}

die() {
  printf '[beckett] error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local path
  for path in "${TEMP_PATHS[@]:-}"; do
    [ -n "${path}" ] && rm -rf -- "${path}"
  done
  return 0
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Install Beckett on Ubuntu or Debian.

Requires Ubuntu 22.04, 24.04, or 26.04, or Debian 12 or 13, plus systemd, x64/arm64,
4 GB RAM, and 5 GB free disk.

Usage:
  sudo bash install.sh [options]

Options:
  --repo URL          GitHub HTTPS repository to install
  --ref REF           Branch or tag to install (default: main)
  --non-interactive   Do not prompt; stage missing configuration for later
  --no-start          Install and configure, but never enable/start Beckett
  -h, --help          Show this help

Non-interactive configuration can be supplied with:
  BECKETT_DISCORD_TOKEN, BECKETT_DISCORD_OWNER_ID, BECKETT_DISCORD_OWNER_NAME,
  BECKETT_GITHUB_PAT, BECKETT_GITHUB_USER, BECKETT_ENABLE_PI, and BECKETT_ENABLE_CODEX.

Secrets are never accepted as command-line flags.
EOF
}

supported_release() {
  local id="$1"
  local version="$2"
  case "${id}" in
    ubuntu) case "${version}" in 22.04|24.04|26.04) return 0 ;; *) return 1 ;; esac ;;
    debian) case "${version}" in 12|13) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

valid_repo_url() {
  local value="$1"
  if [[ "${value}" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]]; then
    return 0
  fi
  if [ "${BECKETT_ALLOW_LOCAL_REPO:-0}" = "1" ] && [[ "${value}" =~ ^file:///[A-Za-z0-9._/-]+$ ]]; then
    return 0
  fi
  return 1
}

valid_ref() {
  local value="$1"
  [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] &&
    [[ "${value}" != *..* ]] &&
    [[ "${value}" != *//* ]] &&
    [[ "${value}" != */ ]]
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo)
        [ "$#" -ge 2 ] || die "--repo needs a value"
        REPO_URL="$2"
        shift 2
        ;;
      --ref)
        [ "$#" -ge 2 ] || die "--ref needs a value"
        REPO_REF="$2"
        shift 2
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --no-start)
        NO_START=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  valid_repo_url "${REPO_URL}" || die "--repo must be a plain GitHub HTTPS URL"
  valid_ref "${REPO_REF}" || die "--ref contains unsafe or invalid characters"
}

require_supported_host() {
  [ "${EUID}" -eq 0 ] || die "run this installer as root (for example: sudo bash install.sh)"
  [ -r /etc/os-release ] || die "cannot identify this operating system"

  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "supported hosts are Ubuntu and Debian (found ${ID:-unknown})" ;;
  esac
  supported_release "${ID}" "${VERSION_ID:-0}" ||
    die "supported releases are Ubuntu 22.04/24.04/26.04 and Debian 12/13 (found ${PRETTY_NAME:-unknown})"

  command -v systemctl >/dev/null || die "systemd is required"
  [ "$(ps -p 1 -o comm= | tr -d ' ')" = "systemd" ] || die "systemd must be PID 1"

  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "supported architectures are x86_64 and arm64" ;;
  esac

  local free_kb
  free_kb="$(df -Pk / | awk 'NR == 2 { print $4 }')"
  [ "${free_kb:-0}" -ge 5242880 ] || die "at least 5 GB of free disk space is required"

  local memory_kb
  memory_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
  [ "${memory_kb:-0}" -ge 3800000 ] || die "at least 4 GB of RAM is required"
}

install_base_packages() {
  log "installing operating-system packages"
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=a
  local dpkg_audit
  if ! dpkg_audit="$(dpkg --audit 2>&1)"; then
    die "the host package database is corrupt; repair dpkg (or rebuild this fresh VPS) before rerunning: $(printf '%s' "${dpkg_audit}" | head -n 1)"
  fi
  if [ -n "${dpkg_audit}" ]; then
    log "finishing an interrupted package configuration left by the host image"
    dpkg --configure -a
  fi
  apt-get -o DPkg::Lock::Timeout=120 update
  apt-get -o DPkg::Lock::Timeout=120 install -y \
    build-essential \
    bubblewrap \
    ca-certificates \
    curl \
    fd-find \
    git \
    gnupg \
    jq \
    python3 \
    python3-venv \
    ripgrep \
    sudo \
    util-linux \
    unzip \
    xz-utils
}

install_github_cli() {
  if command -v gh >/dev/null 2>&1; then
    log "GitHub CLI already installed ($(gh --version | head -n 1))"
    return
  fi

  log "installing GitHub CLI from GitHub's signed apt repository"
  install -d -m 0755 /etc/apt/keyrings /etc/apt/sources.list.d
  local key_tmp
  key_tmp="$(mktemp)"
  TEMP_PATHS+=("${key_tmp}")
  curl --fail --silent --show-error --location --retry 3 \
    https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    --output "${key_tmp}"
  install -m 0644 "${key_tmp}" /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list
  apt-get -o DPkg::Lock::Timeout=120 update
  apt-get -o DPkg::Lock::Timeout=120 install -y gh
}

ensure_beckett_user() {
  if getent passwd "${BECKETT_USER}" >/dev/null; then
    local actual_home
    actual_home="$(getent passwd "${BECKETT_USER}" | cut -d: -f6)"
    [ "${actual_home}" = "${BECKETT_HOME}" ] ||
      die "existing ${BECKETT_USER} user has home ${actual_home}; expected ${BECKETT_HOME}"
  else
    log "creating the unprivileged ${BECKETT_USER} service account"
    useradd --create-home --shell /bin/bash "${BECKETT_USER}"
  fi

  if [ ! -d "${BECKETT_HOME}" ] || [ -L "${BECKETT_HOME}" ]; then
    die "${BECKETT_HOME} must be a real directory"
  fi
  [ "$(stat -c '%U' "${BECKETT_HOME}")" = "${BECKETT_USER}" ] ||
    die "${BECKETT_HOME} must be owned by ${BECKETT_USER}"
  as_beckett mkdir -p \
    "${BECKETT_HOME}/.local/bin" \
    "${BECKETT_HOME}/.local/share" \
    "${BECKETT_STATE}"
  as_beckett chmod 0755 "${BECKETT_HOME}/.local" "${BECKETT_HOME}/.local/bin" "${BECKETT_HOME}/.local/share"
  as_beckett chmod 0700 "${BECKETT_STATE}"
  loginctl enable-linger "${BECKETT_USER}"
  local uid
  uid="$(id -u "${BECKETT_USER}")"
  systemctl start "user@${uid}.service"
}

beckett_path() {
  printf '%s' "${BECKETT_HOME}/.local/bin:${BECKETT_HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin"
}

as_beckett() {
  # The positional parameters expand in the child shell, after runuser changes identity.
  # shellcheck disable=SC2016
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/sbin/runuser -u "${BECKETT_USER}" -- /usr/bin/env -i \
    HOME="${BECKETT_HOME}" \
    USER="${BECKETT_USER}" \
    LOGNAME="${BECKETT_USER}" \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="$(beckett_path)" \
    bash -c 'cd "$1" && shift && exec "$@"' bash "${BECKETT_HOME}" "$@"
}

as_beckett_in_repo() {
  # The positional parameters expand in the child shell, after runuser changes identity.
  # shellcheck disable=SC2016
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/sbin/runuser -u "${BECKETT_USER}" -- /usr/bin/env -i \
    HOME="${BECKETT_HOME}" \
    USER="${BECKETT_USER}" \
    LOGNAME="${BECKETT_USER}" \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="$(beckett_path)" \
    bash -c 'cd "$1" && shift && exec "$@"' bash "${BECKETT_REPO}" "$@"
}

verify_browser_sandbox() {
  log "verifying browser process isolation as ${BECKETT_USER}"
  as_beckett bwrap --unshare-all --share-net --die-with-parent --ro-bind / / /bin/true ||
    die "bubblewrap cannot create an unprivileged user namespace; see deploy/host-setup.md"
}

version_ge() {
  local current="${1#v}"
  local minimum="${2#v}"
  [ "$(printf '%s\n%s\n' "${minimum}" "${current}" | sort -V | head -n 1)" = "${minimum}" ]
}

install_node() {
  local current=""
  current="$(as_beckett node --version 2>/dev/null || true)"
  if [ -n "${current}" ] && version_ge "${current}" "22.19.0"; then
    log "Node already installed (${current})"
    return
  fi

  log "installing the current Node 24 LTS binary with SHA256 verification"
  local node_arch
  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
  esac

  local tmp sums node_file release_dir
  tmp="$(mktemp -d)"
  TEMP_PATHS+=("${tmp}")
  sums="${tmp}/SHASUMS256.txt"
  curl --fail --silent --show-error --location --retry 3 \
    "${NODE_BASE_URL}/SHASUMS256.txt" --output "${sums}"
  node_file="$(awk -v suffix="-linux-${node_arch}.tar.xz" \
    'substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }' "${sums}")"
  [ -n "${node_file}" ] || die "could not select a Node binary for ${node_arch}"
  [[ "${node_file}" =~ ^node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] ||
    die "Node published an unexpected archive name: ${node_file}"
  curl --fail --silent --show-error --location --retry 3 \
    "${NODE_BASE_URL}/${node_file}" --output "${tmp}/${node_file}"
  (cd "${tmp}" && awk -v f="${node_file}" '$2 == f { print }' SHASUMS256.txt | sha256sum --check --strict -)

  release_dir="${node_file%.tar.xz}"
  chmod 0755 "${tmp}"
  chmod 0644 "${tmp}/${node_file}"
  as_beckett mkdir -p "${BECKETT_HOME}/.local/share/nodejs"
  as_beckett rm -rf -- "${BECKETT_HOME}/.local/share/nodejs/${release_dir}"
  as_beckett tar -xJf "${tmp}/${node_file}" -C "${BECKETT_HOME}/.local/share/nodejs"
  as_beckett ln -sfn "${BECKETT_HOME}/.local/share/nodejs/${release_dir}" "${BECKETT_HOME}/.local/share/nodejs/current"
  local binary
  for binary in node npm npx corepack; do
    as_beckett ln -sfn "${BECKETT_HOME}/.local/share/nodejs/current/bin/${binary}" "${BECKETT_HOME}/.local/bin/${binary}"
  done
}

download_installer() {
  local url="$1"
  DOWNLOADED_INSTALLER="$(mktemp)"
  TEMP_PATHS+=("${DOWNLOADED_INSTALLER}")
  curl --fail --silent --show-error --location --retry 3 "${url}" --output "${DOWNLOADED_INSTALLER}"
  chmod 0644 "${DOWNLOADED_INSTALLER}"
}

install_user_toolchain() {
  local installer

  if [ ! -x "${BECKETT_HOME}/.bun/bin/bun" ]; then
    log "installing Bun as ${BECKETT_USER}"
    download_installer https://bun.com/install
    installer="${DOWNLOADED_INSTALLER}"
    as_beckett env BUN_INSTALL="${BECKETT_HOME}/.bun" bash "${installer}"
  else
    log "Bun already installed ($(as_beckett "${BECKETT_HOME}/.bun/bin/bun" --version))"
  fi

  if ! as_beckett claude --version >/dev/null 2>&1; then
    log "installing Claude Code stable as ${BECKETT_USER}"
    download_installer https://claude.ai/install.sh
    installer="${DOWNLOADED_INSTALLER}"
    as_beckett bash "${installer}" stable
  else
    log "Claude Code already installed ($(as_beckett claude --version | head -n 1))"
  fi

  if ! as_beckett codex --version >/dev/null 2>&1; then
    log "installing Codex CLI as ${BECKETT_USER}"
    download_installer https://chatgpt.com/codex/install.sh
    installer="${DOWNLOADED_INSTALLER}"
    as_beckett env CODEX_NON_INTERACTIVE=1 sh "${installer}"
  else
    log "Codex CLI already installed ($(as_beckett codex --version | head -n 1))"
  fi

  local pi_version=""
  pi_version="$(as_beckett pi --version 2>&1 | head -n 1 || true)"
  if [ -n "${pi_version}" ] && version_ge "${pi_version}" "0.78.0"; then
    log "Pi already installed (${pi_version})"
  else
    log "installing Pi as ${BECKETT_USER}"
    as_beckett env NPM_CONFIG_PREFIX="${BECKETT_HOME}/.local" \
      npm install --global --ignore-scripts "${PI_PACKAGE}"
  fi

  if [ -x /usr/bin/fdfind ]; then
    as_beckett ln -sfn /usr/bin/fdfind "${BECKETT_HOME}/.local/bin/fd"
  fi
}

clone_or_update_repo() {
  if [ ! -e "${BECKETT_REPO}" ]; then
    log "cloning ${REPO_URL} (${REPO_REF})"
    local staging="${BECKETT_REPO}.installing.$$"
    rm -rf -- "${staging}"
    as_beckett git clone --branch "${REPO_REF}" --single-branch -- "${REPO_URL}" "${staging}"
    as_beckett mv "${staging}" "${BECKETT_REPO}"
    return
  fi

  [ -d "${BECKETT_REPO}/.git" ] || die "${BECKETT_REPO} exists but is not a git checkout"
  local origin dirty
  origin="$(as_beckett git -C "${BECKETT_REPO}" remote get-url origin)"
  [ "${origin}" = "${REPO_URL}" ] ||
    die "${BECKETT_REPO} uses origin ${origin}; rerun with --repo ${origin}"
  dirty="$(as_beckett git -C "${BECKETT_REPO}" status --porcelain)"
  [ -z "${dirty}" ] || die "${BECKETT_REPO} has local changes; refusing to overwrite them"

  log "fast-forwarding the existing checkout to ${REPO_REF}"
  as_beckett git -C "${BECKETT_REPO}" fetch --tags origin "${REPO_REF}"
  as_beckett git -C "${BECKETT_REPO}" merge-base --is-ancestor HEAD FETCH_HEAD ||
    die "the installed checkout has commits not in ${REPO_REF}; refusing to rewrite it"
  as_beckett git -C "${BECKETT_REPO}" merge --ff-only FETCH_HEAD
}

install_app_dependencies() {
  log "installing locked Beckett dependencies"
  as_beckett_in_repo "${BECKETT_HOME}/.bun/bin/bun" install --frozen-lockfile
  log "installing Chromium system dependencies"
  (
    cd "${BECKETT_REPO}"
    HOME=/root "${BECKETT_HOME}/.bun/bin/bun" x playwright install-deps chromium
  )
  log "installing Beckett's pinned full Chromium build"
  as_beckett_in_repo "${BECKETT_HOME}/.bun/bin/bun" x playwright install --no-shell chromium
  log "smoke-testing the production browser sandbox and disposable evaluator"
  as_beckett_in_repo "${BECKETT_HOME}/.bun/bin/bun" run browser:smoke
  log "typechecking Beckett before installing its service"
  as_beckett_in_repo "${BECKETT_HOME}/.bun/bin/bun" run typecheck
}

prompt_value() {
  local label="$1"
  local default="$2"
  local answer=""
  if [ "${NON_INTERACTIVE}" -eq 1 ] || [ ! -r /dev/tty ]; then
    printf '%s' "${default}"
    return
  fi
  printf '%s [%s]: ' "${label}" "${default}" > /dev/tty
  IFS= read -r answer < /dev/tty || true
  printf '%s' "${answer:-${default}}"
}

prompt_secret() {
  local label="$1"
  local answer=""
  if [ "${NON_INTERACTIVE}" -eq 1 ] || [ ! -r /dev/tty ]; then
    return
  fi
  printf '%s (input hidden, Enter to configure later): ' "${label}" > /dev/tty
  IFS= read -r -s answer < /dev/tty || true
  printf '\n' > /dev/tty
  printf '%s' "${answer}"
}

normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) printf 'true' ;;
    0|false|no|n|off) printf 'false' ;;
    *) return 1 ;;
  esac
}

prompt_bool() {
  local label="$1"
  local default="$2"
  local hint="y/N"
  [ "${default}" = "true" ] && hint="Y/n"
  if [ "${NON_INTERACTIVE}" -eq 1 ] || [ ! -r /dev/tty ]; then
    printf '%s' "${default}"
    return
  fi
  local answer=""
  printf '%s [%s]: ' "${label}" "${hint}" > /dev/tty
  IFS= read -r answer < /dev/tty || true
  [ -z "${answer}" ] && answer="${default}"
  normalize_bool "${answer}" || die "answer yes or no for: ${label}"
}

validate_instance_config() {
  local github_user="$1"
  if [ "${github_user}" != "CHANGE_ME" ]; then
    [[ "${github_user}" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]] || die "GitHub username is invalid"
  fi
}

write_initial_config() {
  local path="$1"
  local github_user="$2"
  local enable_pi="$3"
  local enable_codex="$4"
  local tmp
  tmp="$(mktemp)"
  TEMP_PATHS+=("${tmp}")
  {
    printf '# Created by Beckett installer v%s. Add only instance-specific overrides here.\n\n' "${INSTALLER_VERSION}"
    printf '[paths]\n'
    printf 'home = "%s"\n' "${BECKETT_HOME}"
    printf 'beckett_dir = "%s"\n' "${BECKETT_STATE}"
    printf 'projects = "%s/Projects"\n' "${BECKETT_HOME}"
    printf 'db = "%s/beckett.db"\n' "${BECKETT_STATE}"
    printf 'events_dir = "%s/events"\n' "${BECKETT_STATE}"
    printf 'logs_dir = "%s/logs"\n' "${BECKETT_STATE}"
    printf 'memory_dir = "%s/memory"\n' "${BECKETT_STATE}"
    printf 'socket = "%s/beckett.sock"\n' "${BECKETT_STATE}"
    printf 'spend = "%s/spend.jsonl"\n\n' "${BECKETT_STATE}"
    printf '[identity]\n'
    printf 'github_user = "%s"\n\n' "${github_user}"
    printf '[github.activity]\n'
    printf 'enabled = false\n\n'
    printf '[harness.pi]\n'
    printf 'enabled = %s\n\n' "${enable_pi}"
    printf '[harness.codex]\n'
    printf 'enabled = %s\n' "${enable_codex}"
  } > "${tmp}"
  chown "${BECKETT_USER}:${BECKETT_USER}" "${tmp}"
  as_beckett install -m 0600 "${tmp}" "${path}"
}

env_value() {
  local path="$1"
  local key="$2"
  [ -e "${path}" ] || return 0
  # shellcheck disable=SC2016
  as_beckett awk -v key="${key}" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "${path}"
}

toml_scalar_value() {
  local path="$1"
  local section="$2"
  local key="$3"
  local expected_type="$4"
  [ -e "${path}" ] || return 0

  # shellcheck disable=SC2016
  as_beckett "${BECKETT_HOME}/.bun/bin/bun" -e '
    const [path, section, key, expectedType] = process.argv.slice(1);
    const config = Bun.TOML.parse(await Bun.file(path).text());
    let value = config;
    for (const part of section.split(".")) {
      if (value === null || typeof value !== "object" || !(part in value)) {
        process.exit(0);
      }
      value = value[part];
    }
    if (value === null || typeof value !== "object" || !(key in value)) {
      process.exit(0);
    }
    value = value[key];
    if (typeof value !== expectedType) {
      console.error(`Expected ${section}.${key} to be a TOML ${expectedType}`);
      process.exit(1);
    }
    process.stdout.write(String(value));
  ' "${path}" "${section}" "${key}" "${expected_type}"
}

toml_string_value() {
  toml_scalar_value "$1" "$2" "$3" string
}

valid_env_value() {
  local value="$1"
  [[ "${value}" != *$'\n'* ]] && [[ "${value}" != *$'\r'* ]]
}

upsert_env() {
  local path="$1"
  local key="$2"
  local value="$3"
  valid_env_value "${value}" || die "${key} may not contain a newline"
  local current
  current="$(env_value "${path}" "${key}")"
  [ "${current}" = "${value}" ] && return

  local tmp
  tmp="$(mktemp)"
  TEMP_PATHS+=("${tmp}")
  if [ -e "${path}" ]; then
    # shellcheck disable=SC2016
    as_beckett awk -v key="${key}" 'index($0, key "=") != 1 { print }' "${path}" > "${tmp}"
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  chown "${BECKETT_USER}:${BECKETT_USER}" "${tmp}"
  as_beckett install -m 0600 "${tmp}" "${path}"
}

upsert_toml_literal() {
  local path="$1"
  local section="$2"
  local key="$3"
  local literal="$4"
  local tmp
  tmp="$(mktemp)"
  TEMP_PATHS+=("${tmp}")
  # shellcheck disable=SC2016
  as_beckett awk -v wanted="[${section}]" -v key="${key}" -v replacement="${key} = ${literal}" '
    {
      header = $0
      sub(/^[[:space:]]*/, "", header)
      sub(/[[:space:]]*#.*$/, "", header)
      sub(/[[:space:]]*$/, "", header)
      if (header ~ /^\[[^]]+\]$/) {
        if (in_section && !written) { print replacement; written = 1 }
        in_section = (header == wanted)
        if (in_section) section_found = 1
        print
        next
      }
    }
    in_section && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      if (!written) print replacement
      written = 1
      next
    }
    { print }
    END {
      if (in_section && !written) print replacement
      else if (!section_found) {
        if (NR > 0) print ""
        print wanted
        print replacement
      }
    }
  ' "${path}" > "${tmp}"
  chown "${BECKETT_USER}:${BECKETT_USER}" "${tmp}"
  as_beckett install -m 0600 "${tmp}" "${path}"
}

installer_managed_file() {
  local path="$1"
  [ -e "${path}" ] && as_beckett grep -q '^# Created by.*Beckett installer' "${path}"
}

assert_safe_user_file() {
  local path="$1"
  [ ! -L "${path}" ] || die "refusing symlink at ${path}"
  if [ -e "${path}" ]; then
    as_beckett test -f "${path}" || die "${path} must be a regular file owned/readable by ${BECKETT_USER}"
  fi
}

sync_github_org() {
  local env_path="$1"
  local config_path="$2"
  local previous_github_user="${3:-}"
  local github_org github_user
  github_org="$(env_value "${env_path}" BECKETT_GH_ORG)"
  github_user="$(toml_string_value "${config_path}" identity github_user)"

  if [ -z "${github_org}" ]; then
    if [ -n "${github_user}" ] && [ "${github_user}" != "CHANGE_ME" ]; then
      upsert_env "${env_path}" BECKETT_GH_ORG "${github_user}"
    fi
    return
  fi

  # Rotate only a value derived from the previous installer identity. A different
  # value is an explicit publishing-org override and remains user-owned.
  if [ -n "${INPUT_GITHUB_USER}" ] &&
    [ -n "${previous_github_user}" ] &&
    [ "${github_org}" = "${previous_github_user}" ] &&
    [ -n "${github_user}" ] && [ "${github_user}" != "CHANGE_ME" ]; then
    upsert_env "${env_path}" BECKETT_GH_ORG "${github_user}"
  fi
}

config_bool() {
  local section="$1"
  local fallback="$2"
  local path="${3:-${BECKETT_STATE}/config.toml}"
  local value
  value="$(toml_scalar_value "${path}" "${section}" enabled boolean)"
  printf '%s' "${value:-${fallback}}"
}

update_existing_config() {
  local path="$1"
  local github_user enable_pi enable_codex
  github_user="$(toml_string_value "${path}" identity github_user)"
  enable_pi="$(config_bool harness.pi true "${path}")"
  enable_codex="$(config_bool harness.codex false "${path}")"

  github_user="${INPUT_GITHUB_USER:-${github_user:-CHANGE_ME}}"
  if [ "${github_user}" = "CHANGE_ME" ]; then
    github_user="$(prompt_value "GitHub username" "CHANGE_ME")"
  fi
  if [ -n "${INPUT_ENABLE_PI}" ]; then
    enable_pi="$(normalize_bool "${INPUT_ENABLE_PI}" || die "BECKETT_ENABLE_PI must be true or false")"
  fi
  if [ -n "${INPUT_ENABLE_CODEX}" ]; then
    enable_codex="$(normalize_bool "${INPUT_ENABLE_CODEX}" || die "BECKETT_ENABLE_CODEX must be true or false")"
  fi

  validate_instance_config "${github_user}"
  upsert_toml_literal "${path}" identity github_user "\"${github_user}\""
  upsert_toml_literal "${path}" harness.pi enabled "${enable_pi}"
  upsert_toml_literal "${path}" harness.codex enabled "${enable_codex}"
  if installer_managed_file "${path}" && [ "$(config_bool github.activity missing "${path}")" = "missing" ]; then
    upsert_toml_literal "${path}" github.activity enabled false
  fi
}

configure_instance() {
  local config_path="${BECKETT_STATE}/config.toml"
  local env_path="${BECKETT_STATE}/.env"
  local previous_github_user=""
  as_beckett mkdir -p "${BECKETT_STATE}"
  as_beckett chmod 0700 "${BECKETT_STATE}"
  assert_safe_user_file "${config_path}"
  assert_safe_user_file "${env_path}"

  if [ ! -f "${config_path}" ]; then
    log "creating instance configuration"
    local github_user enable_pi enable_codex
    github_user="${INPUT_GITHUB_USER}"
    enable_pi="$(normalize_bool "${INPUT_ENABLE_PI:-true}" || die "BECKETT_ENABLE_PI must be true or false")"
    enable_codex="$(normalize_bool "${INPUT_ENABLE_CODEX:-false}" || die "BECKETT_ENABLE_CODEX must be true or false")"

    [ -n "${github_user}" ] || github_user="$(prompt_value "GitHub username" "CHANGE_ME")"
    if [ -z "${INPUT_ENABLE_PI}" ]; then
      enable_pi="$(prompt_bool "Enable the Pi worker" "true")"
    fi
    if [ -z "${INPUT_ENABLE_CODEX}" ]; then
      enable_codex="$(prompt_bool "Enable the Codex worker" "false")"
    fi

    validate_instance_config "${github_user}"
    write_initial_config "${config_path}" "${github_user}" "${enable_pi}" "${enable_codex}"
  else
    as_beckett chmod 0600 "${config_path}"
    previous_github_user="$(toml_string_value "${config_path}" identity github_user)"
    update_existing_config "${config_path}"
    log "preserved existing config and applied any explicit installer overrides"
  fi

  if [ ! -f "${env_path}" ]; then
    local env_tmp
    env_tmp="$(mktemp)"
    TEMP_PATHS+=("${env_tmp}")
    printf '# Created by the Beckett installer. Keep this file private.\nDISCORD_TOKEN=\nDISCORD_OWNER_ID=\nDISCORD_OWNER_NAME=\nGITHUB_PAT=\nBECKETT_GH_ORG=\nBECKETT_MAIL_ADDRESS=\nOPENROUTER_REFERER=\nBECKETT_BORED_URL=\nBECKETT_STARTUP_CHANNEL_ID=disabled\n' > "${env_tmp}"
    chown "${BECKETT_USER}:${BECKETT_USER}" "${env_tmp}"
    as_beckett install -m 0600 "${env_tmp}" "${env_path}"
  else
    as_beckett chmod 0600 "${env_path}"
    if installer_managed_file "${env_path}" && [ -z "$(env_value "${env_path}" BECKETT_STARTUP_CHANNEL_ID)" ]; then
      upsert_env "${env_path}" BECKETT_STARTUP_CHANNEL_ID disabled
    fi
  fi

  local key supplied existing
  for key in DISCORD_TOKEN DISCORD_OWNER_ID GITHUB_PAT; do
    case "${key}" in
      DISCORD_TOKEN) supplied="${INPUT_DISCORD_TOKEN}" ;;
      DISCORD_OWNER_ID) supplied="${INPUT_DISCORD_OWNER_ID}" ;;
      GITHUB_PAT) supplied="${INPUT_GITHUB_PAT}" ;;
    esac
    existing="$(env_value "${env_path}" "${key}")"
    if [ -z "${supplied}" ] && [ -z "${existing}" ]; then
      if [ "${key}" = "DISCORD_OWNER_ID" ]; then
        supplied="$(prompt_value "Your Discord user ID" "")"
      else
        supplied="$(prompt_secret "${key}")"
      fi
    fi
    if [ -n "${supplied}" ]; then
      upsert_env "${env_path}" "${key}" "${supplied}"
    fi
  done

  local owner_name existing_owner_name
  existing_owner_name="$(env_value "${env_path}" DISCORD_OWNER_NAME)"
  owner_name="${INPUT_DISCORD_OWNER_NAME:-${existing_owner_name}}"
  [ -n "${owner_name}" ] || owner_name="$(prompt_value "Your display name" "Owner")"
  if [ "${owner_name}" != "${existing_owner_name}" ]; then
    upsert_env "${env_path}" DISCORD_OWNER_NAME "${owner_name}"
  fi

  # Project checkouts use this value independently from identity.github_user. Without the
  # portable override, a third-party install would still try to publish into the 0xbeckett org.
  sync_github_org "${env_path}" "${config_path}" "${previous_github_user}"
}

install_cli_shim() {
  local tmp
  tmp="$(mktemp)"
  TEMP_PATHS+=("${tmp}")
  printf '#!/usr/bin/env bash\nexec "%s/.bun/bin/bun" "%s/src/cli/beckett.ts" "$@"\n' \
    "${BECKETT_HOME}" "${BECKETT_REPO}" > "${tmp}"
  chown "${BECKETT_USER}:${BECKETT_USER}" "${tmp}"
  as_beckett install -m 0755 "${tmp}" "${BECKETT_HOME}/.local/bin/beckett"
}

readiness_problems() {
  local env_path="${BECKETT_STATE}/.env"
  local key value
  for key in DISCORD_TOKEN DISCORD_OWNER_ID GITHUB_PAT; do
    value="$(env_value "${env_path}" "${key}")"
    [ -n "${value}" ] || printf '%s\n' "missing ${key} in ${env_path}"
  done

  local owner_id
  owner_id="$(env_value "${env_path}" DISCORD_OWNER_ID)"
  if [ -n "${owner_id}" ] && [[ ! "${owner_id}" =~ ^[0-9]{17,20}$ ]]; then
    printf '%s\n' "DISCORD_OWNER_ID must be a Discord numeric user id"
  fi

  [ -s "${BECKETT_HOME}/.claude/.credentials.json" ] ||
    printf '%s\n' "Claude is not logged in"
  if [ "$(config_bool harness.pi true)" = "true" ] && [ ! -s "${BECKETT_HOME}/.pi/agent/auth.json" ]; then
    printf '%s\n' "Pi is enabled but not logged in"
  fi
  if [ "$(config_bool harness.codex false)" = "true" ] && [ ! -s "${BECKETT_HOME}/.codex/auth.json" ]; then
    printf '%s\n' "Codex is enabled but not logged in"
  fi

  if [ "$(toml_string_value "${BECKETT_STATE}/config.toml" identity github_user)" = "CHANGE_ME" ]; then
    printf '%s\n' "GitHub username is still CHANGE_ME in ${BECKETT_STATE}/config.toml"
  fi
}

preflight_tracker() {
  log "validating the bored tracker connection"
  local board
  board="$(as_beckett_in_repo "${BECKETT_HOME}/.bun/bin/bun" -e \
    'const { loadConfig } = await import("./src/config.ts"); console.log(loadConfig().tracker.default_board);')"
  [ -n "${board}" ] || die "no tracker board is configured"
  if ! as_beckett "${BECKETT_HOME}/.local/bin/beckett" ticket list --board "${board}" >/dev/null; then
    die "the bored tracker is unreachable; ensure the bored service is running (BECKETT_BORED_URL, default http://127.0.0.1:7770), then rerun the installer"
  fi
}

install_units() {
  local uid
  uid="$(id -u "${BECKETT_USER}")"
  local runtime_dir="/run/user/${uid}"
  local bus="unix:path=${runtime_dir}/bus"
  local problems
  problems="$(readiness_problems)"

  log "linking units and staging the daemon while installation checks run"
  as_beckett env XDG_RUNTIME_DIR="${runtime_dir}" DBUS_SESSION_BUS_ADDRESS="${bus}" \
    "${BECKETT_REPO}/deploy/install.sh" --no-start

  if [ "${NO_START}" -eq 1 ] || [ -n "${problems}" ]; then
    if [ -n "${problems}" ]; then
      warn "Beckett is installed but not started:"
      while IFS= read -r problem; do
        [ -n "${problem}" ] && printf '  - %s\n' "${problem}" >&2
      done <<< "${problems}"
    fi
    return
  fi

  preflight_tracker
  log "configuration is complete; enabling and starting Beckett"
  as_beckett env XDG_RUNTIME_DIR="${runtime_dir}" DBUS_SESSION_BUS_ADDRESS="${bus}" \
    "${BECKETT_REPO}/deploy/install.sh"
  if ! as_beckett "${BECKETT_HOME}/.local/bin/beckett" doctor; then
    as_beckett env XDG_RUNTIME_DIR="${runtime_dir}" DBUS_SESSION_BUS_ADDRESS="${bus}" \
      "${BECKETT_REPO}/deploy/install.sh" --no-start >/dev/null 2>&1 || true
    die "post-start doctor failed; Beckett was disabled again. Fix the reported check, then rerun ${BECKETT_REPO}/install.sh --non-interactive"
  fi
}

print_finish() {
  local problems
  problems="$(readiness_problems)"
  printf '\nBeckett is installed at %s.\n' "${BECKETT_REPO}"
  if [ -z "${problems}" ] && [ "${NO_START}" -eq 0 ]; then
    printf 'The daemon is running. Check it with: sudo -iu %s beckett status --pretty\n' "${BECKETT_USER}"
    return
  fi

  if [ -z "${problems}" ]; then
    printf 'The daemon was left stopped because --no-start was supplied. Run the validated start path with:\n'
    printf '  sudo %s/install.sh --repo %s --ref %s --non-interactive\n' \
      "${BECKETT_REPO}" "${REPO_URL}" "${REPO_REF}"
    return
  fi

  printf '\nFinish the account logins as the %s user:\n' "${BECKETT_USER}"
  [ -s "${BECKETT_HOME}/.claude/.credentials.json" ] ||
    printf '  sudo -iu %s claude auth login\n' "${BECKETT_USER}"
  if [ "$(config_bool harness.pi true)" = "true" ] && [ ! -s "${BECKETT_HOME}/.pi/agent/auth.json" ]; then
    printf '  sudo -iu %s pi        # run /login, then choose ChatGPT Plus/Pro\n' "${BECKETT_USER}"
  fi
  if [ "$(config_bool harness.codex false)" = "true" ] && [ ! -s "${BECKETT_HOME}/.codex/auth.json" ]; then
    printf '  sudo -iu %s codex login --device-auth\n' "${BECKETT_USER}"
  fi
  printf '\nFill any missing values in %s, then rerun:\n' "${BECKETT_STATE}/.env"
  printf '  sudo %s/install.sh --repo %s --ref %s --non-interactive\n' \
    "${BECKETT_REPO}" "${REPO_URL}" "${REPO_REF}"
}

main() {
  parse_args "$@"
  require_supported_host
  install_base_packages
  install_github_cli
  ensure_beckett_user
  verify_browser_sandbox
  install_node
  install_user_toolchain
  clone_or_update_repo
  install_app_dependencies
  configure_instance
  install_cli_shim
  install_units
  print_finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
