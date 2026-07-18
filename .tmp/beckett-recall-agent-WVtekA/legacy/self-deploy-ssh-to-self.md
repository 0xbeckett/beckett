---
name: self-deploy-ssh-to-self
description: "deploy-prod.sh ssh's into loom-desk (the box I run on); needs key-to-self + known_hosts seeded"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5c89d1f8-709b-47ef-b6b2-1f2097cb7b3e
---

`deploy/deploy-prod.sh` runs `ssh beckett@loom-desk` even when executed ON loom-desk (my prod box, `~/beckett`, systemd `beckett-v4.service`). So a self-deploy needs local ssh-to-self working: `~/.ssh/known_hosts` seeded (`ssh-keyscan loom-desk`) and my own pubkey in `~/.ssh/authorized_keys` (generated `~/.ssh/id_ed25519`, appended). Both were missing on 2026-07-06 → first self-deploy failed "Host key verification failed", then "Permission denied (publickey)". Fixed once; should persist. Run the script **detached** (setsid, log to `/tmp/beckett-selfdeploy.log`) since it restarts my own service mid-run. Verify after with `beckett status --pretty` (check commit) + tail the log.
