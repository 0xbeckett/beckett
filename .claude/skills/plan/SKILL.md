---
name: plan
description: Use to define "done" before doing real work. Lite mode (criteria only) for a one-worker task; full mode (DAG + criteria) for a heavy multi-worker task. Skip for trivial inline work.
---

# plan

Define **done** before doing. Author acceptance criteria; for the heavy path, also the DAG.

## Acceptance criteria (mandatory for any non-trivial work)

```ts
interface AcceptanceCriteria {
  checks: string[];           // shell commands; exit 0 = pass (deterministic floor)
  nl: string[];               // atomic English statements; reviewer judges met/not-met (ceiling)
  interfaceContract?: string; // boundary contract with parallel nodes, if any
}
```

**Authoring rules:**
- Every node has criteria (checks and/or nl; empty = a defect).
- Checks run **as-is**: non-interactive, deterministic, scoped to the node (`npm test -- src/auth`),
  network-free unless the node's envelope opts in. Prefer the project's own scripts.
- NL statements are **atomic and verifiable from the diff**: one claim each. Cover the request
  **+ error handling + backward-compat + "no check was weakened to pass."**
  - bad: "code is good." good: "malformed/expired tokens are rejected with 401, not 500."

## DAG (heavy path only)

Decompose into the **smallest right** set of nodes. Per node:
`{ id, title, intent, dependsOn, scopePaths, criteria, suggestedWorker, envelope, reviewTier, initialCheckIn }`

- **Acyclic.** Depend only on what *must* come first — maximize parallelism.
- **Scope is a contract:** non-overlapping `scopePaths` across concurrent nodes (no merge
  conflicts by choice).
- `suggestedWorker` is a proposal; `staff` confirms it.
- `initialCheckIn`: what should be true by when ("edits landing; if diff is 0 it's stuck").

## Standing to refuse

If the spec self-contradicts or can't be decomposed sanely, **emit no nodes and say why** in
channel. A bad plan is worse than a question.

## Output

Keep the plan in your working context (and as a short note if the task is long-running). The
criteria you author here are exactly what you'll paste into each worker's prompt and what
`review` checks against.
