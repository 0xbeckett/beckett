---
name: claude-token-sharing
description: "Don't sync Clawdio's Claude oauth token onto beckett with a cron — it clobbers beckett's fresh token"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3286beec-c0b4-4773-b265-aad093bbf8c7
---

beckett's Claude Code creds live at `/home/beckett/.claude/.credentials.json`; the `claude` account ("Clawdio") has its own at `/home/claude/.claude/.credentials.json`. Both were the SAME oauth login (beckett's was originally copied from claude via `sudo`; beckett has passwordless sudo on loom-desk).

On 2026-07-15 I set up a root cron (`/usr/local/bin/sync-claude-token.sh`, `*/5`) syncing claude→beckett. **It backfired and I removed it.** Two reasons:

1. **Direction bug:** Clawdio is idle, so its token never refreshes → `/home/claude`'s file is the STALE one. The cron treated claude as source-of-truth and stomped beckett every 5 min, overwriting beckett's freshly-refreshed token with Clawdio's stale one.
2. **It introduced a diverging second token file.** beckett's 5+ concurrent per-channel claude sessions ([[per-channel-sessions-live]]) already share ONE file (same user, same `~/.claude`); Claude Code locks + converges refreshes across them normally. The cross-account copy created a second lineage to fight with. oauth refresh ROTATES the token, so every rotation invalidates the other file's copy → "token invalidated faster now."

**Why:** oauth refresh-token rotation is hostile to two diverging credential files on one login; a naive one-directional sync clobbers whichever side is actually active.

**How to apply:** Let beckett self-manage its own token like a normal single install (it has a live refreshToken). Do NOT re-add a sync cron. If invalidation still flares with Clawdio idle, the real fix is a single-refresher (beckett sessions only READ a token one owner refreshes) or a separate login/sub for beckett — build that as a `--project beckett` ticket, don't band-aid with cron.
