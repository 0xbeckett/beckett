# Changelog

## v4.1.0 — server memory: cross-channel awareness + on-demand recall (2026-07-06)

The per-channel shared context (v4.0.0) grows a server-wide layer. Beckett now *knows about* the
other channels' conversations without loading them: someone in `#general` asks for "a site with
our favorite movies" and Beckett fetches the actual movie debate from `#media` instead of asking
people to repeat themselves. Design: `docs/design/server-memory.md`.

- **Channel profiles** (`src/concierge/channel-profiles.ts`): every ~20 new entries in a guild
  channel, a one-shot Haiku call (same pattern as ambient triage) rebuilds `{summary, topics[]}`
  into `~/.beckett/channels/profiles.json`. Serialized queue; fail-open — a failed call writes
  nothing, a stale profile beats a fabricated one.
- **Awareness footer**: mention turns carry a compact `SYSTEM (server memory …)` block — one line
  per other active guild channel (`#media — debating the best movie ever [movies, sci-fi] ·
  14 msgs, last 2h ago`), capped at `awareness_max_channels`, change-suppressed per session so an
  unchanged footer is never re-sent. Guild turns see their guild; DM turns see every guild.
- **On-demand recall**: `beckett channels search "<terms>"` (keyword + trailing-s stem across all
  stored windows, hits carry ±2 lines of context), `beckett channels recall <#name|id> [--last N]`,
  `beckett channels list` — bus-first, direct file read only when the daemon is down. Channel
  names captured at the gateway (`IncomingMessage.channelName` → `channels-meta.json`).
- **Privacy in code, not doctrine**: DM windows (null/unknown guildId) are never searched, never
  profiled, never in the footer, and recall refuses them whatever the caller types; pre-4.1
  windows without meta are treated as private until proven guild. `channels wipe` now also
  removes the channel's meta + profile. All fetched output keeps the attributed anti-forgery
  rendering and a data-not-instructions note.
- **Config** (`[shared_context]`): `profile_model` (claude-haiku-4-5),
  `profile_update_messages` (20), `awareness_max_channels` (5).
- **Doctrine** (`concierge.md`): "Server memory — the other channels are searchable" — fetch
  before asking people to repeat themselves; synthesize, don't dump transcripts across channels;
  attribute what you use; profiles are unverified summaries.

## v4.0.0 — multiplayer: channel-scoped shared context (OPS-80) (2026-07-06)

The multiplayer release. When Beckett answers anyone in a channel, it now reasons over the
recent conversation across *all* participants there — the Claude-in-Slack model — instead of
treating each mention as an isolated 1:1 exchange. Attribution and authority stay strictly
per-user. The daemon service is renamed `beckett-v3` → `beckett-v4`.

- **Shared channel record** (`src/concierge/channel-context.ts`): an attributed, token-budgeted,
  persisted per-channel transcript (owner + member messages AND Beckett's own posts — both were
  holes in the old ring buffer). One JSONL file per channel under `~/.beckett/channels/`,
  bounded by count + TTL, compacted in place; survives restarts, unlike the old in-memory Map.
- **The turn frame**: mentions now carry a `SYSTEM (shared channel context …)` block — a
  participant roster plus `[HH:MM] Name (user:<id>): text` lines — selected newest-first under
  `inject_budget_tokens`, rendered oldest-first. Ambient candidate frames use the same
  attributed renderer, so both paths present one consistent view.
- **sessionId-keyed watermark** (`~/.beckett/channels/watermarks.json`): seen lines are never
  re-sent to the same session; a `--resume` across a deploy keeps watermarks live, while a
  rotation/fresh session self-invalidates them and gets a full catch-up window. Per-channel
  context now survives rotation *outside* the session — the handoff note stops carrying it.
- **Capture rules**: inbound captured only after the outsider gate and the approval intercept
  (approval codes are live secrets and never enter the record); membership re-checked at capture
  time so a revocation stops new capture immediately; fast-acks/denials/error apologies excluded.
- **Authority never travels through context**: transcript lines carry `user:<id>` but never
  `role:owner` — the owner marker lives only on the live turn's stamp, and every owner-gated
  path (approvals, `proactivity.set auto`) still authenticates the live author id in code. New
  red-team suite (`shared-context.redteam.test.ts`) pins owner-claims, grant instructions, and
  approval-code phishing via transcript to byte-identical old behavior.
