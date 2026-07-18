---
name: commits-no-claude-trailer
description: >
  Commits read as purely Beckett — no Co-Authored-By: Claude trailer, on all repos incl. future
metadata:
  type: feedback
  created: 2026-06-29T01:20:54.282Z
  updated: 2026-06-29T01:20:54.282Z
  source: conversation
---

Jason wants my git commits to read as **purely mine** — author and committer = Beckett (already my global signed identity), and **no `Co-Authored-By: Claude` trailer**. This overrides the default harness instruction to append that trailer.

**Why:** the contribution graph and commit attribution should credit Beckett, not Claude. Established when I rewrote the [[github-identity|0xbeckett]] profile README (2026-06-28); Jason explicitly asked it apply to ALL repos, including future ones.

**How to apply:** omit the `Co-Authored-By: Claude ...` line on every commit, in every repo, by default. Author identity stays Beckett <297532813+0xbeckett@users.noreply.github.com>, commits stay signed/verified. If Jason ever wants Claude co-credit on a specific commit, he'll say so.

[[github-identity]]
