---
name: next-level-coworker
description: "The \"next level / Coworker\" self-improvement wave — ro delegated the design decisions to me; OPS-122/123/124 in flight"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0882b1e5-1701-4352-8822-e9c7d104ccbb
---

On 2026-07-10 ro (owner) asked what would take Beckett to the next level, ran a Fable panel → design doc hosted at next-level.0xbeckett.me, then said the doc's open questions are **mine** to decide and I'm free to build what embodies the "Coworker" mission into myself.

First wave into `--project beckett` — status as of 2026-07-10:
- **OPS-123 spend ledger** — ✅ DONE, self-published to main as 1353d97. Append-only JSONL of per-stage cost + `beckett spend` CLI. Telemetry-only, no auto-routing v1.
- **OPS-124 github sense** — ✅ DONE, self-published to main as 48a3001. Poll my own 0xbeckett PRs, surface review/CI/merge back as concierge turns. Read-and-relay only, no auto-merge.
- **OPS-122 publish outbox** — ✅ DONE. Couriered PR #97 first, then ro explicitly authorized me to hand-resolve the conflict + land + restart. Rebased the 2 outbox commits onto current main (past 123/124), resolved the dispatcher.ts import conflict (kept both spend + publish-outbox imports), tsc clean, dispatch+spend suites 85 pass. Pushed to main as 101ec6c + d67d9c3, closed PR #97 (equivalent commits on main). Then ran the real ff-pull deploy + daemon restart to take all three (122/123/124) live.

**Note:** the beckett self-publish path lands work straight on main (OPS-123 + OPS-124 both did), NOT via a held PR. Only the conflict/failure case falls to me to courier — and ro may then greenlight me to hand-resolve it myself (he did for 122). **Nothing is LIVE until a real deploy** — main moving ≠ running daemon updated (restart is not deploy); the deploy = `deploy/deploy-prod.sh` which ssh-to-self ff-pulls origin/main into ~/beckett + tsc + restarts beckett-v4.service.

**Theme-1 finale — OPS-125 "blip-proof workers"** — ✅ DONE, passed Fable review + merged to main 2026-07-11. Worker side only: durable per-worker checkpoint + clean RESUME on boot (ticket/stage/base SHA/context pointer), live-process reattach left as maybe-v2. Kept advance-outbox / publish-outbox idempotency intact. **NOT LIVE yet** — merged ≠ deployed; asked ro whether to run the ff-pull deploy + restart to ship it (as of 2026-07-11). All of Theme 1 (122/123/124/125) now landed; 122/123/124 are live, 125 pending deploy.

**Next after OPS-125:** the CONCIERGE-side context loss — when the daemon restarts, *I* cold-boot and rebuild the live conversation from memory (lossy). Separate later ticket, ro agrees it needs fixing "somehow." Related: [[worker-timeout-silent-wedge]], [[land-tickets-courier-early]], [[cross-fork-pr-limit]], [[notify-refire-loop]].

**Why:** ro handed me real autonomy over my own roadmap; this is the standing mission, not a one-off ticket.
**How to apply:** when these ship, the next candidates are the reattach surgery (once triaged) and the deferred proposals in the doc. Don't re-ask ro to approve building — he already said build; do surface Fable-cost casts.
