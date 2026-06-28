# Beckett

**An agentic coworker reached in Discord.** `@beckett` a task; it plans, spawns and steers worker harnesses (Claude Code / Codex) in isolated git worktrees, reviews against acceptance criteria, and delivers sparingly — in its own voice, owning its decisions.

It has its own home, its own GitHub + Gmail identity, and a growing memory/knowledge graph.

## Start here

- [specs/README.md](specs/README.md) — full spec index. Begin with [specs/00-overview.md](specs/00-overview.md) (vision + canon).
- [my-docs/open-questions.md](my-docs/open-questions.md) — the living decision ledger (most decisions are recorded 🟢; open items are tracked here).
- [CONTRIBUTING.md](CONTRIBUTING.md) — how we work, especially how **open questions are resolved via PRs**.
- [specs/12-roadmap-setup.md](specs/12-roadmap-setup.md) — loom-desk setup, phased build (v0 → v1), verify-first risks, testing.

## Key principles (from the canon)

- Harness over harnesses (Beckett never does the low-level work itself).
- Opus for judgment, cheap models for intake/delivery.
- Git worktree per worker + scope enforcement.
- Non-invasive supervise (tail + smoke alarms + self-scheduled check-ins).
- Tiered review + gate against explicit per-node criteria.
- Agency from day one (own accounts + handshakes for irreversible actions).
- Sparseness is law on the Discord surface.

## Development

This repo is deliberately spec-heavy at the start. Code in `src/` implements the specs (see comments in source that reference specific sections).

```bash
bun install
bun run typecheck
bun test
```

See specs for the full story and the exact v0 acceptance criteria.

## Open questions → PRs

Architecture and process decisions are not left in chat. They are proposed and ratified through Pull Requests that update the ledger. Use the PR template — it explicitly calls out the decision ledger section.

PRs are how open questions become decided facts with history.

---

Private repo. Current focus: v0 (single Claude worker, real mid-task steering, self-review gate, Discord ambient delivery).