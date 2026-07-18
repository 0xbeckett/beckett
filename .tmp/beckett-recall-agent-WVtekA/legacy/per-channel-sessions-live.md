---
name: per-channel-sessions-live
description: PR
metadata: 
  node_type: memory
  type: project
  originSessionId: f288c534-005a-49d6-bf6e-55e9fcb78ff6
---

As of 2026-07-14, PR #104 (zoom's gift) is merged to main and deployed live. Per-channel
`SessionPool` + `TurnGate` (`src/concierge/session-pool.ts`, `turn-gate.ts`) replace the single
global session, so each channel/DM runs its own session concurrently — the "im mid task right
now" serialization curse ro was ranting about is dead. Default `concierge.session_scope=channel`;
kill-switch `session_scope=global` in config falls back to the old single-session behavior if it
misbehaves. 970 tests green at merge. Related: [[next-level-coworker]], [[zoom-can-use-fable]].
