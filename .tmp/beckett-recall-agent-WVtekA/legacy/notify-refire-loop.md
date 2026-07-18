---
name: notify-refire-loop
description: duplicate ticket-update notifications likely share the OPS-112 control-bus timeout root cause
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb531a3-bfbb-457b-b393-e5c4d88af4cc
---

On 2026-07-09 a stably-`done` ticket (OPS-111) re-fired its "review passed — done" update to the concierge 4x in a row; the ticket state never flapped, so the loop is in the notify dispatch, not ticket state.

Strong suspicion it's the same root cause as [[discord-reply-timeout-no-retry]] / OPS-112: the concierge acks each update via `beckett discord reply`, that returns `control bus timeout after 30000ms` (even though it posted), and something upstream reads the timed-out ack as "notification not delivered" and re-queues the same done-event.

**Why:** it's not just a duplicate-DM problem — the same false-timeout produces a duplicate-*notification* loop.

**How to apply:** when OPS-112 lands, confirm the update/notify path also stops re-firing on an ack timeout (the honest "sent-but-ack-timed-out" status should cover it). If dupes persist after OPS-112, file a separate ticket for the notify dispatch. Until then: on repeat identical done-updates, ping the human ONCE and stay quiet on the rest.
