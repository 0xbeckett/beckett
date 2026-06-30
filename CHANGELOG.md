# Changelog

## v3.1 — "go faster" (2026-06-30)

The v3 ticket loop was slow for a reason: it was fully serial and **every leg booted a cold
agent**. File a ticket → a worker booted fresh in a clean worktree, re-oriented, did the work →
a *separate* fresh reviewer booted and re-read the whole diff → on any nitpick it bounced all the
way back and a worker booted cold *again*. One tiny fix paid a full multi-minute round trip, and
a simple site took ~31 min where plain Claude Code took ~18. v3.1 attacks the per-lap fixed cost.

### Faster
- **One worktree per ticket, not per stage.** A ticket now gets a single git worktree on its own
  branch, **reused** across implement→review→rework, instead of each stage spinning up (and
  leaking) a fresh worktree + branch. Kills the `beckett/wk_*/OPS-*` litter and the per-stage
  re-orientation cost. Work stays on the ticket's branch — Beckett **never auto-merges it to
  `main`** (the worker's own repo, not the daemon's live source). Because each ticket is isolated,
  `concurrency.max_workers` stays at **2** and independent `beckett plan` nodes still run in
  parallel. The worktree is torn down (branch kept) only when the ticket is done/cancelled.
- **Effort-scaled review (the big one).** A worker now **self-reviews its own diff against the
  acceptance criteria before finishing**, so most tickets skip the separate cold reviewer entirely:
  - cast `effort` `low`/`medium` (or `reviewTier: "self"`) → **one pass**, straight to `done`.
  - cast `effort` `high`/`xhigh` (or omit, or `reviewTier: "fresh"`) → a fresh adversarial reviewer
    runs, as before. Reserved for correctness-critical / hard-to-reverse work.
  The Concierge's doctrine now biases trivial/visual/low-risk work to one pass.
- **Sonnet 5 @ xhigh workers.** The default worker model is `claude-sonnet-5` and its reasoning
  effort is now actually wired to the CLI (`claude --effort`, default `xhigh`). Cheaper, faster
  cold boots without giving up depth. The Concierge stays on Opus (`claude-opus-4-8`) — it writes
  the better prompts.

### More robust
- **Durable deploys.** Every implement worker is told to publish anything that must stay up via
  Beckett's durable Cloudflare tunnel (`beckett deploy`), never a throwaway foreground server
  (`python -m http.server`, `vite`, `bun run dev`) that dies on session end and 404s — the OPS-15
  footgun that burned two review cycles. Workers verify the deployed URL responds before declaring
  done.

### Notes
- `claude --effort` requires claude ≥ 2.1.197 (verified on the loom-desk host).
- Ticket workers operate in their own worktree on the daemon's repo and **never auto-merge to
  `main`** — self-improvement work lands on a `beckett/<ticket>` branch for a human (or a later
  deliberate step) to merge + reload, so a bad ticket can't brick the running daemon.
