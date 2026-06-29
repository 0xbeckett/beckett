---
name: staff
description: Use on the heavy path after plan, to assign each DAG node a worker (harness, model, effort) from capability guidance and learned-worker notes. Skip for single-worker tasks (just spawn a Claude worker).
---

# staff

Assign each node a worker: harness, model, effort. Granularity scales **inversely** with worker
strength — coarser nodes for stronger workers.

## Defaults

- **Claude / Sonnet** (own driver, steerable) — the default. Live-nudgeable.
- **Claude / Opus** — genuinely ambiguous or architecture-critical nodes.
- **Codex / pi** (via sandcastle) — where memory's learned-worker notes or the task favor them
  (e.g. a harness that's strong on a given language/task type). These are run-to-completion;
  nudges are checkpoint+resume, not live.

## Use learned notes

`recall` the worker-notes first ("Codex over-engineers data-layer nodes — 12/40 review flags;
prefer Claude or constrain"). Let real outcomes override the static defaults.

## Set the envelope per node

```ts
envelope: { effort: "low"|"medium"|"high"|"xhigh", turnCap: number, wallClockS: number, network: boolean }
```

- `effort` → model tier + reasoning level.
- `turnCap` / `wallClockS` are hard ceilings; the watcher also uses them as prompt-to-look
  thresholds (over-envelope alarm). Estimate generously — envelopes are estimates, not budgets.
- `network: false` by default; opt in only for nodes that truly need it (installs, fetches).

## Output

A worker assignment per node, ready to pass to `beckett worker spawn` along with the node's
`--owned` scope globs + `--system` criteria. Respect the global concurrency cap — `worker spawn`
errors when it's full; dispatch the deepest critical path first and spawn the rest as slots free.
