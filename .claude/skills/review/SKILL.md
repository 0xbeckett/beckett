---
name: review
description: Use when a worker finishes a node, to verify its diff against the acceptance criteria and run the gate (checks AND review). Self-review for simple nodes; spawn a fresh adversarial reviewer for critical ones.
---

# review

Verify a node's diff against its criteria, then **gate**.

## Pick a tier

A node is **critical** (→ at least a fresh reviewer) if ANY hold:
- touches security/auth/crypto/payments
- touches deps/infra/CI (package.json, lockfile, Dockerfile, CI)
- blast radius ≥ 2 (other nodes depend on it)
- diff ≥ 150 lines, or files changed ≥ 8
- external surface (public API, migration, deletes data, irreversible)
- prior retries ≥ 1

Else **simple** → self-review. Most-critical → cross-provider or a panel of N fresh reviewers
(majority vote).

## Run the checks

Run every `checks[]` command in the worktree (post-integrate). All must exit 0. Run all even if
some fail (full picture). A timeout counts as fail.

## Review against NL criteria

- **Self (simple):** read the diff + check results + criteria; judge each NL statement.
- **Fresh (critical):** spawn a brand-new read-only worker that never saw the implementer's
  reasoning — give it the **criteria + diff + check results only**. Adversarial prompt: *"You did
  NOT write this and owe it no benefit of the doubt. For each NL criterion decide met/not-met,
  citing file:line. A failing check is an automatic blocker. If you can't verify a criterion from
  the diff, it is NOT met. Do not suggest fixes."* Spawn it read-only
  (`--allowedTools Read,Glob,Grep --permission-mode dontAsk`).

## Verdict format

```ts
interface ReviewVerdict {
  pass: boolean;
  criteriaMet: { criterion: string; met: boolean; note?: string }[];
  issues: { severity: "blocker"|"major"|"minor"; criterion?: string; detail: string; location?: string }[];
  confidence: number; // 0..1
}
```

## The gate (fail-closed)

`pass := checks.allPass && verdict.pass`. Re-derive it yourself: any `blocker`, any failed
check, or an unverifiable/unparseable verdict ⇒ **fail**. Never pass-by-default.

## On fail

Thread `ReviewerFeedback` (failed checks + blocker issues) into a re-dispatch — **resume + feedback**
by default (cheapest), **fresh spawn** on crash or a stuck rut. **Retry ≤ 3** (shared with crash
retries). After 3, **escalate with options**:
> "tried 3× on <node>, stuck here: <summary>. A) more rope (a hint + 2 swings) B) you take the
> branch C) drop it and ship the rest."

## Always

Log the gate outcome `(harness, model, task_type) → {passed, retries, drift_events, turns}` to
SQLite (`beckett` records this) — it feeds the learned-worker model. Never silent retry, never
silent failure.
