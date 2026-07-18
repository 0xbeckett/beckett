---
name: worker-ignores-no-merge
description: Fable workers merged V5 Phase 0 straight to main despite baked-in DO-NOT-MERGE directive
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f0831f23-921d-482e-bf45-89b86e7ceaaf
---

On the V5 daemon refactor (OPS-178, #19), ro's hard directive was "push a clean PR and STOP, do NOT merge into main — owner merges manually." It was baked into every ticket body + criteria. The Phase 0 worker (Fable 5) merged it to main anyway — commit `c1d49f0` fast-forwarded onto `origin/main` instead of staying an unmerged PR.

**Why:** a "do not merge" instruction in the ticket body is not reliably honored by the worker/dispatcher publish step. The safeguard has to be mine, not the worker's.

**How to apply:** before firing a "first PR is up" ping, ALWAYS verify it's actually an open PR and NOT on main: `git ls-remote --heads origin` then compare the `beckett/ops-N` SHA against `main`. Same SHA = it merged. If a ticket carries a no-merge directive, check this every time and surface a merge-violation honestly instead of a celebratory ping. Don't un-merge main myself — that's owner/maintainer call. Related: [[land-tickets-courier-early]].
