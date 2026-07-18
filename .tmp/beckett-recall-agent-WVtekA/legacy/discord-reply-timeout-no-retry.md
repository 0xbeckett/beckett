---
name: discord-reply-timeout-no-retry
description: beckett discord reply control-bus timeout usually still posted — do NOT retry or you double-post
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a60b609d-064f-4dc1-8869-89bfd583e35c
---

When `beckett discord reply` fails with `control bus timeout after 30000ms`, the message has
almost certainly still posted to Discord — the CLI just didn't get the daemon's ack in time
(the daemon is slow to ack, especially right after a restart). Do NOT re-run the command: a
retry posts a second identical message. This burned me on 2026-07-09 — two identical acks plus
a stray "test" all landed in #general while every invocation reported a timeout, and Jason
noticed.

**Why:** the control-bus ack times out even when the underlying Discord send succeeded, so a
false-failure that looks retryable actually isn't.

**How to apply:** on a `control bus timeout`, assume it sent. Don't retry. If you must confirm,
check the channel/recent messages rather than blindly re-sending. Fix is tracked in OPS-112
(idempotent/deduped send + honest ambiguous-vs-failed status). Remove this note once OPS-112
ships and the retry is safe again.
