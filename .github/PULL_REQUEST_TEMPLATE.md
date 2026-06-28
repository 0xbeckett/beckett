# Pull Request

## Summary
One paragraph: what this changes and why.

## Context / Motivation
- Link to issue or discussion if any.
- Which part of the vision / pillars this advances.

## Related
**Specs touched:**
- `specs/XX-*.md`

**Open questions / decision ledger:**
- [my-docs/open-questions.md](../my-docs/open-questions.md) — entries addressed or closed by this PR:
  - (e.g. "B3 (nudge asymmetry) — accepted as documented")
  - Or new questions this surfaces.

**Verify-first / Risks (if relevant):**
- Risk-A, B, C, D, E (see specs/12 §4 and §6)
- Other ⚠️ items from specs/

## Changes
- Bullet the concrete diffs (files + behavior).
- For drivers / orchestration / brain: note any steering, scope, or gate impact.

## How to review
- What to focus on.
- Any manual steps or smoke tests required (especially for harness behavior).

## Open questions this PR leaves open
List any that remain (or explicitly "None for this change").

## Checklist
- [ ] `bun run typecheck` and `bun test` pass (or explain why skipped)
- [ ] If architecture / process / identity change: specs/ and/or my-docs/open-questions.md updated
- [ ] For code that will run on loom-desk: relevant verify-first smoke test executed or noted
- [ ] No secrets, no new root assumptions
- [ ] PR description is the single source of truth for reviewers (no wall-of-text outside it)
- [ ] (For Beckett-driven PRs later) delivery handshake respected where irreversible

---

> **Note for reviewers:** Beckett's own "review gate" philosophy applies here too — be adversarial on criteria (even if informal), surface assumptions, and own the decision. Sparseness is law in Discord; clarity is law in PRs.

> This template exists so that **open questions move from the living doc into merged decisions** via PR. Edit the ledger as part of the change when you ratify something.