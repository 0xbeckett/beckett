# Beckett — Specs

**Beckett is an agentic coworker you reach in Discord.** You `@beckett` a task; it plans, spawns and
steers worker harnesses (`claude -p` / `codex exec`) in isolated git worktrees, reviews their work
against acceptance criteria, and comes back like a colleague would — sparingly, in its own voice,
owning its decisions. It has its own home, its own GitHub + Gmail identity, and a memory it grows.

This folder is the implementation spec. **Start with [Spec 00 — Overview & Canon](./00-overview.md)** —
it holds the vision, the four pillars, the canonical decision ledger, the glossary, and the filesystem
layout. Every other doc defers to it.

> Status: **draft v0.1** · 2026-06-27 · ~9,500 lines across 13 docs.
> Background research & decision rationale live in [`../my-docs/`](../my-docs/)
> (`00-synthesis.md` = harness capability matrix; `claude-code-headless.md` / `codex-exec.md` = wire
> formats; `open-questions.md` = the full decision log).
>
> **Open questions & decisions are managed via PRs** on this repo. See root [CONTRIBUTING.md](../CONTRIBUTING.md) and [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md). Every architecture-affecting PR must reference and (when ratifying) update the ledger.

## Document map

| # | Spec | What it covers |
|---|---|---|
| 00 | [Overview & Canon](./00-overview.md) | Vision, 4 pillars, **decision ledger**, loop, glossary, fs layout, phasing |
| 01 | [Architecture](./01-architecture.md) | Components, process/concurrency model, config.toml, startup/recovery, IPC, failure domains |
| 02 | [Worker Abstraction](./02-worker-abstraction.md) | `Worker` struct, `HarnessDriver`, Claude/Codex drivers (exact flags), telemetry parsing, scope enforcement |
| 03 | [Control Plane & Supervise](./03-control-plane-supervise.md) | Read-only observation, smoke-alarms, Opus self-scheduled check-ins, nudge/pause/abort/ask_plan |
| 04 | [State Machine](./04-state-machine.md) | Task + node FSMs, DAG executor, integrate/merge, retry loop, escalation, crash recovery |
| 05 | [Discord Interface](./05-discord-interface.md) | Ambient (no-threads) model, intake/clarify correlation, steering, delivery handshake, sparseness law |
| 06 | [Brain & Models](./06-brain-models.md) | Hybrid Haiku→Opus auto-escalation, model routing, stateless-Opus pattern, decision schemas, persona |
| 07 | [Identity & Agency](./07-identity-agency.md) | Identity + action-class gates, GitHub/Gmail agency, delivery handshakes, self-halt, security |
| 08 | [Memory & Knowledge Graph](./08-memory-knowledge-graph.md) | Linked-markdown format, graph model, recall, write/dedup, learned-worker notes |
| 09 | [Persistence & Data Model](./09-persistence-data-model.md) | Full SQLite DDL, JSONL event log, durability/recovery, outcome logging, migrations |
| 10 | [CLI](./10-cli.md) | `beckett` command surface, unix-socket IPC, id scheme, output formats |
| 11 | [Review, Gate & Quality](./11-review-gate-quality.md) | Criteria schema, check runner, tiered/fresh/cross review, gate algorithm, escalation format |
| 12 | [Roadmap & Setup](./12-roadmap-setup.md) | loom-desk setup checklist, systemd service, v0/v1/later milestones, verify-first risks, testing |

## Suggested reading order

- **Orientation:** 00 → 01.
- **The core loop:** 02 → 03 → 04 (worker → supervise → state machine). This is the engine.
- **The interface & brain:** 05 → 06.
- **The "self":** 07 → 08.
- **The plumbing:** 09 → 10 → 11.
- **To build:** 12 (start here for the setup checklist + build order).

## v0 in one breath

Discord `@beckett` → Opus plans a single node with acceptance criteria → one **Claude** worker runs in
a git worktree → Beckett tails it read-only and can **nudge it mid-task** → self-review against the
criteria → deliver in-channel. One harness, one worker, **real soft-interrupt**. (Spec 12 §roadmap.)

## Open decisions / verify-first (carried over from the writers' ⚠️ flags)

These are deliberately unresolved or need confirmation before the code that depends on them. Spec 12
holds the full verify-first protocol with smoke-test commands; this is the index.

**Must verify on `loom-desk` before building on them (Spec 12):**
- **A** — `claude -p --input-format stream-json` actually delivers a mid-task nudge at the next turn
  boundary (and `--replay-user-messages` acks it) on `claude 2.1.195`. *Blocks v0.* Fallback: kill +
  `--resume`, then embed the SDK for just the Claude driver.
- **B** — `codex exec --sandbox workspace-write --ask-for-approval never` runs fully autonomously
  without hanging. *Blocks v1 Codex.*
- **C** — Codex network-off-by-default vs `npm install` / `git push`; per-node opt-in works.
- **D** — what hitting a subscription rate-limit looks like in each stream (needed for failover).
- **E** — Discord **Message Content** privileged intent is enabled (else ambient mention text is empty).

**Flag/behavior confirmations (cheap, do at setup):**
- Claude `--effort` flag existence — specs map effort → model tier as a fallback (02 §7, 06 §2).
- Claude `--append-system-prompt` / `--add-dir` / `--allowedTools` / `--settings` present in 2.1.195.
- `codex exec review` subcommand exists (used for cross-provider review, 11 §5) — unverified in my-docs.

**Design choices to ratify (no code-blocking, but pick before the relevant module):**
- Path constants: define `~/.beckett` (= `/home/beckett/.beckett` for OS user `beckett`) **once**,
  shared across 01/09 — don't duplicate string literals.
- `task_type` taxonomy must be fixed before the learned-staffing query (06/09/11) is meaningful.
- Retry budget: one shared counter for worker-crash vs gate-fail, or two? (04 §5 / 11 §7) — leaning one.
- Concurrency cap is **daemon-global** (assumed across 01/04) — confirm vs per-task.
- SQLite binding: `bun:sqlite` vs `better-sqlite3` — not yet pinned (09).
- Config hot-reload scope for `beckett reload` (01/10) — proposed live-safe vs restart-only key split.
- PLAN+STAFF are **fused** in v0 (PLAN emits `suggestedWorker`); they split when the learned model
  lands (06 §4.4).
- Brain judgment (Opus `--json-schema`) has **no harness failover** — falls back to queue+backoff,
  since there's no Codex equivalent for structured judgment (06 §7). Accepted asymmetry.
- Multiplayer: a non-owner answering someone else's clarify — policy deferred to 07/multiplayer era.

## Notes

- `web/` (the `beckett.frgmt.xyz` landing page) and `.gstack/` are unrelated to these specs.
- Everything here is **draft v0.1** — written to be built from, and to be edited as reality pushes back.
