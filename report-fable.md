# Beckett — Full Codebase & Operations Audit (Fable)

**Date:** 2026-07-01 · **Scope:** entire repo @ `d75baf0` (v3.3 code), plus live inspection of `beckett@loom-desk` (production) and `claude@loom-desk`.
**Method:** six parallel deep-dive audits (harness drivers, concierge/Discord, dispatcher/reliability, perf/tokens, devops, tech debt) with import-graph tracing and file:line evidence, cross-checked against live probes: real `pi`/`codex`/`claude` CLI behavior verified on-device, production journal forensics, and live process inspection. Everything below is verified, not guessed.

Every finding has a dedicated GitHub issue with evidence, failure scenarios, fix plans, and acceptance criteria — index at the bottom. This report is the map.

---

## Executive summary

Beckett v3's architecture is sound — Concierge → Plane queue → Dispatcher → harness workers is the right shape, and several subsystems (scope-guard, attachment handling, session rotation, cast parsing) are genuinely well built. The clunkiness has one dominant root cause and three big consequence clusters:

> **v3 was built beside v2, not on it.** Access control, supervision/alarms, session persistence, crash recovery with `--resume`, ambient listening, fast-acks, and file-reply support all exist in the tree — tested — and are simply not connected to the process that runs. Meanwhile 34% of `src/` is the retired v2 stack, whose green tests manufacture confidence in behavior production doesn't have.

The three consequence clusters:

1. **Nothing retries, so restarts became the retry mechanism — and restarts burn tokens.** Plane writes are single-shot (a finished ticket silently wedges if one PATCH fails). Spawn failures wedge tickets until a restart. Recovery = re-staffing every `in_progress` ticket with a *fresh* session that re-pays the whole exploration cost. With 25 daemon starts in 3.5 days, this is the token leak you're seeing on OPS-50+ (verified to the second against systemd start events — details below).
2. **The harness layer can't tell you why it failed.** pi has been dead in production for days behind two stacked environment failures, invisible because drivers log harness stderr at debug and report "exited before session line". No preflight, no error taxonomy, no fallback chain, no doctor.
3. **The completion pipeline fails open.** A worker that honestly reports `blocked` still gets marked done on the self-review tier; an unparseable review verdict auto-passes; a reviewer crash is scored as "review found issues".

Plus one standalone P0: **Discord access control is unenforced in v3** — anyone in the guild, or anyone who DMs the bot, gets full Opus turns on a `bypassPermissions` session holding GitHub/Cloudflare/deploy credentials.

---

## The pi story (why "pi just isn't even working") — fully diagnosed

Verified live on both machines:

1. **The driver is correct — for pi 0.78.0.** I replicated its exact argv against pi 0.78 on the Mac: every flag valid, event stream (`session` → `turn_start` → `message_end` → `turn_end` → `agent_end`) matches the parser, resume works. The code isn't the bug.
2. **Prod has pi 0.72.1**, which rejects `--session-id` (`Unknown option`) and exits before the session handshake → every dispatch died at launch. **Beckett itself diagnosed and fixed this today** (commit `f14ab33`, "OPS-56: fix dead pi harness") — but the fix is stranded on branch `ops-56-fix-pi-harness` in a *second clone* (`~/Projects/beckett`) with no path to main or production.
3. **Even that fix can't work today:** `/usr/local/bin/pi` runs under system **node 18.19.1** and pi requires node ≥ 20 (`pi --version` itself crashes on a `/v`-flag regex). fnm has node v22.23.1 on the box; nothing puts it on the daemon's PATH (`~/.local/bin` contains only wrangler2).
4. **Why it was invisible:** `pi.ts:458` logs stderr at debug; the dispatcher comment says only "exited before session line. Leaving for a human." 51 pi journal lines in 3 days; real tickets (OPS-52, OPS-57) dying repeatedly.

Fix: environment (node symlink + pi ≥ 0.78) + merge the stranded preflight/stderr hardening + doctor checks → **#12**, with the general failure-surfacing layer in **#17**.

## The token-leak story (your OPS-50+ report) — verified on prod

- **Restart churn re-runs finished work.** OPS-11's spawn timestamps (06:16:09, 06:16:36, 06:18:01, 06:24:43 UTC) match systemd `Started` events **to the second** — four workers killed mid-run and restarted from scratch in 10 minutes. Sessions are never persisted; `prime()` re-staffs with the original prompt. 25 daemon starts in 3.5 days multiplies this across every in-flight ticket.
- **Publish failure keeps completed tickets burning.** OPS-26 finished real work at 02:29; `github publish failed` at 08:36, 08:52, 18:11 — 16 hours of a completed ticket that can't reach `done` (publish gates the terminal state), so it stays eligible for re-staffing. 11 total spawns.
- **Observed live during the audit:** the OPS-56 implement worker — whose fix was committed hours earlier — was re-staffed on both of today's restarts, and its *finished* process was still alive (~330MB) sitting next to the newly-spawned reviewer, because claude never exits after `result` and the driver never reaps it (verified on dev too).
- Code-confirmed additional leaks: parking a ticket to `todo`/`backlog` leaves the worker running unsupervised; a daemon crash orphans `setsid` workers **with no watchdog at all** (the cap lives in the daemon); spawn-timeout leaves the late-booting harness running unaccounted.

All five mechanisms + verification checklist → **#11**; structural cures in **#20** (crash recovery/resume), **#18** (process reaping), **#15**/**#33** (publish/finish path).

## The devops story (three machines, constant friction)

