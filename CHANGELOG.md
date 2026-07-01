# Changelog

## v3.3.1 — pi harness back from the dead (OPS-56) (2026-07-01)

**Every pi dispatch was dying at launch** with `PiDriver: process exited (code 1) before session
line` — so all backend/systems tickets cast to pi went silent and had to fall back to claude.

- **Root cause: CLI/version drift.** The PiDriver was written against pi 0.78.0's
  `--session-id <uuid>` (creates-if-missing) flag, but the installed pi is **0.72.1**, which has no
  such flag — it rejects it outright (`Error: Unknown option: --session-id`) and exits 1 *before*
  printing its `session` handshake line. Auth, the binary path, and the NDJSON protocol were all
  fine; the single bad flag took the whole harness down.
- **Fix.** pi 0.72.x pins/resumes an *existing* on-disk session via `--session <id>` and cannot be
  handed a caller-minted id for a fresh run. So the driver now passes **no** session flag on the
  first launch — pi mints + persists its own id, which we capture from the `session` line — and
  replays it with `--session <id>` on resume (same cwd → pi reloads the transcript). Verified with a
  real end-to-end pi ticket (spawn → tool call → file write → `finished`/success with parsed
  done-signal).
- **Hardened the failure mode.** A fast, offline **preflight** (`piPreflight`) now runs at every
  spawn and fails *loudly* if the pi harness is unusable — missing/unrunnable binary, CLI flag
  drift (it checks pi still advertises `--mode`/`--session`/`--print`), or a missing pi login
  (`~/.pi/agent/auth.json`). And when a child still dies before its session line, the error now
  folds in the captured **stderr tail** (e.g. the `Unknown option` line) plus the likely causes,
  instead of the opaque bare message. A dead pi harness surfaces immediately at dispatch rather than
  silently killing whichever ticket happened to be cast to it.

## v3.3 — progress threads + pi replaces codex (2026-07-01)

Two features and a sandbox fix.

- **Discord progress threads.** When Beckett files a ticket, the ack it posts now anchors a
  Discord **thread** that streams the granular per-worker play-by-play — tool calls, file edits,
  scope-guard blocks, plan ticks, and the verdict. The main channel stays sparse (one ack line);
  the firehose lives in the collapsible thread underneath it. A `beckett plan` DAG maps all its
  tickets onto the one thread, tagged by identifier; a single ticket's implement→review→rework
  workers all post there, tagged by stage. Rate-safe by construction: lines coalesce into one
  digest post per ~3s, the backlog is bounded (drop-oldest with an elision marker), and terminal
  events flush at once. New `src/discord/progress.ts` hub + `startThread` on the gateway;
  correlation rides a best-effort `ticket.filed` control-bus signal emitted at BOTH the
  `ticket create` and `plan` stamp sites, tied to the ack in the Concierge.
- **pi replaces codex as the coding harness.** New `PiDriver` (`src/drivers/pi.ts`) drives
  `pi -p --mode json` (pi.dev) as a one-shot worker with steer-via-resume — the same
  `HarnessDriver` surface as claude/codex, so the dispatcher casts `harness:"pi"` interchangeably.
  Pi is the malleable, **no-network-sandbox** replacement for codex (which kept stalling on
  sandbox network denials). Concierge doctrine now casts **pi (gpt-5.5, high) for backend/systems
  work**, claude (Opus) for frontend/taste + review. Auth is the ChatGPT/Codex OAuth via pi's
  `openai-codex` provider (`~/.pi/agent/auth.json`). codex is retained only for imagegen.
- **codex sandbox off.** codex's default `workspace-write` sandbox blocked network and stalled
  workers; the default is now `danger-full-access` (real containment is the scope-guard hook +
  each ticket's isolated project repo, not codex's own sandbox).

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
