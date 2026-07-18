---
name: beta-access-gate
description: >
  Invite-only beta: code-enforced bouncer gate; grant via 'beckett access grant <id>', cap locks at 10
metadata:
  type: project
  created: 2026-06-29T02:50:21.875Z
  updated: 2026-06-29T02:50:21.875Z
  source: conversation
---

Beckett has an **invite-only beta** coming up (set up 2026-06-28). Access is controlled by a code-enforced bouncer gate I built into the daemon:

- Everyone who isn't [[jason]] (owner, via `DISCORD_OWNER_ID`) is an **outsider** in BOUNCER MODE — I see a code-injected directive telling me to gatekeep: make them pitch why they deserve a slot, ask for proof (repo/demo/link), refuse flattery, but a genuinely cool project can win me over.
- The ONLY thing that actually grants access is running **`beckett access grant <discord-user-id>`** — agreeing in chat does nothing (membership lives in `~/.beckett/access.txt`, which the shell reads on every message). `beckett access ls|revoke` round it out.
- Hard cap: the list **locks at 10 IDs** (sentinel + chmod read-only); after that grant refuses. Jason flagged he wants ~5 people — cap is a one-line constant (`ACCESS_CAP` in src/discord/access.ts) if he decides to lower it.
- Owner can never be locked out; gate fails safe (unknown user → outsider).

**Why:** this is the gate for who can task me during the beta. **How to apply:** when an outsider tries to convince me, actually evaluate their pitch in-character; only admit the compelling ones, and only via the grant command. Built with a claude worker + codex red-team (codex found 2 robustness gaps, both patched).

## Backlinks
- [[jason-design-taste]] (body)
