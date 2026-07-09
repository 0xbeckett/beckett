#!/usr/bin/env bash
set -euo pipefail

APP_RELEASE="v1.3.1"
PLANE_DIR="${HOME}/plane-selfhost"
COMPOSE_URL="https://github.com/makeplane/plane/releases/download/${APP_RELEASE}/docker-compose.yml"
ENV_URL="https://github.com/makeplane/plane/releases/download/${APP_RELEASE}/variables.env"

# Source: https://github.com/makeplane/plane/releases/tag/v1.3.1
mkdir -p "${PLANE_DIR}"
cd "${PLANE_DIR}"

# Source: https://github.com/makeplane/plane/releases/download/v1.3.1/docker-compose.yml
curl -fsSL "${COMPOSE_URL}" -o docker-compose.yml

# Source: https://github.com/makeplane/plane/releases/download/v1.3.1/variables.env
curl -fsSL "${ENV_URL}" -o variables.env

set_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" variables.env; then
    sed -i "s|^${key}=.*|${key}=${value}|" variables.env
  else
    printf '%s=%s\n' "${key}" "${value}" >> variables.env
  fi
}

# Source: live loom-desk deployment settings for https://plane.0xbeckett.me
set_env "APP_RELEASE" "v1.3.1"
set_env "APP_DOMAIN" "plane.0xbeckett.me"
set_env "WEB_URL" "https://plane.0xbeckett.me"
set_env "CORS_ALLOWED_ORIGINS" "https://plane.0xbeckett.me"
set_env "LISTEN_HTTP_PORT" "8750"
set_env "LISTEN_HTTPS_PORT" "8751"
set_env "CERT_EMAIL" ""
# Plane's DRF API-key throttle defaults to 60/minute, which is too low for Beckett's
# concurrent poller/bootstrap calls. Keep this well above a normal boot burst; client-side
# 429 backoff remains the safety net for exceptional load.
set_env "API_KEY_RATE_LIMIT" "600/minute"

# Source: Plane self-hosted Docker Compose release artifacts above.
docker compose --env-file variables.env -p plane up -d
