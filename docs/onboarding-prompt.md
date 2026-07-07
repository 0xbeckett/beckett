# Onboarding prompt — paste this into your AI coding agent

Copy everything in the block below into a fresh Claude Code / coding-agent session that's opened
in the Beckett repo. It orients the agent to what this codebase is, how it's built, and the rules
it must not break — so it can start being useful instead of spelunking blind.

---

```
You're working in the Beckett repo. Read this before touching anything.

WHAT IT IS
Beckett is a Discord-native AI engineer. A long-lived `claude -p` (Opus) agent called the
Concierge owns Discord: it chats in its own voice, sizes how much effort a request deserves, and
for real work FILES A TICKET into a self-hosted Plane queue — it never writes the code itself. A
poller watches Plane; a dispatcher turns ticket-state changes into work: a ticket moving to
In Progress spawns a coding agent in an isolated git worktree, In Review spawns a reviewer, a new
comment steers the live worker, done advances the ticket and posts a summary back to Discord.
Workers are "cast" per stage (different model/effort for implement vs review).

Read `docs/V3.md` first — it's the authoritative build contract and §1 has the non-negotiable
style conventions. Then `README.md` for the operator/fork view. Specs are in `specs/` (anything
under `specs/_legacy*` is archived — historical only, NOT a contract).

REPO MAP
- src/concierge/  — the Discord-facing agent. `concierge.md` = fixed operating doctrine;
                    persona/voice is a separate editable file (DEFAULT_PERSONA seed in index.ts).
- src/discord/    — gateway, human-cadence message chunking, access control, federation (peer bots)
- src/dispatch/   — ticket-state → worker/reviewer spawns
- src/plane/      — Plane REST client + poller
- src/worker/     — the coding-agent harness (worktree, scope-guard, casting)
- src/drivers/    — claude / codex / pi process drivers
- src/memory/     — cross-conversation knowledge graph
- src/rpc/        — Discord Rich Presence daemon (a separate systemd service)
- src/cli/beckett.ts — the whole CLI, one entrypoint
- src/config.ts / src/types.ts — strict, fully-defaulted config schema + the frozen Config type
- deploy/         — systemd units, install.sh, deploy-prod.sh, host-setup.md

CONVENTIONS (match the neighbors — this is enforced by review)
- Bun + TypeScript, no build step. Use `.ts` extensions in imports (the repo's style).
- Comments explain WHY, not what — they're dense here on purpose. Keep that density when you edit.
- Split pure/testable helpers out from I/O; inject clocks/RNG so tests are deterministic (see
  src/discord/chunk.ts and src/discord/federation.ts for the pattern).
- Config is strict-validated: every new key needs a zod schema entry + a Config type field + a
  default, and you must regenerate the example with `bun src/cli/beckett.ts config print-default >
  deploy/config.toml.example` or the drift test fails.
- Auth is subscription-only: NEVER introduce ANTHROPIC_*/OPENAI_* API keys — Beckett drives the
  claude/codex/pi CLIs through their own logins. src/env.ts refuses those keys on purpose.

BEFORE YOU COMMIT
- `bun x tsc --noEmit`  (typecheck — must be clean)
- `bun test`           (run the suite; add tests for new logic)

DEPLOY / PROD REALITY (important)
- Prod is `~/beckett` on a Linux box, running as systemd user services. It ONLY ever runs
  origin/main and is NEVER hand-edited.
- The deploy path is: change → PR → merge to main → `./deploy/deploy-prod.sh` from the dev machine
  (fetch, ff-only pull, install, typecheck, restart beckett-v4.service, health read-back).
- Don't invent a deploy; use deploy-prod.sh. Don't leave prod behind origin/main after a change.

WORKING STYLE
- Small, reviewable changes. State assumptions. If a task is genuinely big or has independent
  parts, that's what `beckett plan` / multi-ticket work is for.
- When unsure how something behaves, read the test next to it — most modules have a `*.test.ts`
  sibling that documents the contract.

Now: summarize back what Beckett is and where you'd start for the task I'm about to give you.
```

---

Tweak the last line for whatever you're onboarding the agent to do. If you want it to go deeper on
one subsystem, add "then read `src/<area>/` and its tests" before the final line.
