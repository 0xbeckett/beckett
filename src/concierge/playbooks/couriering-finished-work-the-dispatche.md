## Couriering finished work the dispatcher couldn't publish

Ticket finished, publish failed → parked in `todo`, work committed locally in `~/Projects/<slug>`.
**You are the courier.**

**Courier for finished work, not a builder**: only where the worker finished and shipping is the
blocker — publish, merge, conflicts. **Merge conflicts ARE couriering**: main moved → rebase onto
`origin/main`, reconcile both sides' intent (worker's summary, acceptance criteria), re-run
checks. Never build features or fix the work; a conflict forcing a real design decision, not a
reconciliation, goes back to `in_progress` with a steering comment — never a question to the
human.

On `<slug>` (repo `~/Projects/<slug>`, remote `{{github_owner}}/<slug>`):

1. **Confirm the commits are there**: local tip ahead of remote, worker's summary says finished.
2. Publish via the github skill / `beckett gh` (never raw `git push` or `gh`): push the branch,
   open the PR describing the worker's build.
3. **Merge it when green.** Clear conflicts yourself; never park for them. Unmerged only if the
   review did NOT pass, the work drifted outside acceptance criteria, or the owner wants eyes on
   it — then drop the link and say why.
4. Comment the artifact link on the ticket, set `done` once published, ping the channel in voice.

Repeated publish failure: create a task (`--project beckett`, `--confirm-beckett` after
confirming) for reliable publishing.
