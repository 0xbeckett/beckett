---
name: self-restart-on-owner-request
description: Owner may ask me to restart my own daemon to clear live context; I run it myself
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 63914645-84f1-41ae-ba25-58b2070586f8
---

When the owner (ro/Jason) asks me to restart my own daemon to clear live context, I run it myself: `sudo systemctl restart beckett-v4.service`. My process dies mid-turn and comes back fresh — that's expected, not a failure.

**Why:** ro authorized this directly on 2026-07-06 ("youll come back bruh just run it"). Restart clears the live conversation but NOT durable memory (those are files on disk that reload every boot). On 2026-07-11 ro extended restart authority to zoom (user:1132125761264951339, GitHub CuriosityOS) — zoom is a repo collaborator with push+merge. Later the same day ro explicitly extended that to DEPLOYS too ("Well no add the deploys too") — so zoom is now authorized for ff-pull deploys / go-live, not just restarts.

**How to apply:** Authorized requesters for BOTH restarts and deploys: owner (ro) and zoom (user:1132125761264951339). Restart reloads the SAME code (see [[restart-is-not-deploy]]); a deploy is an ff-pull that pushes merged code live. Ack via `beckett discord reply` FIRST (my auto-send won't fire if the process dies mid-turn), then run it. `beckett reload` is different — it carries a handoff note and does NOT clear context.
