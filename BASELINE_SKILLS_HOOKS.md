# Baseline + Exploration: Skills + Proper Hooks Consolidation

**Branch:** explore/skills-and-hooks  
**Baseline commit:** 13be23f (tag: baseline-2026-06-28)  
**Date:** 2026-06-29 (local exploration)  
**Goal:** Explore transferring Kew's skills invocation pattern + enhancing Beckett's hook system for better consolidation, **without breaking any existing behavior**.

## Vision Context (from direct conversation with repo owner)

Beckett's intended use:
- Team collaboration tool: teammates tag `@beckett` to offload tasks.
- Agent acts on its **own behalf** (own GH account, can be invited to private repos like any collaborator).
- Works in background, takes teammate feedback, and **steers** the work.
- First-class harness support: Claude Code (`claude -p` for steering/interrupts) + Codex.
- Per-"org"/server isolation (own containers/knowledge base per server ID in vision).
- Not for solo coding — collaboration-focused.
- Owner specifically wants **better use of hooks** for observability inside claude -p sessions.
- Skills are a good way to encode reusable behavior (research, verification, feedback handling, steering rules) declaratively instead of hardcoding everything.

Core that must be preserved:
- Harness-over-harnesses model (Claude + Codex steering capability).
- Worktree isolation + scope enforcement.
- Own identity + agency (GH account, handshakes for irreversible actions).
- Background execution + mid-task steering with feedback.
- Review/gate against criteria.
- The existing orchestrator, state machine, drivers, and persistence must not regress.

Skills + hooks are the consolidation levers to make the 16.5k LoC codebase less "sloppy" while staying true to the vision.

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

## Harness Specialization: Claude vs. Codex (Vision-Driven Analysis)

From the direct conversation with the repo owner ("ro"):
- "i want to support Claude Code and Codex as first-class support"
- Codex shines for "implementation agent" work.
- Claude -p is valued for steering: "claude -p does which makes it nice" because "it just doesnt allow interrupts/steering via codex exec".
- "I use codex for implementation agent. Grok for everything else. Codex can also launch grok."

Current design in Beckett (as of baseline):
- Both are first-class via the `Harness` / `HarnessDriver` abstraction (Spec 02).
- Strong documented asymmetry:
  - **Claude (`claude-cli-stream`)**: Excellent for tasks requiring mid-run steering, feedback incorporation, and iterative collaboration. Nudges land at the next turn boundary. Ideal when the task involves teammate input or needs real-time course correction.
  - **Codex (`codex-exec-oneshot`)**: Strong for autonomous, well-scoped implementation, build, refactor, or test-heavy work. Steering is "queued" and applied on resume. Better when the work can proceed largely independently until a checkpoint.
- In practice today (v0 focus): Claude is the workhorse for proving steering. Codex is positioned for failover, cross-review (Spec 11), and future multi-node DAGs.
- STAFF logic (Spec 06) is currently fused into PLAN (`suggestedWorker`). Future learned model will use task_type + past outcomes to choose harness.
- No mature `task_type` taxonomy yet (flagged in open-questions.md).

How this fits skills + hooks + compaction (without breaking core):
- **Skills** are the natural place to encode specialization:
  - A "harness-selector" or "task-classifier" skill can analyze the node intent + scope and recommend Claude (when feedback/steering expected) vs Codex (pure implementation).
  - Task-specific skills (e.g. "implementation-patterns") can be activated only for Codex workers.
  - Feedback-steering skill (already added on this branch) can bias toward Claude.
- **Hooks** provide per-harness observability:
  - Claude tool events are richer for real-time steering visibility (owner specifically wants better hooks here).
  - Codex produces different events; hooks can normalize or surface them differently.
- **Compaction** must be harness-aware:
  - Claude sessions (streaming + nudges + feedback) generate more incremental history → needs frequent lean summarization.
  - Codex one-shots may accumulate large artifacts in one go → different pruning strategy (e.g., focus on diffs + test outputs).
  - Skills can carry compaction hints ("this is a steering-heavy task → aggressive turn summary").

This directly supports the vision of an agent that can be tagged in for collaborative background work: it intelligently chooses the right tool for the sub-task while still allowing steering when humans give feedback.

We will experiment with this via skills on the branch (additive only).

## Coherent Plan: Integrating Kew Ideas into Beckett (Skills + Hooks + Fleet + Memory + Sandbox)

