---
name: discord-file-attach
description: How to actually attach a file in Discord + the server upload cap
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6450e5a4-04d0-4193-b5f5-4e05294d6b9a
---

To attach a real playable file to a Discord message, use `beckett discord reply --channel <id> --file <path> "..."`. The flag is singular **`--file`** (repeatable), NOT `--files` — passing `--files` is silently dropped so the message posts as text/link with no attachment.

The becketttv/drops server is on the **10MB upload tier**. Anything over ~10MB gets rejected with `Request entity too large` (Discord 413, not a bus limit — the control bus uses a 4-byte length prefix and handles huge frames fine). For a ~9min 1080p video, that means re-encoding down: 480p, single-pass libx264 `-b:v 80k -c:a aac -b:a 48k` lands ~8.7MB. Two-pass ffmpeg OOM-killed (exit 137) on this box — use single-pass with `-threads 2` + `nice`.

**Why:** burned 3 posts claiming "it's attached" when it was a bare link — owner had to screenshot proof it wasn't there.
**How to apply:** never claim a file is posted until the CLI returns a `messageId` from a `--file` reply that cleared the size cap. Pre-compress big video to under 10MB before the first post attempt. 480p framed as intentional/retro reads fine.
