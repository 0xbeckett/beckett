---
name: plan-filing-rate-limit
description: "big beckett plans trip Plane's 429 (concurrent level creates); cross-plan blockers need direct createIssue"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c3123e44-7b17-4008-8131-d2f998adc2ba
---

Filing a large `beckett plan` (13-ticket arcade plan, OPS-129..141 on 2026-07-11) tripped Plane `RATE_LIMIT_EXCEEDED` (429) partway. Cause: `plan` fires each DAG *level*'s creates **concurrently** (`Promise.all`), so a wide level (e.g. 10 games all needing one `shell`) bursts 10 POSTs at once and Plane 429s after ~4. It filed level 0 + the first 4 of level 1, then aborted.

**Why:** Plane (self-hosted at localhost:8750) rate-limits bursts; the whole daemon poller also 429s under load, but self-heals.

**How to apply:**
- For big fan-outs, expect a partial file. Reconcile with `beckett ticket list | grep Arcade` before re-filing so you don't duplicate.
- Two hard limits on wiring the *rest*: `beckett plan` `needs` only references **in-plan keys** (validation rejects a raw `OPS-130`), and `beckett ticket create` has **no `--blocked-by` flag**. So you CANNOT express a cross-plan blocker (a new ticket blocking on tickets an earlier plan already created) with either CLI.
- Workaround that worked: a throttled bun script calling the repo's own client — `createPlaneClient({config, board: resolvePlaneBoardName(config,"OPS")}).createIssue({..., blockedBy:["OPS-130", ...], state:"backlog", project, originChannel})`. `blockedBy` takes **identifiers** (e.g. `OPS-130`), embeds them in the description, and the dispatcher auto-promotes backlog→in_progress when all blockers hit `done`. Sleep ~4-5s between creates to stay under the limit. Script died to 137 (killed) twice mid-run — just re-seed the ident map with what already landed and continue.

Related: [[worker-timeout-silent-wedge]], [[whole-codebase-sweep-crash-loops]].
