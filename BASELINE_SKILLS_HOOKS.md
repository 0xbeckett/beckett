# Baseline + Exploration: Skills + Proper Hooks Consolidation

**Branch:** explore/skills-and-hooks  
**Baseline commit:** 13be23f (tag: baseline-2026-06-28)  
**Date:** 2026-06-29 (local exploration)  
**Goal:** Explore transferring Kew's skills invocation pattern + enhancing Beckett's hook system for better consolidation, **without breaking any existing behavior**.

## 1. What "Baseline" Means Here

- This branch was created from `baseline-2026-06-28` (exact copy of main at the single commit).
- **No commits will ever be made to main on this clone.**
- All work stays on this branch (or future sub-branches).
- Existing behavior = whatever the code in commit 13be23f does today.

Main will remain untouched. When ready, this branch (or clean patches from it) can be used to propose changes upstream.

## 2. Current Baseline Behavior (Skills / Context / Hooks Area)

### Prompt & Context Injection (current "skills-like" behavior)
- Worker initialization:
  - `src/worker/manager.ts`:
    - `buildPrompt(node, criteria)` → simple title + NL criteria.
    - `buildSystemAppend(scopeDesc, ownedGlobs, criteria)` → businesslike scope + criteria text.
  - These are concatenated and passed to drivers.
- Brain:
  - `src/brain/prompts.ts` + `src/brain/index.ts`:
    - Layered prompts (persona → role → memory → state).
    - `BrainContext` carries persona + memory recall + fields.
  - Persona loaded from `~/.beckett/persona.md` (full for Haiku voice, thin for Opus judgment).
- Memory:
  - `src/memory/index.ts`:
    - `recall(query)` returns scored nodes for injection.
    - Markdown knowledge graph is the only current way to bring in specialized knowledge/behavior.
- No dedicated skills directory or loader.

**Key property to preserve:** If no new code runs, `buildPrompt` + `buildSystemAppend` + brain context assembly must produce **exactly** the same output as before.

### Hooks (current)
- Only implementation: `src/hooks/scope-guard.ts`
  - Standalone PreToolUse hook for Claude (registered via `.claude/settings.json`).
  - Enforces FileScope (owned globs + worktree boundary).
  - Fail-closed on errors for write tools.
  - Events surface as `WorkerEvent` kind `hook_decision` → triggers `scope_violation` smoke alarm.
- Codex: uses OS sandbox instead (no hooks).
- Wired only in:
  - `src/worker/manager.ts` (scopeGuardSettings, scopeGuardEnv)
  - `src/worker/worktree.ts` (meta files written to worktree)
- No general hook registry or pluggable system.
- Specs mention other conceptual "hooks" (recovery, failover) but they are not implemented as runtime hooks.

### How Behavior Is Currently Extended
- Memory nodes (ad-hoc).
- Hardcoded logic in prompts and build* functions.
- Per-node criteria + scope from PLAN.

This is scattered — the consolidation target.

## 3. Kew Pattern (for reference)

From `/home/satv/Projects/market-impact-graph/kew/`:
- Skills = plain `.md` files in `skills/`.
- `load_active_skills()` from JSON state.
- `load_skills_content()` → concatenates enabled skills with `--- SKILL: name ---` headers.
- Injected into full context block alongside knowledge + memory.
- Supports `lean` mode (minimal skills for cheap turns).
- Declarative, easy to add, selectively loaded.

Transfer goal: Similar declarative + selective injection, but adapted to Beckett's model:
- Per-node / per-worker scoping (not just global chat).
- Tied to PLAN decisions, criteria, and gate.
- Can influence both prompt context **and** runtime hooks.

## 4. Proposed Non-Breaking Approach (Additive Only)

### Principles
- Every change must be **additive**.
- Existing call sites must continue to work identically if the new system returns empty results.
- New functionality behind presence of `skills/` dir or explicit config (future).
- Use the same markdown format as memory for consistency.
- Extend, never replace, the current builders.

