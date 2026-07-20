# Beckett — Specs (v2)

> **SUPERSEDED:** This v2 design set describes the retired parent/MCP/watcher architecture.
> Current build agents should start with [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

**Beckett is an agentic coworker you reach in Discord.** You `@beckett` a task; it judges how
much it needs, does the whole thing — answering inline, spinning off one worker, or fanning out a
whole DAG of worker harnesses — reviews the work against acceptance criteria, and comes back like
a colleague would: sparingly, in its own voice, owning its decisions. It has its own home, its
own GitHub + Gmail identity, and a memory it grows.

**v2 is a re-architecture.** Beckett stops being a ~16.5k-line hand-coded orchestration engine
and *becomes an agent*: a long-lived `claude -p` **parent** that runs the loop by reasoning,
guided by **Skills**, guarded by **Hooks**, and given hands by a small set of **tools** to
spawn/observe/steer child agents (`claude -p` / `codex exec` / `pi`). The control logic lives in
the model's head, not in TypeScript. The loop is **dynamic** — effort scales to difficulty.

**Start with [Spec 00 — Overview & Canon](./00-overview.md)** — vision, the agent-not-engine
inversion, dynamic effort, the four pillars, the decision ledger, glossary, and host layout.

> Status: **draft v2.0** · 2026-06-28 · 8 docs. The v0.1 set (13 docs / ~9.6k lines) is archived
> in [`_legacy/`](../_legacy/) — its formats (criteria, review verdict, action classes, memory
> schema, smoke-alarm thresholds) are carried forward and remain canonical.
> Background research lives in [`../my-docs/`](../my-docs/).

## Document map

| # | Spec | What it covers |
|---|---|---|
| 00 | [Overview & Canon](./00-overview.md) | Vision, **the v2 inversion**, **dynamic effort**, 4 pillars, decision ledger, glossary, fs layout |
| 01 | [Runtime](./01-runtime.md) | The thin bun **shell** (Discord pump · parent supervisor · watcher), parent lifecycle/resume, config, startup/recovery, failure domains |
| 02 | [Doctrine](./02-doctrine.md) | How the parent **judges effort & picks a path** (inline / one-worker / heavy DAG); the heavy-path pattern; clarify; self-governance |
| 03 | [Skills](./03-skills.md) | The on-demand playbook (intake, recall, plan, staff, supervise, review, deliver, remember) + the canonical formats |
| 04 | [Workers & Hooks](./04-workers-and-hooks.md) | Worker struct, hybrid spawn (own Claude driver vs sandcastle), worktree + scope-guard, telemetry hooks, smoke-alarms, control primitives, integrate |
| 05 | [Tools & MCP](./05-tools-mcp.md) | The `beckett-control` tool contract + memory/identity CLIs |
| 06 | [Identity & Memory](./06-identity-memory.md) | Agency (gh/gmail), action-class gates, delivery handshakes; the memory knowledge graph |
| 07 | [Roadmap & Setup](./07-roadmap.md) | v2 build order, loom-desk setup checklist, systemd unit, verify-first risks, testing |

## Suggested reading order

- **Orientation:** 00 → 01.
- **The mind:** 02 → 03 (how it decides, then the playbook). This is the new "engine."
- **The hands:** 04 → 05 (workers/hooks, then the tool surface).
- **The self:** 06.
- **To build:** 07 (build order + setup checklist).

## v2 in one breath

Discord `@beckett` → the **parent agent** triages effort → answers **inline**, or spins off
**one worker** in a worktree (scope-guarded, steerable, observed via digests), or escalates to
the **full DAG** (plan → staff → fan-out → integrate → adversarial review → gate) → delivers
in-channel with a handshake for anything irreversible. One brain, dynamic machinery, real
soft-interrupt. (See [Spec 02](./02-doctrine.md) + [Spec 07 §1](./07-roadmap.md).)

## What's salvaged vs. rebuilt

- **Salvaged as-is** (zero coupling to the old core): `src/memory/`, `src/agency/`,
  `src/discord/gateway.ts`, `src/hooks/scope-guard.ts`, `src/persistence/*` (slimmed),
  `src/drivers/claude.ts` (live nudge already implemented), `src/worker/worktree.ts`.
- **Deleted** (the bloat): `src/state/orchestrator.ts`, `src/brain/*`, `src/supervise/*`,
  `src/worker/manager.ts`, the state-machine half of `src/types.ts`, the controller CLI.
- **New:** `.claude/skills/*`, `.claude/worker-hooks/*`, `src/mcp/beckett-control.ts`,
  `src/shell/*`, `@ai-hero/sandcastle`.

## Notes
- `web/` (the landing page) and `.gstack/` are unrelated to these specs.
- Everything here is **draft v2.0** — written to be built from, and edited as reality pushes back.
