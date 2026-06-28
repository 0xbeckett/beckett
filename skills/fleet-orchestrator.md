# Fleet Orchestrator

Pattern for coordinating multiple independent "fleets" (harness workers) with strong independence and reconciliation. Adapted from proven local Claude/Codex fleet skills (proj family + edd-fleet).

## Core Discipline (Matryoshka Grounding)
- Main orchestrator (Beckett brain + PLAN/STAFF) dispatches to independent fleets.
- **Never accept fleet claims as truth.** Every load-bearing claim (code change, research finding, decision) must be reconciled against verbatim source (`file:line` or equivalent) by a trusted party (e.g. via review/gate or a dedicated reconcile skill/hook).
- Fleets return primary artifacts (diffs, excerpts, raw outputs). Orchestrator spot-checks + reconciles.
- Independence: Different fleets can use different harnesses/models for cross-verification (Claude for steering/feedback, Codex for implementation, future Grok/Hermes for audit/lit).

## Session Scoping (solves "didnt know what context belonged to what session")
- Each fleet leg / worker gets its own isolated context (per worktree + per-task memory slice + ephemeral prompts if needed).
- Persistent ledger only for *reconciled* findings per task/session (similar to per-RL dirs).
- On resume or new feedback: re-inject only the scoped ledger + active skills for *this* session.
- Prevents cross-session pollution. Ties directly to per-server/org isolation in the vision.

## Harness Specialization (Claude vs Codex)
- **Claude fleets**: Steering, feedback incorporation, iterative collaboration, observability (leverages claude-p interrupts/nudges).
- **Codex fleets**: Well-scoped implementation, build, refactor, test generation (good Codex prompts/skills from the source setup).
- Use harness-selector skill + this fleet orchestrator to decide per-node.
- Fleet can mix: e.g., Codex impl leg + Claude steering oversight in same task DAG.

## How it works in Beckett
- PLAN emits DAG nodes + suggested workers + active skills (including this fleet-orchestrator + specific legs).
- Orchestrator dispatches workers (existing mechanism) but tags them as fleet legs.
- SUPERVISE / hooks surface per-leg events with session/task id for reconciliation.
- REVIEW/GATE acts as the reconcile step (criteria + source verification).
- Skills like feedback-steering or research can be activated per fleet leg.

## Useful Codex Prompts/Skills to Port
(From the local bot drive setup)
- Codex as DRIVER/orchestrator for project work.
- Reconciliation wrappers (opus-reconcile style) that force source citation.
- Notification/supervision for long-running fleet legs.
- Anti-bloat: ephemeral per-leg outputs; only reconciled ledger persists.

## Integration with Existing
- Builds on worker abstraction (each fleet member = a scoped worker in its worktree).
- Uses skills for declarative behavior (no core changes).
- Hooks for better observability per fleet leg (e.g. tag tool calls with fleet/session).
- Complements compaction: compact per-fleet/session, not globally.

## Guardrails
- Operator (human) or review gate for irreversible steps.
- Limit concurrent fleet legs.
- Every fleet output goes through reconciliation before it affects the main task state or delivery.

This pattern gives Beckett the multi-agent power and session discipline the vision needs, while keeping Claude + Codex first-class and solving the context/session isolation problem.