### Planned Extension Points (identified from baseline code)
1. **Types** (`src/types.ts`)
   - Add optional `activeSkills?: string[]` to `PlanNode`, `NodeRecord`.
   - Add `skills?: string` to `BrainContext`.

2. **Skills Loader** (new: `src/skills/index.ts`)
   - `loadSkillsContent(active: string[] = []): string`
   - Returns formatted block or empty string.
   - Falls back gracefully (no skills dir → "").

3. **Worker Context** (`src/worker/manager.ts`)
   - In `buildSystemAppend` (or a new helper), optionally append skills block.
   - Call will be: `... + (skillsContent ? "\n\n" + skillsContent : "")`

4. **Brain** (`src/brain/prompts.ts`, `src/brain/index.ts`)
   - When building context, include skills if present in BrainContext.
   - Existing paths unchanged if `ctx.skills` is undefined/empty.

5. **Hooks** (`src/hooks/`)
   - Keep `scope-guard.ts` as-is.
   - New `src/hooks/registry.ts` (or simple array) so future skills can register additional hook behavior.
   - Current scope guard becomes the first registered hook.
   - No behavior change for existing workers.

6. **Worktree Preparation** (`src/worker/worktree.ts`, manager)
   - When preparing worktree, if skills are active for the node, optionally write skill files or register extra hooks in settings.json.
   - Again, only if skills are provided.

7. **PLAN Stage** (future, in `src/brain/plan.ts`)
   - Can output recommended skills per node (additive field).

### Testing / Safety
- Existing tests (using fake-harness) must pass unchanged.
- New code paths exercised only when skills are explicitly loaded.
- We can add new tests on this branch.

## 5. Consolidation Opportunities Identified

- Memory + Skills unification (both markdown-based).
- Single context assembly function instead of scattered build* helpers.
- Skills can declare "hooks they need" (e.g. a verify skill registers extra PostToolUse observation).
- Better cost control (selective + lean skills, similar to Kew).
- Easier extensibility for future "learned" behaviors.
- Aligns with Beckett's existing emphasis on scope, criteria, and review gate (skills can be node-scoped).

## 6. Performance Baseline (Captured 2026-06-29)

Run from the branch using available Node:
```
node scripts/perf-baseline.ts
```

**Key baseline metrics (pre any skills/hooks changes):**
- Context assembly time: **0.0050 ms** avg per call
- Typical assembled context size: **~1299 chars** (~325 tokens)
- Memory graph build + recall (50 nodes): **0.0056 ms** avg
- Hook/scope-guard eval: **sub-millisecond** (negligible per call, but high volume on every tool use)
- Other characteristics:
  - Memory is rebuilt from disk on *every* recall/write (see MemoryStore).
  - Prompt assembly uses stable layers for potential caching.
  - Worker concurrency kept low (4-8) because harnesses are expensive.
  - Envelopes focus on turns/wall-clock, not tokens/dollars.

**How to use for iteration:**
- Re-run `node scripts/perf-baseline.ts` after each experiment.
- Track deltas in context size (skills will add bloat), assembly time, and recall cost.
- Goal: Keep increases minimal or provide opt-in/lean modes (like Kew).

Full script output captured in this run for the baseline.

## 7. Work Rules on This Branch

- Only commit on `explore/skills-and-hooks` (or children).
- Never commit to main.
- All changes documented here or in follow-up files.
- When a piece is solid, we can discuss how to surface it (patch, you push the branch later, etc.).
- Current behavior must be preserved byte-for-byte when new features are not active.
- Re-measure perf after every significant iteration.

---

This document lives on the exploration branch and will be updated as we implement.

Next step on this branch: implement the minimal additive skills loader + wire it into one safe place (e.g. buildSystemAppend) so it returns "" today.

Status: baseline captured. Ready to code the first non-breaking improvement.