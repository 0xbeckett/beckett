---
name: v5-publisher-ff-main
description: "v5-daemon phases whose commit parents on main's tip get auto-FF'd onto main — catch and revert each time"
metadata: 
  node_type: memory
  type: project
  originSessionId: c60f4a48-cc9f-4bec-b5d9-b17ef2d47465
---

During the V5 daemon refactor (ro/Jason, `--project beckett`), the auto-publisher **fast-forwards main** whenever a finished phase's branch commit sits directly on main's tip (parent == origin/main). Happened on Phase 0 (OPS-178) and Phase 1c (OPS-181). This violates ro's hard rule: NOTHING to main until the final single `v5-daemon → main` PR he merges himself. It also leaves main broken (e.g. 1c's builtins.ts imports capability/index.ts which only exists on v5-daemon).

**Why:** phase workers commit onto the local Phase-0 branch but the recorded git parent ends up being main's baseline (bdccd3f), so publish sees a clean FF and takes it.

**How to apply:** after each phase finishes, `git fetch` and check `origin/main` is still the baseline. If it got FF'd, revert the phase commit off main (`git revert --no-edit <sha>` → tree returns to baseline, consistent with the revert-not-rewind approach ro accepted) and `beckett gh push --branch main`. Courier the real work onto v5-daemon separately via cherry-pick. `beckett gh` can't force-push, so revert (not rewind) is the tool. I offered ro a real fix: make publish skip main entirely for v5-daemon-cast work. See [[land-tickets-courier-early]].

**RESOLVED 2026-07-15:** all 7 phases (0, 1a, 1b, 1c, 2, 3, 4) are couriered onto `v5-daemon`, integrated + green. main held pristine at baseline **181d6f6** the whole way (for the last two phases the publisher's main-rebase actually *conflicted* and was blocked, so no revert needed). The single clean **`v5-daemon → main` PR is #114** — left UNMERGED for ro to press himself, then a real deploy to go live (a merge alone isn't live — see [[restart-is-not-deploy]]). OPS-185 publisher-fix is done but likely still needs a deploy to actually stop the FF behavior; moot now that phases are landed, but verify before any future v5-style stacked work.