**Branch only**: All work on `explore/skills-and-hooks`. No main commits. Everything additive and non-breaking. Core (worktrees, harness dispatch, steering/nudges, DAG/orchestrator, review/gate, own identity/agency, persistence) remains untouched. Changes only extend context assembly, PLAN outputs, hooks, and memory via skills.

**Vision Alignment** (from transcript + your feedback):
- Beckett = collaborative agent teams tag for background offload + feedback steering.
- First-class Claude (steering/feedback loops, interrupts) + Codex (implementation).
- Own GH identity, per-server/org isolation (containers in vision).
- Hooks for claude-p observability.
- Solve context/session problem ("could not determine what context belonged to what session" → agent "didnt know anything").
- Long-running tasks need compaction.
- Fleet-style coordination for multi-harness tasks with independence + reconciliation.

**Phased Plan** (logical order, iterative, measurable):

### Phase 0: Baseline & Safety (COMPLETE)
- Perf baseline script + metrics (context size, assembly time, hook eval, memory rebuild, multi-turn growth + compaction simulation).
- Document current behavior for prompts, memory, hooks, workers, harness asymmetry.
- Update BASELINE_SKILLS_HOOKS.md with vision, problems (context scoping, compaction, harness usage), and this plan.
- All tests/fake-harness paths must remain identical when features are off.

### Phase 1: Session/Context Scoping (FOUNDATION)
- Make every context injection (skills, memory, prompts) explicitly session/task/server-aware.
- Thread `sessionOrTaskId` (or channel/server/task) through loader, BrainContext, worker prep.
- Prevent cross-session pollution at the source.
- Hook events tagged with session id for observability.
- Update perf baseline to simulate cross-session vs scoped injection.
- Add to skills (e.g., scoped loading in fleet-orchestrator).

### Phase 2: Skills System (Kew + Fleet Patterns)
- Solid declarative .md skills loader (already started: active list, format with headers, session filter).
- Core skills from Kew/fleet:
  - harness-selector (Claude for steering/feedback sessions; Codex for impl).
  - fleet-orchestrator (multi-fleet coordination with Matryoshka grounding/reconciliation).
  - feedback-steering (take teammate feedback, steer without losing context).
  - research, verify (from Kew).
- Fleet discipline: orchestrator dispatches independent legs; every claim reconciled (via gate/hook/skill).
- Good Codex prompts/skills for project/implementation work ported as reusable skills.
- Skills can declare requested hooks or compaction hints.
- Integrate into PLAN (additive `activeSkills` per node) and worker/brain context (additive append).

### Phase 3: Proper Hooks (Observability + Enforcement)
- Generalize existing scope-guard into pluggable registry (already started).
- Harness-specific: richer Pre/PostToolUse for Claude (steering visibility); normalized for Codex.
- Session tagging on every hook event.
- Reconciliation hooks (force source citation check before accepting worker output).
- Skills can contribute hooks (e.g., verify skill adds extra checks).
- Use for compaction triggers or context scoping enforcement.

### Phase 4: Memory + Compaction (Kew-Style Scoping)
- Adopt Kew memory patterns: scoped (per-operator/server/person/task/general), gated writes, relevance-filtered injection, atomic ops via special blocks, dedup.
- Make Beckett's KG respect session boundaries (per-task/per-server slices + ledger).
- Bounded injection + explicit compaction (per-session, lean summaries of prior turns/feedback).
- Compaction as skill or hook-triggered (use compactContext stub; make it session-aware).
- Re-inject only scoped reconciled ledger on resume/feedback.
- Update perf baseline to measure scoped vs polluted context growth + compaction savings.

