# Contributing to Beckett

Beckett is built from detailed specs first. The goal is a real agentic coworker, not a toy. Changes (especially anything touching architecture, the control plane, identity, or the loop) must keep the decision ledger honest.

## The decision ledger (your primary reference)

- **Canon**: [specs/00-overview.md](specs/00-overview.md) — vision, four pillars, canonical decisions, glossary, phasing.
- **Living open questions + decisions log**: [my-docs/open-questions.md](my-docs/open-questions.md) — most items are now 🟢 decided; remaining 🔴 or design choices are tracked here.
- **Detailed design**: the rest of `specs/`. Spec 12 is the build + verify-first roadmap.
- Everything else (code, tests, setup) derives from these.

If a change would invalidate something in the canon or the ledger, **update the docs in the same PR**.

## How we handle open questions

Open questions live in `my-docs/open-questions.md` (and scattered ⚠️ in specs).

**The process is PR-driven**:

1. Open a PR (even a docs-only PR) that proposes a resolution, a new question, or a ratification of a leaning.
2. In the PR description use the template's "Open questions / decision ledger" section.
3. Link the exact heading or bullet from `open-questions.md`.
4. When the PR merges, the question is considered closed or recorded (update the status emoji + date in the ledger as part of the PR).
5. Major unresolved items can also be turned into GitHub Issues labeled `question` or `architecture` for visibility, then linked from a PR that closes them.

We do **not** leave the ledger stale. The PR is the artifact that moves a question from "open" to "decided".

## What belongs in a PR

- Code changes
- Spec clarifications or corrections
- New or resolved entries in the decision ledger
- loom-desk setup updates (when they affect the public record)
- Test fixtures or harness behavior recordings (when they ratify a verify-first item)

Small drive-by fixes (typos in docs, obvious bugs in early src) can be direct commits or tiny PRs, but anything that touches the four pillars, the state machine, worker abstraction, review/gate, identity, or memory **must** go through a PR that touches the relevant spec + ledger.

## PR expectations

- Use the [PULL_REQUEST_TEMPLATE](.github/PULL_REQUEST_TEMPLATE.md).
- Keep the description self-contained — reviewers should not have to dig through Slack/Discord to understand the change.
- For anything that will run against the real `claude`/`codex` on loom-desk, call out the relevant Risk (A–E) or verify-first item and whether you ran the smoke test.
- "Sparseness is law" for Discord delivery. "Clarity + evidence is law" for PRs and specs.

## Review style (mirror the product)

- Be a **fresh adversarial reviewer** when the change is critical.
- Surface assumptions explicitly.
- If you would nudge/abort/escalate in the real system, say so here.
- The author owns the decision once merged.

## Local dev

See [specs/12-roadmap-setup.md](specs/12-roadmap-setup.md) for the full loom-desk setup and phased roadmap.

Quick commands (once you have the harnesses):

```bash
bun install
bun run typecheck
bun test
bun run cli --help
```

The daemon and workers are meant to run as the dedicated `beckett` user on loom-desk.

## Questions

New architectural or process questions:
- File a GitHub Issue (use the "question" label) or
- Start a section in `my-docs/open-questions.md` and open a PR that references it.

We resolve via PRs so the history is in git + the GitHub PR record.

---

Thank you for helping build a real coworker instead of another chat wrapper. Own your decisions.