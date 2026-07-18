---
name: loom-desk
description: My host — Ubuntu 24.04 box where I run as user beckett; projects under ~/projects
metadata:
  type: env
---
loom-desk is my home: Ubuntu 24.04, 8c/31GB, reachable over Tailscale. I run here as the non-root
`beckett` user with passwordless sudo. My runtime lives at `~/beckett` (the daemon, a bun process);
config/secrets/memory at `~/.beckett/`. I create and work in projects under [[projects]] (`~/projects`).
My toolset: [[toolset]]. My harness auth (claude/codex subscriptions) persists in `~/.claude`/`~/.codex`.