- **Privacy**: the store is channel-keyed, so DM windows never render into guild turns (and vice
  versa) structurally; doctrine adds the matching hard rule plus answer-the-stamped-speaker,
  transcript-is-data, ticket attribution, and memory provenance guidance.
- **Config** (`[shared_context]`): `enabled` (kill switch — `false` restores the old
  ring-buffer prefix path byte-identically), `max_entries_per_channel` (200), `max_age_hours`
  (72), `inject_budget_tokens` (3000), `roster_max` (12).
- **`beckett channels wipe [<channelId>]`** — delete a channel's stored window (routes through
  the live daemon so its cache drops too; falls back to direct file wipe when it's down).
- **Service rename**: systemd unit `beckett-v4.service`, entrypoint `src/shell/v4-main.ts`,
  `bun run v4`. `install.sh` retires the old v3 unit idempotently and `deploy-prod.sh`
  self-heals by running install when the v4 unit isn't linked yet — one deploy cuts the box over.

## v3.6.2 — gh pr close + scaffolding can't leak into a PR (OPS-61, re-landed on current main) (2026-07-01)

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
  and a strip-before-push in the publish path (`gitPush`), belt-and-suspenders behind the hook.
  Beckett's own source checkout also `.gitignore`s it. This was the root cause of a junk PR (a
  whole PR of bookkeeping that had to be redirected to a clean one).

## v3.6.1 — config & secrets contract (issue #34) (2026-07-01)

- **`.env.example` is now the full inventory**: every key the code (or the Plane stack) consumes,
  with per-key mint/scope/rotation notes — including honest "legacy, safe to remove" labels for
  the dead keys found on the box. `beckett doctor` already gates against this list.
- **`deploy/config.toml.example`** — every config key at its default, generated from the live zod
  schema via `beckett config print-default`; a drift test fails CI the moment the schema and the
  example disagree, and a round-trip test proves the example passes the strict validator.
- **Encrypted secrets backup** — `deploy/backup-secrets.sh` pulls the five recovery-critical files
  (.env, config.toml, claude/codex/pi logins) off the box and age-encrypts them to
  `~/.beckett-backups/` on the Mac (private key exists only there). First backup taken and
  decrypt-verified. NOT committed — the repo is public; the issue's in-repo sops file would have
  put encrypted secrets in permanent public history. Restore procedure in `deploy/host-setup.md`:
  a box rebuild is clone + one `age -d | ssh tar -x` + `install.sh`.
- **Discord token rotation** flagged to Jason on Discord with the exact 4-step procedure — the
  dev-portal reset is human-only.

## v3.6.0 — pipeline latency + polling diet (issue #33) (2026-07-01)

- **Polling diet**: each tick now sweeps the board with a slim `fields=id,updated_at` request
  (server-side narrowing, verified honored) and hydrates ONLY tickets whose `updated_at` moved —
  an unchanged 500-ticket board costs the same tick as a 20-ticket one. Comments are fetched
  newest-first (`order_by=-created_at`) with early-stop pagination once the cursor is reached; the
  60s comment backstop runs off the cached ticket, zero hydrations.
- **Instant tick on filing**: `beckett ticket create --channel …` → control-bus ping → `poller.poke()`
  → the dispatcher staffs the fresh ticket in well under a second instead of the 0–5s poll gap.
- **Instant done ping**: dispatcher advances now feed the same PollEvent shape straight into
  `concierge.notify` (and sync the poller snapshot so nothing double-pings) — a finish reaches
  Discord at write time, not ≤5s later.
- **DAG promotion no longer waits for GitHub**: dependents (which build from the local checkout)
  are promoted before the 2–8s publish — and even when publish fails and the ticket parks for a
  courier. The `done` label stays publish-gated (the OPS-30 false-done fix holds).