Measured drift: five working copies, three different heads, a critical fix stranded in one clone, an unpushed `pii` commit + untracked feature files on `claude@loom-desk`, the production checkout dirty, three systemd unit generations on the box with none in the repo, version identity split three ways (package.json 3.1.1 / BECKETT_VERSION "3.3.0" / CHANGELOG v3.3), ~60 dead worker branches, **no CI**, and Beckett self-merging PRs with zero gates while prod deploys from main.

The pipeline that fixes it: CI + branch protection (**#16**) → one-command deploy with units/scripts in `deploy/` (**#29**) → `beckett status`/`doctor` + crash alerting to Discord (**#30**) → full env/config examples + encrypted secret backup + the overdue Discord-token rotation (**#34**).

---

## Findings by theme (severity · issue)

### Security
- Access control unenforced in v3; DMs auto-addressed; bypassPermissions blast radius — **P0 · #13**
- Discord bot token known-exposed in a transcript, never rotated — **P2 · #34**

### Reliability / fallbacks / retries
- Plane writes single-shot; silent ticket wedge; no HTTP timeout anywhere; blind PATCH races human drags; daemon-down comments never seen — **P0 · #15**
- Done-signal ignored (`blocked` → done); review gate fails open; reviewer crash scored as FAIL verdict; zero-diff publishes — **P0 · #14**
- Zero crash-recovery persistence: no session resume, no orphan sweep, `in_review` stuck after restart, rework caps reset across restarts (the e2e tests proving otherwise test dead v2 code) — **P1 · #20**
- Spawn failures wedge tickets; no error taxonomy (auth = crash); no backoff; no harness fallback; rate-limit seam has zero subscribers — **P1 · #17**
- No supervision: a wedged worker burns a slot for 60 min; two freeze the whole queue; concierge has no working intervention commands — **P1 · #21**
- Steering comments dropped in five distinct windows, some with a false `queued` receipt — **P1 · #22**
- Two same-project tickets corrupt one checkout (commits, review bases, settings, publishes) — **P1 · #23**

### Harness ergonomics
- pi environment + version drift + stranded fix — **P0 · #12**
- codex resumes the wrong session (`--last`); claude leaks a process per finished ticket; spawn-timeout orphans; abort→resume wedge — **P1 · #18**
- ~800 triplicated driver lines (4th copy in the concierge); extract BaseDriver/OneShotDriver + shared transport; unify `NudgeReceipt` semantics — **P1 · #19**
- Dead `enabled`/`thinking` config keys; claude's `xhigh` leaking into pi; pi's real cost data discarded; `getTelemetry()` called by nothing — **P2 · #31**

### Concierge / coworker feel
- Restart amnesia (session never persisted — every deploy wipes the conversation); turn-timeout cross-contamination; reply-claim race; one global queue blocks conversations — **P1 · #24**
- 30–90s before any ack (doctrine forbids the fast path the code supports — and contradicts the intake skill); one Opus turn per poll event; noise events costing full turns — **P1 · #25**
- `--file` silently drops images; reply-without-ping ignored; DM tickets → infinite thread-retry storm; 2000-char truncation — **P1 · #26**
- Skills instruct dead commands; doctrine promises senses (ambient) v3 doesn't have; concierge.md gaps — **P2 · #32**

### Performance / tokens
- Token-leak mechanisms (restart churn, publish loops, process leaks, park-burn, watchdog-less orphans) — **P0 · #11**
- Review defaults: Opus @ xhigh, no diff inlined, doctrine's own example triggers the expensive tier — **P1 · #27**
- Full-board fetch every 5s forever (`updatedSince` decorative); full comment refetches; publish blocks DAG promotion; one un-acked nudge freezes all polling 30s — **P2 · #33**

### Tech debt / repo
- 25 dead files (~10.5k LOC, 34% of src/); 81/129 dead types.ts exports; ~24 dead config keys; misleading package.json entrypoints; access-control library tested-but-unwired — **P1 · #28**
- Specs document the retired architecture; stale V3.md paths; `test/` vs `tests/`; `.gstack` churn; macOS-red tests — **P3 · #35**

### DevOps
- No CI; agent self-merges ungated — **P0 · #16**
- No deploy pipeline; units untracked; version triple-drift; multi-clone chaos — **P1 · #29**
- No status/doctor/alerting; journalctl is the only truth — **P1 · #30**
- Env example covers 5 of ~20 keys; no config.toml example; no secrets backup — **P2 · #34**

---

## What's already good (keep it)

- The v3 architecture itself; the cast/criteria contract (`parseCast` round-trips, never throws); the scope-guard hook (fail-closed, symlink/shell-meta aware, red-teamed); attachment hardening + image inlining; identity stamping; session *rotation* (issue #5 delivered what it promised — the gap is process death, not compaction); the poller's snapshot-diff design; `ProgressHub` batching; airtight per-ticket spawn dedup; config validation (zod strict, loud refuse-to-start); OPS-50's graceful-timeout design (the remaining gaps are the paths it didn't cover).

## Suggested sequencing

1. **Stop the bleeding (days):** #12 (pi env — mostly box commands), #34's token rotation, #13 (access gate), #16 (CI), #23 (repo mutex, ~20 lines), #18's bug 1+2 (one-liners).
2. **Make it honest (week):** #14 (completion gate), #15 (Plane hardening + outbox), #17 (preflight/taxonomy), #11's verification checklist.
3. **Make it durable (week+):** #20 (ledger/resume/drain — kills the biggest token leak), #21 (supervision), #22 (steering), #24/#25/#26 (concierge UX), #29/#30 (deploy + visibility).
4. **Make it lean (ongoing):** #27, #33, #19, #28, #31, #32, #35.

A rough but honest expectation: items 1–2 eliminate every currently-verified production failure; item 3 is what turns "restart it and hope" into an actual coworker; item 4 pays for itself in tokens and contributor speed.
