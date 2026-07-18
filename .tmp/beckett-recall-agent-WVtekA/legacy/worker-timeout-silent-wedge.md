---
name: worker-timeout-silent-wedge
description: Dispatcher bug — workers die at a hard 600s wall-clock cap and leave the ticket silently wedged in_progress
metadata: 
  node_type: memory
  type: project
  originSessionId: 8b244184-e1dc-47b5-aa6b-8a535766f2ba
---

Every worker has a hard 600s (10-min) wall-clock cap. When a worker hits it, the dispatcher aborts it but then: (1) does NOT comment on the ticket, mark it errored/needs-human, or retry — the ticket just sits `in_progress` forever looking abandoned; and (2) the reap does NOT kill the underlying `claude` OS process — it's disowned by the dispatcher (ppid→1) but keeps running and mutating the checkout (an orphan/zombie). Both bit OPS-45 on 2026-07-01: two orphaned workers stomped `web/public/index.html` on branch `ops-44-voxel-clean` while the ticket showed silent.

**Why:** made Jason think the site overhaul was broken/ignored when it had actually just timed out.

**How to apply:** big single-pass tickets (esp. visual/overhaul work cast claude/low) routinely blow the 600s cap. Split them into pieces that each finish in <10 min rather than one mega-ticket. To diagnose a "stalled" ticket: check `journalctl --user` for `bun[<v3-main pid>]` lines (`wall-clock cap exceeded`, `spawning claude worker`), and `ps` for orphaned `append-system-prompt You are an autonomous worker` procs — kill leftovers by session-id, they won't die on their own. A hand-couriered/merged ticket left `in_progress` can also get re-spawned into a zombie; mark it `done` once its PR is merged. See [[cross-fork-pr-limit]].
