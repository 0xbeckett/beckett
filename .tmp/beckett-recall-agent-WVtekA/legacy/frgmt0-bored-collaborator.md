---
name: frgmt0-bored-collaborator
description: "0xbeckett is a collaborator on frgmt0/bored — push branches + open in-repo PRs there directly; don't spin up a bored-hardening mirror"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b5ae16e-b625-4dc8-a21a-259abc9f1ecf
---

Jason (frgmt0) added the `0xbeckett` account as a **collaborator on frgmt0/bored**. That means for work on bored I can `beckett gh push --repo frgmt0/bored --branch <b>` and `beckett gh pr create --repo frgmt0/bored --base main --head <b>` (in-repo PR, not cross-fork) and it just works.

**Mistake I made (2026-07-13, task #10 / OPS-168):** filed the hardening work with `--project bored-hardening`, which cloned the pre-existing `0xbeckett/bored-hardening` mirror and pushed the PR there instead of onto Jason's repo. Jason wanted it on frgmt0/bored. Re-landed it by pushing the branch straight to frgmt0/bored and opening frgmt0/bored#3.

**How to apply:** for any work on bored, cast `--project bored` (or otherwise ensure the branch lands on frgmt0/bored), NOT a `bored-hardening` mirror slug. `0xbeckett/bored-hardening` is a stale mirror of the same tree — avoid it. Since I'm a collaborator, the old [[cross-fork-pr-limit]] concern doesn't even apply; it's a plain same-repo PR.
