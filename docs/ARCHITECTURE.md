# Beckett — Architecture

> **This is the single authoritative architecture doc.** It supersedes the older
> per-generation contracts (`docs/V3.md`, now archived under
> [`specs/_legacy-v3/`](../specs/_legacy-v3/V3.md)). Anything under `specs/_legacy*` is design
> history — read for rationale, never as a live contract. The build contract for the next
> generation is [`docs/v6.md`](v6.md) — design, not yet live; this doc still describes the
> running system.

Beckett is an agentic coworker you reach in Discord. You `@beckett` a task; it plans, spawns and
steers worker harnesses (`claude -p` / `codex exec` / `pi`) in isolated git worktrees, reviews
their work against acceptance criteria, and comes back like a colleague would. It has its own
home, its own GitHub + Gmail identity, and a memory it grows.

## The architecture in one paragraph

A **Concierge** (a long-lived `claude -p` Opus agent) owns Discord. It chats in Beckett's voice,
decides effort, and for real work FILES A TICKET into the loopback [bored](https://github.com/frgmt0/bored)
tracker (`src/bored/`, `src/tracker/`) with per-stage **casting**. It never does the work itself.
The **shell** (`src/shell/main.ts`) polls bored every `config.tracker.poll_secs` and emits
`PollEvent`s. A **Dispatcher** (`src/dispatch/dispatcher.ts`) consumes them: a ticket entering
`in_progress` spawns the implement cast's harness as a worker (git worktree, under a scope-guard);
`in_review` spawns the review cast's harness; a new comment on an in-flight ticket is injected as a
STEERING nudge to the live worker; `cancelled` aborts it; when a worker finishes, the dispatcher
advances the ticket state and posts a summary comment. The Concierge and the poll→dispatch loop
never call each other directly — the tracker is the shared queue.

## Entrypoint & cutover

The daemon entrypoint is **`src/shell/main.ts`**, run via `bun run v4` (see `package.json`) or by
the `beckett-v4.service` systemd user unit (`deploy/systemd/beckett-v4.service`).

The file was renamed from `src/shell/v4-main.ts` → `src/shell/main.ts` (issue #150) to drop the
generation prefix now that there is one current architecture. Three surfaces were updated in the
**same commit** so they never drift:

- `package.json` — the `module` field and the `v4` script both point at `src/shell/main.ts`.
- `deploy/systemd/beckett-v4.service` — `ExecStart` runs `bun src/shell/main.ts`.
- `deploy/install.sh` — the idempotent unit relinker (`ln -sf`) plus `daemon-reload` + restart.

**Why the service name stayed `beckett-v4.service`.** The live daemon is pinned to that unit
filename. Renaming the unit would require the same dangling-unit stop→disable→remove dance the
v3→v4 cutover used (see the comment block in `deploy/install.sh`). This change only moves the
entrypoint *file* and rewrites the unit's `ExecStart`; the unit filename is unchanged, so the
cutover is content-only: `git pull` lands the moved file and rewritten unit atomically, then
`deploy/install.sh` relinks (idempotent), reloads systemd, and restarts `beckett-v4.service`,
which picks up the new `ExecStart`. No two-daemon window.

**The rename is NOT auto-deployed.** This ticket lands the coordinated change in the repo only;
the actual production cutover is run deliberately by Beckett/owner (it is not auto-merged or
auto-deployed), because a careless deploy against the running daemon is the one way to break it.

## Extending Beckett (V5 capability model)

Adding a capability goes through **one** extension point: a self-describing `Capability` module
(`src/capability/index.ts`) registered in `src/capability/builtins.ts`. Registering it lights up
every surface at once — CLI verbs, the concierge control bus, its `config.toml` slice, the worker
system prompt, and its action-class posture. See [`extending-capabilities.md`](extending-capabilities.md)
for the full table.

Config is a composed, strictly-defaulted schema (`src/config.ts::composeConfigSchema`): every
top-level key is a fragment contributed by a capability. Invalid or out-of-range values are a loud
refuse-to-start at boot, never a mid-task surprise.

## Repo map (orientation)

```
src/
  shell/        the daemon entrypoint (main.ts) + control bus + deploy helpers
  concierge/    the Discord-facing Opus agent (concierge.md = doctrine; persona is separate)
  dispatch/     the state machine: dispatcher + worker spawn
  tracker/      shared ticket contract, cast blocks, poller
  bored/        the loopback bored ticket-tracker client
  capability/   the V5 capability registry (one way to add a capability)
  task/         durable #N / #N.x task and branch registry
  worker/       the coding-agent harness (worktree, scope-guard, casting)
  drivers/      claude / codex / pi process drivers
  memory/       cross-conversation knowledge graph
  rpc/          Discord Rich Presence daemon (separate service)
  cli/          the `beckett` CLI (one entrypoint, beckett.ts)
  config.ts     strict, fully-defaulted composed config schema
deploy/         systemd units, install.sh, deploy-prod.sh, host-setup.md
docs/           this ARCHITECTURE doc + extending-capabilities.md + audits
specs/          design history (original specs under _legacy/, v2 under _legacy-v2/, v3 under _legacy-v3/)
```

## Style conventions (non-negotiable)

Match the neighbors. This codebase leans on dense, explanatory comments that say *why*, strict
config validation, and pure/testable helpers split out from I/O. Import style is bun-native:
explicit `.ts` extensions, ESM.

**Before you commit:**

```bash
bun x tsc --noEmit    # typecheck — must be clean
bun test              # the suite
```

## Design history

The consolidated older contracts are kept for rationale only:

- [`specs/_legacy/`](../specs/_legacy/) — the original v0.1 spec set (numbered `Spec 00`…`Spec 12`,
  still referenced from code comments for design intent).
- [`specs/_legacy-v2/`](../specs/_legacy-v2/) — the retired v2 parent/MCP/watcher design.
- [`specs/_legacy-v3/V3.md`](../specs/_legacy-v3/V3.md) — the v3 Plane ticket-queue build contract
  (Plane is gone; bored replaced it). The current architecture above descends from it.
