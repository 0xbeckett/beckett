# Changelog

## v3.1 — "go faster" (2026-06-30)

The v3 ticket loop was slow for a reason: it was fully serial and **every leg booted a cold
agent**. File a ticket → a worker booted fresh in a clean worktree, re-oriented, did the work →
a *separate* fresh reviewer booted and re-read the whole diff → on any nitpick it bounced all the
way back and a worker booted cold *again*. One tiny fix paid a full multi-minute round trip, and
a simple site took ~31 min where plain Claude Code took ~18. v3.1 attacks the per-lap fixed cost.

### Faster + properly decoupled
- **Every ticket builds its OWN repo.** `resolveRepoRoot` was hardcoded to Beckett's own source
  (`~/beckett`), forcing all work — and all the per-stage worktree churn — into the daemon's repo.
  Now a ticket works in **`~/Projects/<slug>`**, its own `git` repo, pushed to **`0xbeckett/<slug>`**
  on GitHub, **fully decoupled from `0xbeckett/beckett`**. The Concierge names the project
  (`--project balloons`); unnamed tickets sandbox under the ticket id. The dispatcher provisions it
  before the first worker (clone `0xbeckett/<slug>` if it already exists — continuing projects, or
  Beckett's own source for a `--project beckett` self-improvement ticket — else `git init`). The
  worker just builds in place and pushes via the github skill. No worktrees, no `wk_*` litter; each
  ticket is its own directory so `concurrency.max_workers` stays **2** and `beckett plan` nodes run
  in parallel. **A worker never touches the running daemon's checkout.**
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
- Beckett works like a developer: it owns `/home/beckett`, builds each project under `~/Projects/`,
  and pushes to its own GitHub account (`0xbeckett/<project>`). Improving Beckett itself is just a
  `--project beckett` ticket that clones the source into `~/Projects/beckett` — the live daemon is
  only ever updated by a deliberate deploy, never by a worker.
