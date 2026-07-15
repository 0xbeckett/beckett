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
# BetterWright's documented setup provisions its managed runtime. Beckett deliberately
# uses BetterWright's explicit pinned-Playwright Chromium fallback inside bubblewrap.
bun x betterwright setup
bun x playwright install --no-shell chromium
browser_smoke() {
  bun -e 'import { chromium } from "playwright"; const browser = await chromium.launch({ headless: true, channel: "chromium" }); await browser.close();'
}
if ! browser_smoke; then
  echo "Chromium is installed but cannot launch; attempting one-time Linux dependency provisioning" >&2
  if ! sudo -n "$(command -v bun)" x playwright install-deps chromium; then
    echo "FATAL: Chromium system libraries are missing and passwordless sudo is unavailable." >&2
    echo "Run once as an administrator: cd /home/beckett/beckett && sudo /usr/bin/env PATH=/home/beckett/.bun/bin:/usr/local/bin:/usr/bin:/bin bun x playwright install-deps chromium" >&2
    exit 1
  fi
  browser_smoke
fi
command -v bwrap >/dev/null || {
  echo "FATAL: bubblewrap is required for the isolated browser host; install the bubblewrap package." >&2
  exit 1
}
command -v prlimit >/dev/null || {
  echo "FATAL: prlimit (util-linux) is required for browser evaluator resource limits." >&2
  exit 1
}
bwrap --unshare-all --share-net --die-with-parent --ro-bind / / /bin/true || {
  echo "FATAL: bubblewrap is installed but user namespaces are blocked; see deploy/host-setup.md." >&2
  exit 1
}
bun run browser:smoke
bun x tsc --noEmit                      # never restart onto broken code
# prune the dead per-worker branches the retired flow left behind (and any new strays).
# Two patterns because for-each-ref globs are pathname-aware: `*` stops at `/`, so nested
# branches like beckett/wk_0012f678/OPS-11 need the `/**` form.
git for-each-ref --format='%(refname:short)' 'refs/heads/beckett/wk_*' 'refs/heads/beckett/wk_*/**' | xargs -r git branch -D
# Self-healing unit install (v3→v4 cutover): if the beckett-v4 unit isn't linked yet, this box
# still has the old unit — run install.sh (idempotent) to link v4 and retire the stale ones.
systemctl --user cat beckett-v4.service >/dev/null 2>&1 || ~/beckett/deploy/install.sh
systemctl --user restart beckett-v4.service
sleep 5
systemctl --user is-active beckett-v4.service
journalctl --user -u beckett-v4.service -n 12 --no-pager -o cat
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