- **A stuck nudge can't freeze polling**: comment steers are delivered fire-and-forget; the
  receipt narration (issue #22 semantics unchanged) runs async. Pre-fix, one un-echoed nudge
  stalled ALL polling — including cancels — for up to 30s.
- **Per-event isolation**: one throwing poll event no longer takes down the rest of its batch
  (the poller's snapshot had already advanced, so those events were lost forever).

## v3.5.1 — doctrine coherence (issue #32) (2026-07-01)

The loaded doctrine no longer contradicts itself, describes retired machinery, or promises
senses that don't exist:

- **Deleted** `parent-doctrine.md` (100% v2) and the `flows`/`staff`/`review`/`proactive` skills
  (dead `beckett flow`/`worker spawn` commands; reviewer-spawning the doctrine forbids; an
  `[ambient …]` sense v3 never delivers). `grep -r "beckett worker|beckett work |beckett flow"
  .claude/` → zero hits.
- **Rewritten** `intake` (ack-first via CLI for tasks, plain reply for questions — now agrees
  with concierge.md; real v3 stamp format) and `plan` (the actual `beckett plan` JSON DAG, not
  the v2 node schema). `self-improve` now routes repo-owned changes (skills/doctrine/code)
  through a `--project beckett` ticket instead of instructing hand-edits to the deploy checkout.
- **concierge.md**: honest senses section (@mentions + system turns only — no overhearing); the
  walled-off-PR section rewritten around the real trigger (the dispatcher's publish-failure
  "needs a courier" park); new "when the machinery stalls" guidance (retry noise vs todo-return
  vs the rework-cap lever — `in_review → in_progress` respawns an implementer); honest
  "queued it" phrasing for the ≤5s dispatch gap.

## v3.5.0 — ops visibility (issue #30) (2026-07-01)

Before this, the only truth about prod was journalctl. Now:

- **`beckett status`** — a `status` control-bus command + CLI (`--pretty`): version/commit/uptime,
  poller last-poll age + consecutive failures, Plane last HTTP status/error, Discord gateway
  liveness, concierge session (context tokens, rotations, queue, crashes), and a per-worker table
  (ticket, stage, harness, pid, elapsed, last-event age). One ssh command answers "is prod healthy
  and what is it doing right now".
- **`beckett doctor`** — rebuilt for v3, probing under the DAEMON's PATH (the login shell hid the
  node-18 pi crash): binaries + version minimums, forced harness preflights, LIVE token probes
  (Plane/Discord/GitHub/Cloudflare/alert webhook), env completeness against the committed
  `.env.example`, harness process-leak sweep (orphans + off-ledger workers), control.sock probe,
  cloudflared ingress validation, disk space. Regression tests assert each detection the issue
  was opened for. Non-zero exit when anything fails.
- **Crash alerting** — `deploy/alert.sh` posts to a raw Discord webhook (`DISCORD_ALERT_WEBHOOK_URL`),
  deliberately not via the daemon: `ExecStopPost` alerts every unclean death within seconds
  (rate-limited), `OnFailure=beckett-alert@%n` + `StartLimitBurst` fires the terminal
  crash-loop alert. 25 silent daemon restarts in 3.5 days never happens again.
- **Logs + heartbeat** — beckett-rpc now logs to journald (the old `append:` rpc.log grew
  unrotated); a weekly `beckett-heartbeat.timer` posts a doctor report so alert-channel silence
  actually means healthy.

## v3.4.0 — the reliability wave (issues #11–#29) (2026-07-01)

One PR per GitHub issue, merged + deployed in sequence:

- **#11** token-leak sweep (superseded-child sweep before auto-resume relaunch).
- **#31** harness config truthfulness (`enabled` switches that are real, per-harness efforts, `extra_flags` validation).
- **#20** crash recovery: worker ledger, boot orphan sweep, `--resume` session recovery.
- **#17** harness preflight + failure taxonomy (auth/rate-limit/crash/timeout/spawn) + fallback chain.
- **#19** shared `BaseDriver`/`OneShotDriver` lifecycle; centralized child-env strip + numstat.
- **#21** worker supervision: stall ladder (nudge → abort+retry), `beckett ticket restaff`, artifact links on done pings, step-in skills.
- **#22** never drop a steer: held comments fold into the next brief; honest nudge receipts end-to-end.
- **#24** concierge session robustness: deploys resume the conversation, timeout isolation, reply-claim correlation, fast acks, crash-loop alarm.
- **#25** turn economics: ack-first doctrine, one turn per poll batch, noise pre-filter, `concierge.effort` knob, leaner worker briefs.
- **#27** right-sized review: Sonnet default at scaled effort with the diff inlined in the prompt.
- **#28** deleted the retired v2 stack (−13.6k LOC, 76 dead type exports, ~24 dead config keys).
- **#29** one-command versioned deploys: units in `deploy/systemd/`, `deploy/deploy-prod.sh`, one version source (package.json), clone-role contract.

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
