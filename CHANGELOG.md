# Changelog

## v3.2.1 — gh pr close + scaffolding can't leak into a PR (OPS-61) (2026-07-01)

Two fixes to Beckett's own machinery.

- **`beckett gh pr close <num> [--repo owner/name]`.** The `gh` wrapper gained a `pr close` verb
  alongside create/merge/status/review, using the same authenticated `gh` path (`GH_TOKEN` per
  invocation — no raw `gh` outside the wrapper). It checks the PR's state first so it errors
  clearly on an already-merged/closed PR or a bad number, then closes it and prints the resulting
  state. `--repo` is optional (defaults to the current repo, works on external repos when given).
- **Internal scaffolding (`.beckett/`) can never reach a branch or PR.** The done-signal schema,
  scope-guard settings, and worker state are guarded three independent ways so a worker's diff and
  any PR it opens contain only real project work: (1) `info/exclude` in each worktree blocks
  `git add -A`/`git add .`; (2) a shared `pre-commit` hook strips `.beckett/` from the index under
  any committer — defeating even a forced `git add -f`; (3) an explicit strip in `commitWorktree`
  and a strip-before-push in the publish path, belt-and-suspenders behind the hook. Beckett's own
  source checkout also `.gitignore`s it. This was the root cause of a junk PR (a whole PR of
  bookkeeping that had to be redirected to a clean one).

## v3.2.0 — thread-native steering (OPS-59) (2026-07-01)

Beckett now opens a **work thread** for each ticket when it starts, and treats messages inside
its own work threads as addressed to the worker — no @mention required. This lets a person steer
the running worker by just talking in the thread.

- **Thread as the steering surface.** When a ticket enters `in_progress`, the Concierge opens a
  Discord thread under the ticket's origin channel, registers it (`~/.beckett/threads.json`), and
  drops a kickoff line. Milestone/update pings for that ticket then route into the thread.
- **Mention gate widened, precisely.** A message in a thread **Beckett itself created** is handled
  as if @mentioned. This applies ONLY to Beckett's own threads — arbitrary threads and the parent
  channel stay mention-gated. Enforced by registry membership, not a loose heuristic.
- **Access model unchanged.** The thread bypass reuses the same `access.txt` + owner gate as
  everywhere; only members/owner trip the worker in a work thread. It grants **no new access** —
  outsiders get nothing, and the gate fails safe (deny) if access can't be resolved.
- **No self-loops.** Bot messages and Beckett's own messages never engage.
- **Steering injection.** A work-thread message on a ticket with a live worker is relayed as a
  steering nudge via the existing `beckett ticket comment` → dispatcher → `worker.nudge` path, so
  it lands at the worker's next safe boundary (between turns / after a tool call) without
  corrupting work in flight. No live worker ⇒ the Concierge just replies conversationally in-thread.
- **Cold when done.** When the ticket reaches a terminal state (done/cancelled), its thread is
  cooled and stops auto-triggering.

## v3.1.1 — first-real-tickets bug fixes (2026-06-30)

The first batch of real tickets (the `random` and `gravity-well` sites) surfaced four bugs:

- **Duplicate Discord replies.** On a direct @mention the Concierge answered twice — once via its
  auto-posted turn text, once by *also* running `beckett discord reply` (which it had been over-
  trained to do, since that command is the only path on automated update turns). Fixed: the
  Concierge now tracks the in-flight @mention turn; if it answers via the CLI, that becomes THE
  reply (native, once) and the auto-post is suppressed. Doctrine clarified — `beckett discord reply`
  is ONLY for `SYSTEM (automated ticket update…)` turns; a person's message just gets a normal reply.
- **GitHub repos 404'd.** Workers *did* push the project repos, but `beckett gh repo create` defaults
  to **private**, so `0xbeckett/<slug>` was invisible (404) to anyone not logged in as Beckett — and
  the Concierge handed out URLs that didn't resolve. Publishing is now **deterministic in the
  dispatcher**: on every done it pushes the project repo to `0xbeckett/<slug>` as a **public** repo
  (create-if-missing, else push + self-heal visibility to public), and posts the real URL on the
  ticket so the Concierge stops guessing. The unreliable "push it yourself via the github skill"
  worker instruction is gone.
- **Deploys didn't go public.** Workers improvised their own servers — a foreground `server.mjs`
  that died on session end, bound to localhost, with no systemd unit and (sometimes) no DNS record,
  so `<name>.0xbeckett.me` never resolved. The deploy note is rewritten into one exact recipe
  (durable `systemd --user` unit on a port → `beckett deploy <slug> --port <p>` for tunnel **and**
  DNS), forbids every improvised alternative (foreground/`&`/`nohup`, hand-editing the ingress), and
  requires the worker to `curl https://<slug>.0xbeckett.me` for a 200 before it may call the ticket
  done. Never report a URL you haven't curled.
- **A visual toy ground for 8 minutes.** OPS-19 (a canvas particle toy) was mis-cast to **codex at
  heavy effort** — codex can't see pixels, so it over-engineers visual work slowly. Casting doctrine
  sharpened: anything visual (canvas, game, animation, landing page) is **claude + `effort: low`**
  (fast, one-pass self-review), never codex. codex is for crisp-spec, no-pixel work only.

Also reaped a leaked worker process that had been idle for 7 hours (a gravity-well implement worker
whose OS process outlived its dispatcher bookkeeping), and flipped the existing `random` /
`gravity-well` repos to public.

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
