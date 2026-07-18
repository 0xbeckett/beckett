---
name: cross-fork-pr-limit
description: Cross-fork PRs on external repos now WORK via the classic PAT (confirmed OPS-60); native beckett pr create, no compare-link fallback needed
metadata: 
  node_type: memory
  type: reference
  originSessionId: d7144cd4-a331-4b7a-9141-0bde7fbb600b
---

Historically the `0xbeckett` fine-grained PAT (used by `beckett gh`) was scoped to our own account, so `beckett gh pr create` against a repo we don't own failed with `GraphQL: Resource not accessible by personal access token (createPullRequest)`. Observed on OPS-29 (SSHdotCodes/probabilities), 2026-06-30.

**Update 2026-06-30 (per Jason):** new workspace rules were supposed to allow forking to `0xbeckett/<repo>` and opening the cross-fork PR upstream directly.

**RE-CONFIRMED STILL BROKEN 2026-07-01 (OPS-33):** the limit was still live under the fine-grained PAT. Pushing the branch to `0xbeckett/<repo>` works fine, but `beckett gh pr create --repo <upstream> --head 0xbeckett:<branch>` failed with `GraphQL: Resource not accessible by personal access token (createPullRequest)`. **Fallback: hand a compare link** `https://github.com/<upstream-owner>/<repo>/compare/main...0xbeckett:<repo>:<branch>?expand=1`.

**Token swapped to CLASSIC 2026-07-02 (per Jason):** he switched `beckett gh`'s token to a classic PAT to allow forking + opening the cross-fork PR directly.

**CONFIRMED WORKING 2026-07-02 (OPS-60):** the classic PAT opened a native cross-fork PR on an external repo end-to-end — https://github.com/SSHdotCodes/second-opinion/pull/15. The old `Resource not accessible` limit is GONE under the classic token. **Default now: attempt the native cross-fork PR directly (`beckett gh pr create --repo <upstream> --head 0xbeckett:<branch>`).** The compare-link fallback (§above) is only a break-glass if a future auth regression re-breaks it.
