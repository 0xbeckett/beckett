---
name: restart-is-not-deploy
description: restarting the daemon only clears context; getting merged beckett code live needs a real deploy (ff-pull main + restart)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9d97c4cb-adca-4492-84bf-601923970512
---

Restarting `beckett-v4.service` only clears my context — it reloads the SAME checkout at `~/beckett`, so merged code does NOT go live from a bare restart. On 2026-07-08 ro merged OPS-97 (board routing) and asked me to "restart the daemon"; I restarted, but the running commit was unchanged. Ro caught it ("the commit it shows is the same as before").

**Why:** the daemon runs from `WorkingDirectory=/home/beckett/beckett`. A restart re-execs the same files; only a `git pull` to `origin/main` changes what runs.

**How to apply:** when a `--project beckett` ticket merges to `origin/main` and the change needs to go live, do a REAL deploy, not just a restart. Canonical path is `~/beckett/deploy/deploy-prod.sh` (fetch → checkout main → `git pull --ff-only` → `bun install --frozen-lockfile` → `bun x tsc --noEmit` gate → restart → health check). Since I run ON the box, I can do the steps in-place: verify clean tree, ff-pull, install, **tsc must pass before restart**, then fire the restart from a detached transient scope (`systemd-run --user --collect --unit=... bash -c 'sleep 2; systemctl --user restart beckett-v4.service'`) so it survives killing my own process. See [[self-deploy-ssh-to-self]].
