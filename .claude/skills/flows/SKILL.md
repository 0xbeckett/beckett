---
name: flows
description: Use for BIG tasks that need several workers in a parallel/sequential shape. Write a flows/<name>.js script using the flow API, run it with `beckett flow run`. It's journaled + resumable. For trivial/medium work, do NOT use this — just answer inline or spawn one worker.
---

# flows

This is the **heavy path**, and it's opt-in. Effort scales to difficulty (your core operating
principle): most tasks are inline answers or a single `beckett worker spawn`. Reach for a flow
only when the work genuinely splits across **multiple workers** with a real shape — parts that run
in parallel, parts that must run in order, then an integration step.

## When to escalate to a flow

- The task has **independent parts** that can be built at once (API + UI + tests; three services).
- There's a **dependency order** (scaffold must land before features; features before the e2e pass).
- It's a **mix** (build 3 modules in parallel, then one worker that wires + tests them, then merge).
- It's long enough that you want it **resumable** if the shell restarts mid-run.

If it's one cohesive change, don't — spawn one worker and supervise it. A flow for a small task is
overhead and noise.

## How

1. Write a script at `flows/<name>.js` in the repo. Default-export an async `(flow) => {…}` and
   (optionally) `export const meta = { name, description }`.
2. Run it: `beckett flow run flows/<name>.js [--args '<json>']`. Returns a `runId` immediately and
   runs in the background; you get a `[flow done <runId>]` (or `[flow failed …]`) signal when it
   finishes. Check progress anytime with `beckett flow show <runId>` / `beckett flow ls`.

### The flow API

- `await flow.worker({ task, repo, owned, desc, base?, model?, system?, effort?, turnCap?, wallS?, network? })`
  — spawn one worker (worktree + scope-guard, same as `beckett worker spawn`) and resolve with its
  final **digest** when it's done. `digest.workerId` / `digest.branch` are what you integrate.
- `await flow.parallel([ (f) => f.worker({…}), (f) => f.worker({…}) ])` — run thunks concurrently,
  await all. Each thunk gets its own sub-API `f` (use it, not the outer `flow`, inside thunks).
- `await flow.sequence([ (f) => …, (f) => … ])` — run thunks in order.
- `await flow.integrate([id1, id2], 'main')` — merge those worker branches into a target branch.
- `flow.nudge(id, text)` — live mid-task steer of a still-running worker.
- `flow.log(msg)` — progress line (also reaches you as a `[flow …]` signal).
- `flow.args` — whatever you passed to `--args`.

### Patterns

```js
// flows/build-x.js — parallel build, sequential integrate
export const meta = { name: 'build-x', description: 'api + ui in parallel, then tests, then merge' };
export default async function (flow) {
  const repo = flow.args.repo;
  const [api, ui] = await flow.parallel([
    (f) => f.worker({ task: 'build the REST API',  repo, owned: ['api/**'], desc: 'api' }),
    (f) => f.worker({ task: 'build the web UI',    repo, owned: ['web/**'], desc: 'ui'  }),
  ]);
  const tests = await flow.worker({ task: 'write integration tests across api+web', repo, owned: ['test/**'], desc: 'tests' });
  await flow.integrate([api.workerId, ui.workerId, tests.workerId], 'main');
  flow.log('shipped — api+ui+tests merged');
}
```

```js
// sequential deploy: each stage gates the next
export default async function (flow) {
  await flow.sequence([
    (f) => f.worker({ task: 'run db migration',    repo, owned: ['migrations/**'] }),
    (f) => f.worker({ task: 'deploy the service',  repo, owned: ['**'] }),
    (f) => f.worker({ task: 'smoke-test prod',     repo, owned: ['**'] }),
  ]);
}
```

## Resumability

Every `worker`/`integrate` step is journaled to `~/.beckett/flows/<runId>/`. If a run is
interrupted (shell restart, crash), `beckett flow resume <runId> flows/<name>.js` replays the
completed steps from the journal **instantly** and only re-runs the unfinished tail — committed
worker branches aren't rebuilt. This pairs with [[resume]]: `beckett flow ls` shows interrupted
runs, and resuming continues them. Keep the script stable between run and resume (don't reorder
steps) so the journal keys line up.

## After a flow

Report in voice ([[deliver]]). A flow that merged to `main` is the irreversible finish line — if
that wasn't already greenlit, do the integrate into a `beckett/*` branch instead and surface the
merge handshake rather than merging to main unprompted ([[github]]).
