---
name: ""
metadata: 
  node_type: memory
  originSessionId: 547c2b3d-ecda-429c-a621-9b016042eb13
---

When a ticket's whole job is to LAND/publish already-built work (resolve a merge conflict + push), workers repeatedly do the code part correctly and then never push — OPS-104 burned all 3 rework cycles (~$4) with the merge resolved and verified on local main the whole time, and a single courier push finished it in one shot.

**Why:** review keeps bouncing it ("nothing landed on main") but the worker's next attempt re-resolves and again forgets/skips the actual push. The relay can't fix a step the worker structurally skips.

**How to apply:** for a pure land/publish ticket, don't let it grind rework cycles. Once a worker reports the resolution is done + verified locally, check the local repo (`git log`/`merge-base --is-ancestor origin/main main`) and courier the push myself via `beckett gh push --repo <o/n> --branch main --ref main --dir ~/Projects/<slug>`. Fast-forward pushes auto-close the related PRs as merged. This is squarely the courier role — publish only, code already done. See [[self-deploy-ssh-to-self]] for the other publish-path gotcha.
