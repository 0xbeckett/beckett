#!/usr/bin/env bash
# Beckett — THE deploy (issue #29). Run from the Mac after a PR merges to main:
#   ./deploy/deploy-prod.sh
# Prod (~/beckett on loom-desk) only ever runs origin/main: fetch, ff-only pull, typecheck,
# restart, health read-back. Also tags the deployed version (from package.json) and prunes
# dead wk_* worker branches so the graveyard never regrows.
set -euo pipefail

HOST="${BECKETT_HOST:-beckett@loom-desk}"

# ── self-deploy survival guard (issue #81) ──────────────────────────────────────────────────
# When beckett deploys ITSELF, the running daemon spawns this script, so it (and its ssh child)
# land INSIDE beckett-v4.service's cgroup. The remote `systemctl --user restart beckett-v4.service`
# below tears down that whole cgroup (systemd's default KillMode=control-group), which used to kill
# this script mid-run — before the annotated release tag was created and pushed. Package.json got
# bumped and main pushed, but `git ls-remote --tags origin vX.Y.Z` stayed empty and the log
# truncated at the restart with no "deploy complete".
#
# The killer is cgroup MEMBERSHIP, so escape it: re-exec the whole script into a transient user
# *scope* — a sibling of beckett-v4.service under the user manager, not a child of it. The restart
# can no longer reach us, so the ssh client stays connected, the remote health gate returns
# normally, and the post-restart tag push runs in order (no tag-before-successful-restart, no
# double-tag — ordering is unchanged). This is a no-op off the daemon host (e.g. the Mac, or an
# interactive shell on loom-desk), where this script isn't a child of beckett-v4.service.
if [ -z "${BECKETT_DEPLOY_SCOPED:-}" ] && grep -qs 'beckett-v4\.service' /proc/self/cgroup; then
  echo "== self-deploy detected: re-exec into a detached user scope so the restart can't kill us =="
  command -v systemd-run >/dev/null || {
    echo "FATAL: running inside beckett-v4.service's cgroup but systemd-run is unavailable; the" >&2
    echo "restart would kill this script before the release tag is pushed. Install systemd-run" >&2
    echo "(part of systemd) or run the deploy from a shell outside the daemon's cgroup." >&2
    exit 1
  }
  exec env BECKETT_DEPLOY_SCOPED=1 systemd-run --user --scope --quiet -- "$0" "$@"
fi

# ── smart semver bump (OPS-188) ─────────────────────────────────────────────────────────────
# BEFORE we ship the merge, decide whether this release is a MINOR (new capability) or a PATCH
# (fix / internal / behavior-preserving) from the commits since the last deployed tag, then write
# + commit the new version to the source of truth (package.json). The same commit also cuts
# CHANGELOG.md — the `## Unreleased` block moves under a dated `## vX.Y.Z` heading and a fresh stub
# is left behind (issue #147) — so the changelog and version can never drift. MAJOR is owner-only — it never
# comes from the classifier, only an explicit override. The suggestion is CONFIRMABLE: run
# interactively and beckett prompts; or pre-decide non-interactively with
#   BECKETT_BUMP=minor|patch|major|yes ./deploy/deploy-prod.sh
# ("yes" accepts the auto suggestion). The bump commit must reach origin/main before prod pulls,
# so we sync main, bump, and push here.
echo "== computing version bump since last deploy =="
git fetch origin --tags --prune
git checkout main
git pull --ff-only origin main
BUMP_FLAG=""
case "${BECKETT_BUMP:-}" in
  minor) BUMP_FLAG="--minor" ;;
  patch) BUMP_FLAG="--patch" ;;
  major) BUMP_FLAG="--major" ;;
  yes)   BUMP_FLAG="--yes" ;;
  "")    : ;;  # interactive: beckett prompts for confirm/override
  *)     echo "FATAL: BECKETT_BUMP must be one of minor|patch|major|yes" >&2; exit 1 ;;
esac
# ${VAR:+"$VAR"} → nothing when empty (safe under set -u, portable to bash 3.2 on the Mac).
if bun run beckett version bump ${BUMP_FLAG:+"$BUMP_FLAG"}; then
  git push origin main          # ship the release-bump commit so prod ff-pulls it below
else
  echo "FATAL: version bump aborted — not deploying" >&2
  exit 1
fi

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

# Record the verified deployment with an annotated release tag and push it via git's explicit
# tag refspec. Do not use `beckett gh push` here: its branch-only API rejects refs/tags/* (GH014).
# A pre-existing tag must already be an annotated tag on this exact release commit; silently
# accepting a local lightweight/stale tag would let package.json and origin's history drift again.
VERSION="v$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
HEAD_COMMIT="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null; then
  [ "$(git cat-file -t "refs/tags/${VERSION}")" = "tag" ] || {
    echo "FATAL: existing ${VERSION} is not an annotated tag" >&2
    exit 1
  }
  [ "$(git rev-list -n 1 "${VERSION}")" = "${HEAD_COMMIT}" ] || {
    echo "FATAL: existing ${VERSION} does not point at the release commit" >&2
    exit 1
  }
  echo "== annotated tag ${VERSION} already exists =="
else
  git -c tag.gpgSign=false tag -a "${VERSION}" -m "beckett: release ${VERSION}"
  echo "== created annotated tag ${VERSION} =="
fi
# The fully-qualified refspec is accepted by git/GitHub and guarantees the release tag reaches
# origin, unlike the branch-oriented `beckett gh push` interface.
git push -q origin "refs/tags/${VERSION}:refs/tags/${VERSION}"
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/${VERSION}" | awk '{print $1}')"
LOCAL_TAG="$(git rev-parse "refs/tags/${VERSION}")"
[ "${REMOTE_TAG}" = "${LOCAL_TAG}" ] || {
  echo "FATAL: origin did not retain ${VERSION} after push" >&2
  exit 1
}
echo "== tagged and pushed ${VERSION} =="
echo "== deploy complete =="
