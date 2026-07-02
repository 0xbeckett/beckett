#!/usr/bin/env bash
# Beckett — THE deploy (issue #29). Run from the Mac after a PR merges to main:
#   ./deploy/deploy-prod.sh
# Prod (~/beckett on loom-desk) only ever runs origin/main: fetch, ff-only pull, typecheck,
# restart, health read-back. Also tags the deployed version (from package.json) and prunes
# dead wk_* worker branches so the graveyard never regrows.
set -euo pipefail

HOST="${BECKETT_HOST:-beckett@loom-desk}"

echo "== deploying origin/main to ${HOST} =="
ssh "${HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
cd ~/beckett
if [ -n "$(git status --porcelain)" ]; then
  echo "FATAL: deploy checkout is dirty — ~/beckett must never be edited by hand:" >&2
  git status --short >&2
  exit 1
fi
git fetch origin
git checkout main
git pull --ff-only origin main
bun install --frozen-lockfile
bun x tsc --noEmit                      # never restart onto broken code
# prune the dead per-worker branches the retired flow left behind (and any new strays).
# Two patterns because for-each-ref globs are pathname-aware: `*` stops at `/`, so nested
# branches like beckett/wk_0012f678/OPS-11 need the `/**` form.
git for-each-ref --format='%(refname:short)' 'refs/heads/beckett/wk_*' 'refs/heads/beckett/wk_*/**' | xargs -r git branch -D
systemctl --user restart beckett-v3.service
sleep 5
systemctl --user is-active beckett-v3.service
journalctl --user -u beckett-v3.service -n 12 --no-pager -o cat
REMOTE

# Tag the deployed version (one source: package.json) — skip if the tag already exists.
VERSION="v$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
if git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null; then
  echo "== tag ${VERSION} already exists — not re-tagging =="
else
  git tag "${VERSION}"
  git push -q origin "${VERSION}"
  echo "== tagged ${VERSION} =="
fi
echo "== deploy complete =="
