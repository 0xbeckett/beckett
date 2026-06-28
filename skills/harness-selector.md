# Harness Selector

This skill helps decide or bias the choice between Claude Code and Codex for a given node.

## Core Rules (from Beckett vision)
- Prefer **Claude** when the task involves:
  - Steering / mid-task feedback from teammates
  - Iterative refinement or exploration
  - Real-time course correction
  - Observability into the process (claude -p streams are easier to nudge and inspect)
- Prefer **Codex** when the task is:
  - Well-scoped implementation, build, refactor, or test generation
  - Largely autonomous once started
  - Better suited to one-shot or resumable execution

Codex does not support the same level of mid-run interrupts/steering as claude -p (nudges are deferred to resume).

## Usage in PLAN
When active, this skill's guidance should influence `suggestedWorker` in the PlanNode.
The skill can also output rationale that gets recorded for the learned capability model later.

Example activation:
- Any node whose intent mentions "implement", "build", "refactor", "write tests" without "with feedback" or "collaborate" → lean Codex.
- Nodes that mention "steer", "feedback", "adjust based on", "review with team" → Claude.

## Interaction with other skills
- Combine with feedback-steering.md → strongly bias Claude.
- Combine with research/verify.md → can work on either, but Claude for interactive verification.

This skill is informational for now (additive). Later it can feed directly into STAFF logic.