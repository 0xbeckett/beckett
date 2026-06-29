# Beckett Consolidation Plan (Skills, Hooks, Context, Fleet Coordination)

**Branch:** `explore/skills-and-hooks` (local only — no main commits)  
**Status:** Planning phase complete. Ready for implementation handoff.  
**Date:** 2026-06-29

## Vision (from conversation with ro)
Beckett is a collaborative agent that teams can tag in Discord. It acts on its own behalf (own GH account), offloads tasks, works in the background, absorbs teammate feedback, and steers.

- First-class support for both Claude (steering, interrupts, feedback loops) and Codex (implementation).
- Per-server/org isolation (containers in full vision).
- Strong hooks for claude-p observability.
- Own identity + agency + handshakes.

## Core Constraints (never break)
- Per-worker git worktrees + scope hooks
- Harness dispatch, steering/nudges, and asymmetry (Claude vs Codex)
- DAG/orchestrator + supervise + integrate
- Review/gate with explicit per-node criteria
- Own GH identity and action gates
- Persistence + durability
- All changes must be additive (if skills/hooks are disabled, behavior == baseline)

## Key Problems to Solve
1. **Context / Session Isolation** — Agent could not determine what context belonged to what session ("literally just didnt know anything").
2. **Context Compaction** — Long-running background + feedback work causes bloat.
3. **Harness Specialization** — Clear rules for when to use Claude vs Codex for what kinds of tasks.
4. **Coordination** — Better multi-harness "fleet" patterns with independence + reconciliation.

## Key Patterns to Introduce
- Declarative skills (modular .md files) for behavior, specialization, and coordination.
- Strong session/task scoping for all context (memory, skills, prompts).
- Session-aware compaction for long-running work.
- Fleet-style coordination with independence + mandatory reconciliation.
- Harness-specific behavior (Claude for steering/feedback sessions, Codex for implementation).
- Sandbox-style isolation for workers (build on existing worktrees + hooks).

## Phased Plan (Logical Order)

### Phase 0 — Baseline (complete)
- Performance baseline script + metrics (context size, assembly time, hook cost, compaction savings, cross-session pollution).
- Documented current behavior in BASELINE_SKILLS_HOOKS.md.
- All existing paths unchanged when new features are off.

### Phase 1 — Session / Context Scoping (foundation) — DONE (2026-06-29)
- Make every context injection explicitly session/task/server-aware. ✅
- Thread `sessionOrTaskId` through skills loader, memory recall, BrainContext, worker prep, and hook events. ✅ (loader/overlay live; recall + hook-registry carry the id additively; full hook wiring → Phase 3)
- Prevent cross-session pollution at the source. ✅ (removed the `loadAllSkills()` fallback that made skills always-on)
- Update perf baseline to demonstrate scoped vs mixed context. ✅ (ADDITIVITY CHECK + OFF/SCOPED/ALL modes)
- **Restored the additive invariant: OFF == baseline (1299 chars, was 7442 always-on).** Verified: typecheck clean, 16/16 tests.
- See IMPLEMENTATION LOG in BASELINE_SKILLS_HOOKS.md for source-proven details + measurements.

### Phase 2 — Skills System
- Complete additive loader (active list, session filter, format with headers, lean mode).
- Core skills (already seeded):
  - `harness-selector.md`
  - `fleet-orchestrator.md`
  - `feedback-steering.md`
  - `research.md` + `verify.md`
- Port useful Codex prompts/skills for implementation work.
- Integrate additively into PLAN (per-node active skills) and context builders.

### Phase 3 — Proper Hooks
- Pluggable hook registry (build on existing scope-guard).
- Harness-specific observability (richer for Claude steering; normalized for Codex).
- Session tagging on events.
- Reconciliation hooks (force source citation before accepting worker claims — fleet style).
- Skills can contribute hooks.

### Phase 4 — Memory + Compaction (Kew style)
- Scoped memory (per-server/person/task/general) with gated writes and relevance filtering.
- Session-aware compaction (per-fleet/leg summaries + bounded injection).
- Ephemeral per-leg outputs; only reconciled scoped ledger persists.
- Re-inject only what's needed on resume/feedback.

### Phase 5 — Sandbox / Isolation Enhancements
- Make Codex workers more secret-free (narrow task context only).
- Harness-specific isolation: steering sessions get richer context; implementation legs stay minimal.
- Hooks for boundary enforcement.

### Phase 6 — Harness Specialization + Fleet Coordination
- Enforce via skills: Claude for steering/feedback sessions; Codex for scoped implementation.
- Fleet-orchestrator coordinates mixed fleets inside one DAG with reconciliation.
- Per-session limits + gates for irreversible steps.

### Phase 7 — Integration + Measurement
- Wire additively only (manager, brain prompts, worktree prep, supervise).
- Re-run perf baseline after every change.
- Ensure per-server vision is supported via scoping.

### Phase 8 — Documentation & Handoff
- Keep BASELINE_SKILLS_HOOKS.md as living record + measurements.
- Clean notes for PRs / open questions process.

## Principles
- Session-first everywhere.
- Additive only — core behavior identical when disabled.
- Measure deltas (use scripts/perf-baseline.ts).
- Respect full vision (background collaboration, feedback steering, Claude+Codex first-class, isolation, hooks observability).

## Current State on This Branch (as of handoff)
- Baseline + perf script complete.
- Session scoping partially wired (skills loader + manager).
- Skills seeded: harness-selector, fleet-orchestrator, feedback-steering, research, verify.
- Hooks registry stub started.
- Compaction simulation live.
- Analysis of context/session issues, compaction, and multi-harness coordination in BASELINE_SKILLS_HOOKS.md.

## Handoff Notes for Implementation Agent
You can continue directly on `explore/skills-and-hooks`.

**Phase 0 + Phase 1 are DONE (2026-06-29).** Baseline is green (bun installed locally; tests made
path-portable; typecheck fixed). The additive invariant was found broken (skills were always-on via
a `loadAllSkills()` fallback) and is now restored: OFF == baseline. Session scoping is threaded
through the skills loader (+ per-scope overlay), BrainContext, the orchestrator `ctx()`, recall
query, and the hook registry. See the IMPLEMENTATION LOG in BASELINE_SKILLS_HOOKS.md.

**Next — Phase 2:** make per-node `activeSkills` actually reach a worker end-to-end (add a `NodeRow`
column + migration, hydrate it, have PLAN emit it), then make the `fleet-orchestrator` skill
influence a dispatch example additively. Keep the OFF==baseline test (`tests/skills.test.ts`) green.

Use the existing `BASELINE_SKILLS_HOOKS.md` and this file as the single source of truth.

All changes must pass the "if we turn skills off, nothing changes" test.

---

This file is intentionally small and focused for handoff. The detailed analysis and measurements live in `BASELINE_SKILLS_HOOKS.md`.