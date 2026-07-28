# Multi-lease browser runtime (#32)

Since betterwright 1.3.0 the session daemon runs separate `--session`s concurrently
while keeping calls *within* one session strictly ordered
(`node_modules/betterwright/docs/sessions.md`, "Concurrency"). The BetterWright
adapter (`src/browser/betterwright.ts`) adopts that: it holds a **map of concurrent
leases**, one betterwright session per run, instead of a single global `active`
lease. Sessions share the one browser, policy guard, vault and Chromium profile, so
a login done in one session still serves the others.

Every per-run guard keys off its own lease, so one run can never blind, throttle, or
corrupt another:

- **Profile-budget accounting** — the per-lease growth allowance is measured from
  each lease's own acquire baseline; the absolute profile ceiling is global and
  shared. Whichever binds first wins. A lease that trips its budget stays tripped
  until it releases and never touches another lease's accounting.
- **Download approval gate** — BetterWright launches once with
  `downloadPolicy: "ask"` and that launch-level setting is never mutated. The
  adapter keeps an approval set by session and passes
  `approvedDownloads: true` only on calls from an explicitly approved lease.
  Therefore releasing lease A cannot grant, revoke, or restart lease B's pages.
- **Proof capture and the event ring** — both are per-lease and never interleave.

## Concurrency cap

Concurrency is capped because this is a real browser on a real machine, not a fleet.

- Default: **3** concurrent leases.
- Hard upper bound: 16, regardless of configuration.
- Acquiring past the cap fails fast with a catchable `BrowserLeaseCapExceededError`
  (it never hangs). A slot frees up on release, so the same runtime keeps serving.

| Env var | Effect | Default |
| --- | --- | --- |
| `BECKETT_BROWSER_MAX_LEASES` | Positive integer; sets the concurrent-lease cap (clamped to the 16 hard cap). | `3` |
| `BECKETT_BROWSER_SINGLE_LEASE` | **Kill switch.** Truthy (`1`/`true`/`yes`/`on`) pins the cap to a single lease. | off |

## Kill switch

`BECKETT_BROWSER_SINGLE_LEASE=1` forces strictly-single-lease behaviour, restoring
the pre-1.3.0 semantics — a second concurrent acquire fails with the old
`computer-use is busy with run <id>` error instead of running in parallel. It
overrides `BECKETT_BROWSER_MAX_LEASES` (a higher configured cap cannot re-enable
concurrency while the kill switch is engaged). Use it to turn off a bad interaction
without a revert.

Both vars are read by the adapter and forwarded into the sandboxed browser host by
`src/browser/isolated.ts`, so setting them in the daemon's environment takes effect
inside the isolated host process.

## #96 BetterWright 1.5.1 parallel verification

`bun run browser:smoke` was run with BetterWright **1.5.1**. Its production-host
check acquires `betterwright-parallel-alpha` and `betterwright-parallel-beta` at
the same time, holds alpha in a 1.5-second local navigation, and asserts beta's
separate session completes before alpha. The observed result was:

```text
betterwright browser MCP and default-profile parallel-session smoke passed
```

No named profile is needed: Beckett creates one `BetterWright` client without a
`profile` option and passes each lease's run id as its `session`. Those sessions
share the backward-compatible default profile and its daemon, so no second
worker attempts to own (or collide on) that profile lock. Named profiles remain
an upstream identity feature and are not exposed as Beckett configuration.