### Phase 5: Sandbox/Isolation Enhancements
- Leverage existing worktrees + hooks as "sandbox".
- Enhance for Codex: more secret-free launches (inspired by Kew builder — don't mount full agent context/memory into impl workers).
- Per-harness isolation: Claude steering sessions get full feedback context; Codex impl legs get narrow task-only context.
- Hooks for sandbox boundaries (e.g., scope + secret redaction).

### Phase 6: Harness Specialization & Fleet Coordination
- Document/use: Claude for steering/feedback-heavy background tasks; Codex for scoped implementation.
- Fleet-orchestrator skill coordinates mixed fleets (e.g., Codex impl + Claude steering oversight + audit leg).
- Reconciliation via gate + hooks (Matryoshka style: fleets return artifacts; orchestrator verifies).
- Per-session fleet limits, operator-style gates for irreversible.

### Phase 7: Integration, Measurement & Polish
- Wire skills/hooks into existing paths (manager, brain prompts, worktree prep, supervise) — always additive/fallback to current behavior.
- Re-run perf baseline after every phase (track tokens, time, bloat, compaction wins).
- Session-aware compaction + scoping prevents the "didnt know anything" failure.
- Update open-questions.md / specs references (additive notes only).
- Ensure per-server vision supported (skills/memory scoped by server).

### Phase 8: Documentation & PR Readiness
- Keep BASELINE_SKILLS_HOOKS.md as living plan + measurements.
- Create clean handoff notes (what was added, how it preserves core, how it solves context/session/harness/compaction).
- When ready: you can push the branch and open PRs (or ask me to generate diffs). Use for "open questions on PR".

**Principles**:
- Additive only. If disabled (no skills dir, empty active list), Beckett behaves exactly as baseline.
- Respect core invariants (steering via claude-p, worktree isolation, own identity, DAG, gate).
- Session-first: every new thing carries explicit session/task/server id.
- Measure everything (perf script is the source of truth).
- Align to vision: background collaboration, feedback steering, Claude+Codex first-class, isolation, observability via hooks.

This plan is coherent, ordered, and directly addresses the transcript problems while building on Kew's strengths (scoped memory, sandbox isolation, fleet orchestration with good Codex skills/prompts) and your fleet setup.

---

Current status on branch: Phases 0-2 partially complete (baseline + session threading + several skills including fleet-orchestrator + hooks registry stub + compaction simulation).

Next immediate step: Finish Phase 1 (full session scoping in more paths) and Phase 2 (make fleet-orchestrator actually influence a dispatch example additively). 

Tell me the priority or if you want me to execute the next chunk now.

You mentioned a skill that calls a "fleet", stored on your bot drive, with strong Codex prompts and skills for project work.

From inspection (edd-fleet + proj family in ~/.codex/skills and .claude/skills):
- It's a multi-fleet orchestration pattern (proj-codex, proj-grok, proj-hermes, edd-fleet, etc.).
- Main "driver" (often Codex or Claude) orchestrates independent fleets/workers.
- Strict "Matryoshka grounding": Dispatch to fleets, but **never** accept their claims as truth. Every load-bearing claim must be reconciled by a trusted party (e.g. Opus via opus-reconcile.sh against verbatim `file:line` source).
- Session scoping: Ephemeral prompts per leg (/tmp), persistent scoped ledger per research_loop/<session>. Re-injects only the ledger on resume. Prevents context bleed across legs/sessions.
- Good specialization: Codex skills/prompts tuned for implementation/orchestration; separate fleets for audit (Grok), literature (Hermes), deep research (o3), etc.
- Operator gates irreversible steps; ≤N concurrent workers; notification wrappers for long runs.
- Compaction/anti-bloat: Fleet outputs ephemeral; only reconciled findings + ledger persist.

This directly attacks the "context per session" problem ro described:
- Each fleet member/leg gets its own isolated context/prompt/session.
- The orchestrator (main thread) controls what context is carried forward (only reconciled ledger).
- No mixing of "what was said in this feedback loop" with unrelated sessions.

For Beckett (vision alignment):
- Beckett's core is already close: orchestrator + worker fleet (Claude/Codex in isolated worktrees), supervise, integrate, review/gate.
- The fleet skill's discipline (independence + mandatory source reconciliation + session-scoped persistence) can be encoded as a **Beckett skill** without changing core.
- Codex prompts/skills from your setup can become reusable Beckett skills for when dispatching Codex workers (implementation bursts).
- Hooks can implement the "reconcile" step (e.g. PostToolUse or custom hook that forces source citation check).
- Complements previous: Use with harness-selector (Claude for steering sessions, Codex for impl fleets), scoped memory, compaction (per-fleet/session).
- Per-server isolation in vision: Fleet per "org/server" with its own scoped context/ledger.
- Background + feedback steering: The fleet pattern lets one session/fleet handle steering (Claude) while dispatching sub-fleets (Codex) with clean handoffs.

We can port the *pattern* + useful Codex prompts as additive skills on this branch (e.g. a `fleet-orchestrator.md` skill + reconciliation hook example). It gives Beckett better multi-harness coordination while solving the "didnt know what context belonged where" failure.

We just landed the first code for this on the branch (skills loader and worker context now accept session/task id).

## Critical Insight: Context Must Be Session-Scoped (from conversation with ro)

You asked ro why "he" didn't like the prior setup. The root problem was **context**.

Key point: "it could [not] determine what context belonged to what session so it literally just didnt know anything."

This is a make-or-break issue for the vision:
- Beckett is meant to be invited into repos/teams (own GH account).
- "each server ID gets its own container. so the orgs are separate."
- It needs to handle multiple concurrent or sequential tasks/sessions across different channels, servers, or collaborators.
- Feedback, memory, skills, and harness state must stay correctly associated with the *right* session/thread/task.
- Without this, the agent loses grounding: it can't remember prior feedback for *this* task, can't apply the right skills for *this* context, and "just doesnt know anything."

How this affects skills + hooks + compaction + harness usage:
- **Skills** must be injectable with explicit session/task scoping, not as a global blob. A skill activated for one background task shouldn't pollute another.
- **Hooks** are perfect for observability here: they can tag events (tool calls, nudges, feedback) with session identifiers so we can reconstruct "what belonged where".
- **Compaction** has to be session-aware. You cannot naively summarize across sessions or you destroy the association.
- **Harness choice** (Claude vs Codex) is per-task/session. A steering/feedback-heavy session should prefer Claude; a pure implementation burst can use Codex — but the context passed to each must be correctly isolated.
- Current Beckett has some of the pieces (task.channelId, worker.sessionId, per-worker worktrees, memory KG), but the "it literally just didnt know anything" failure mode shows that association logic can easily get lost in practice.

This is why we're prioritizing clean declarative skills + proper hooks: they give us explicit points to enforce and observe session boundaries without rewriting the core orchestrator.

We'll use this lens for all future iterations on the branch.

---

# IMPLEMENTATION LOG (live)

## Phase 0 — Green baseline re-established (2026-06-29)

The branch did not actually build/test cleanly when handed off. Fixed, additively:

- **Tooling:** `bun` was not installed; installed locally to `~/.bun` (no sudo, reversible).
  Runtime is bun (`bun:sqlite`, `bun:test`, `.ts` imports); node can run only the perf script.
- **Tests were Mac-only:** all 4 e2e files hardcoded `REPO_ROOT="/Users/jason/Code/beckett"`
  and a `/private/tmp/...` scratch path. Made portable: `REPO_ROOT = join(import.meta.dir, "..")`
  and scratch = `$BECKETT_TEST_SCRATCH || os.tmpdir()`. Only path scaffolding changed — no test
  logic or assertions touched.
- **Pre-existing typecheck break:** `manager.ts` read `node.activeSkills` but `NodeRecord` had no
  such field (only `PlanNode` did). Added optional `NodeRecord.activeSkills` (additive).

Result: `bun run typecheck` clean · `bun test` 6/6 · `node scripts/perf-baseline.ts` runs.

## Phase 1 — Session/context scoping foundation (2026-06-29)

### Critical finding (source-proven): the additive invariant was BROKEN

`loadActiveSkills(undefined)` fell back to `loadAllSkills()` (old `skills/index.ts:85-87`). Because
the `skills/` dir was seeded on this branch, **every** worker system-append and every CLARIFY/PLAN
prompt silently injected all 5 skills. Context assembly was **7442 chars (~1861 tok)** vs the
documented **~1299 chars (~325 tok)** baseline. "Skills off" did not equal baseline — there was no
"off". (Skills/registry confirmed absent at baseline tag `13be23f`; per-node `activeSkills` also
could not persist — no `NodeRow` column, never hydrated — so it was runtime-inert.)

### Fix (additive, reversible)

- **`src/skills/index.ts` rewritten.** Empty/undefined selection → `[]` → `""` (no load-all
  fallback). A skill loads only when (1) explicitly named in an active list, or (2) an operator
  opt-in is set: `BECKETT_SKILLS_ALL=1` (whole library) or `BECKETT_SKILLS=a,b` (named). Default
  OFF. New `SkillScope` + per-scope overlay dir `<skillsDir>/scoped/<id>/*.md` that loads ONLY for
  its scope and overrides a same-named base skill — concrete per-session/per-server isolation.
- **`sessionOrTaskId` made load-bearing** (was a TODO): threaded into the loader (scopes the
  overlay), `BrainContext` (new optional `activeSkills` + `sessionOrTaskId`), the orchestrator's
  `ctx()` builder, all 6 `ctx()` call sites (clarify/plan/supervise/gate/deliver/escalation), and
  the `RecallQuery` (additive field, ignored by the current global KG → no behavior change). Removed
  the `(ctx as any)` casts in `prompts.ts`.
- **Hook registry** gained an optional `sessionOrTaskId` on `HookRegistration` (structural prep for
  Phase 3; registry is still inert, so zero behavior change).
- **`scripts/perf-baseline.ts`** rewritten to mirror the real semantics and prove the invariant:
  it now reports an ADDITIVITY CHECK and measures OFF / SCOPED / ALL modes.
- **`tests/skills.test.ts`** added (10 hermetic unit tests) — the e2e suite never asserted on
  prompt/skills content, so these lock in OFF==baseline, precedence, opt-in, and scoped overlay.

### Measurements (`node scripts/perf-baseline.ts`)

| Mode | Context size | ~tokens | Δ vs OFF |
|------|-------------|---------|----------|
| **OFF (default)** | **1299 chars** | **325** | — (== baseline; ADDITIVITY CHECK **PASS**) |
| SCOPED (2 named skills) | 5454 chars | 1364 | +4155 |
| ALL (operator opt-in, 5 skills) | 7442 chars | 1861 | +6143 |

Before the fix, OFF was effectively the 7442-char "ALL" row (always-on). After: skills cost is paid
**only when explicitly activated**. Assembly time OFF ≈ 0.003 ms/call; full library ≈ 6100 chars.

Verification: `bun run typecheck` clean · `bun test` **16/16** (6 e2e + 10 new unit).

### Deferred to later phases (by design)
- Per-node `activeSkills` **persistence** (NodeRow column + migration) and PLAN **emission** → Phase 2.
- Real per-server **memory partitioning** (KG slices) → Phase 4 (only the scope id is threaded now).
- ~~Wiring the hook registry into settings generation~~ → done in Consolidation B below.

## Consolidation pass — behavior-preserving refactors (2026-06-29)

The repo's stated goal was *consolidation* ("less sloppy"), not just additive features. Found and
fixed four duplications/dead-code sites, each with a test proving identical output. (Tooling note:
`grep` treats several src files as binary — they contain UTF-8 like `…`/`→`/BOM — so audits must use
`grep -a`; plain grep silently skips them.)

- **B — Hook registry was dead code → now the single source of truth.** `registry.ts`'s
  `getHooksForEvent`/`initBaselineHooks` had **zero consumers**; real settings came from a separate
  hardcoded path in `scope-guard.ts`. Now both flow through one `renderClaudeSettings`: scope-guard
  supplies its per-worker spec, the registry supplies any extras (Phase-3 ready). `tests/hooks.test.ts`
  asserts **byte-identical** JSON to the old output when no extras are registered. Dropped the dead
  `initBaselineHooks` call from the manager.
- **A — Three markdown parsers/listers → one.** `memory`, `cli` (`bk mem`), and `skills` each had
  their own `.md` lister, and the CLI reimplemented frontmatter splitting. Extracted
  `src/util/markdown.ts` (`listMarkdownFiles` + `splitFrontmatter`); each caller passes options that
  reproduce its exact prior filtering (memory: exact-rel `MEMORY.md` + `.git`; cli: basename; skills:
  non-recursive). `tests/util-markdown.test.ts` pins those differences. (One intentional micro-change:
  skills `.md` matching is now case-sensitive like the rest of the codebase.)
- **C — perf script no longer hand-copies the loader.** `scripts/perf-baseline.ts` now `import`s the
  REAL `loadAndFormatSkills`/`loadAllSkills`/`assembleSystem` from `src/` (node strips types). This
  killed the drift that produced the false 1299 baseline while production did 7442. Numbers unchanged
  (OFF 1299 / SCOPED 5454 / ALL 7442); opt-in correctly flips the ADDITIVITY CHECK to FAIL.
- **D — harness→driverKind mapping centralized.** Was a hardcoded ternary in `manager.ts`; now the
  canonical `DRIVER_KIND_FOR` map in `types.ts` (alongside `DriverKind`/`WORKER_TERMINAL`), consumed
  by the manager. Pure refactor.

Net: **−1 dead module path, −2 duplicate parsers, −1 drift source.** New shared module
`src/util/markdown.ts`. Verification: typecheck clean, **28/28 tests** (6 e2e + 10 skills + 5 hooks +
7 util), additive invariant PASS.