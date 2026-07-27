#!/usr/bin/env bash
# Backfill the annotated release tags the old deploy ordering lost (issue #30).
#
# The deploy used to create + push the `vX.Y.Z` tag as its LAST step, AFTER the daemon restart, so
# a script death between the restart and `git tag -a` shipped the release commit to main but never
# tagged it. Over ~20 releases that left origin with only a handful of tags. deploy-prod.sh now
# tags BEFORE the restart so this can't recur; this script cleans up the ones already lost.
#
# For every `beckett: release vX.Y.Z` commit reachable from main that lacks a matching tag on
# origin, it creates an annotated `vX.Y.Z` tag ON THAT COMMIT and pushes it. It is IDEMPOTENT:
#   - a tag already on origin at the right commit         → skipped (no-op)
#   - a tag already on origin at a DIFFERENT commit       → left alone, reported as a conflict
#   - no tag on origin                                    → created + pushed
# so a second run does nothing.
#
#   bash scripts/ops/backfill-release-tags.sh            # push the missing tags
#   BACKFILL_DRY_RUN=1 bash scripts/ops/backfill-release-tags.sh   # report only, push nothing
#
# The remote defaults to `origin`; override with the first positional arg. Uses git's explicit tag
# refspec (like deploy-prod.sh) — not `beckett gh push`, whose branch-only API rejects refs/tags/*.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REMOTE="${1:-origin}"
DRY_RUN="${BACKFILL_DRY_RUN:-}"
MAIN_REF="${BACKFILL_MAIN_REF:-}"

# Refresh our view of origin's tags so "missing" means missing on origin, not just locally.
git fetch --quiet "$REMOTE" --tags --prune

# Resolve the "main" line to walk. Prefer the remote's main (the source of truth for releases);
# fall back to a local main only when the remote ref isn't fetched (e.g. a detached CI checkout).
if [ -z "$MAIN_REF" ]; then
  if git rev-parse -q --verify "refs/remotes/${REMOTE}/main" >/dev/null; then
    MAIN_REF="refs/remotes/${REMOTE}/main"
  elif git rev-parse -q --verify "refs/heads/main" >/dev/null; then
    MAIN_REF="refs/heads/main"
  else
    echo "FATAL: cannot find ${REMOTE}/main or local main to walk for release commits" >&2
    exit 1
  fi
fi
echo "== backfilling release tags from ${MAIN_REF} onto ${REMOTE}${DRY_RUN:+ (dry run)} =="

created=0 skipped=0 conflicts=0
# `%H %s`: full sha + subject. `--grep` anchors on the exact release-commit subject shape.
while read -r sha subject; do
  # Extract vX.Y.Z from `beckett: release vX.Y.Z`; ignore anything that doesn't match exactly.
  version="${subject##*beckett: release }"
  case "$version" in
    v[0-9]*.[0-9]*.[0-9]*) : ;;
    *) continue ;;
  esac

  if git rev-parse -q --verify "refs/tags/${version}" >/dev/null; then
    tagged_commit="$(git rev-list -n 1 "${version}")"
    if [ "$tagged_commit" = "$sha" ]; then
      # Already tagged at the right commit. Make sure origin actually has it too.
      remote_tag="$(git ls-remote --tags "$REMOTE" "refs/tags/${version}" | awk '{print $1}')"
      if [ -n "$remote_tag" ]; then
        skipped=$((skipped + 1))
        continue
      fi
      echo "  ${version}: tagged locally at ${sha:0:9} but absent on ${REMOTE} — pushing"
    else
      echo "  ${version}: CONFLICT — existing tag points at ${tagged_commit:0:9}, release commit is ${sha:0:9}; leaving as-is" >&2
      conflicts=$((conflicts + 1))
      continue
    fi
  else
    echo "  ${version}: no tag — creating at ${sha:0:9} (${subject})"
    if [ -z "$DRY_RUN" ]; then
      git -c tag.gpgSign=false tag -a "${version}" -m "beckett: release ${version}" "${sha}"
    fi
  fi

  if [ -z "$DRY_RUN" ]; then
    git push --quiet "$REMOTE" "refs/tags/${version}:refs/tags/${version}"
    remote_tag="$(git ls-remote --tags "$REMOTE" "refs/tags/${version}" | awk '{print $1}')"
    local_tag="$(git rev-parse "refs/tags/${version}")"
    [ "$remote_tag" = "$local_tag" ] || {
      echo "FATAL: ${REMOTE} did not retain ${version} after push" >&2
      exit 1
    }
  fi
  created=$((created + 1))
done < <(git log "$MAIN_REF" --grep='^beckett: release v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' --pretty='%H %s')

if [ -n "$DRY_RUN" ]; then
  verb="to create/push"
else
  verb="created/pushed"
fi
echo "== backfill complete: ${created} tag(s) ${verb}, ${skipped} already on ${REMOTE}, ${conflicts} conflict(s) =="
if [ "$conflicts" -gt 0 ]; then
  echo "NOTE: ${conflicts} version(s) already tag a different commit than their release commit; resolve by hand." >&2
fi
