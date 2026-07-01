# OPS-26 Perf Audit

Concrete hot-path changes for message -> ticket -> worker -> review -> ship latency.

## Implemented Speedups

1. `src/config.ts`, `src/plane/poll.ts`: default Plane polling drops from 15s to 5s while the poller stops reading comments for unchanged tickets.
   - Latency saved: ticket pickup, review-state pickup, cancellation, and relay detection worst-case wait drops by 10s; average wait drops by about 5s.
   - Load tradeoff: base `listIssues` cadence is 3x higher, but unchanged active tickets no longer spend one `GET /comments` round-trip each tick. On a board with 5 unchanged active tickets, this removes 5 comment requests per tick, typically 1-3s of serialized HTTP wait under the old loop.

2. `src/plane/poll.ts`: comment polling is gated by issue `updatedAt`, with a 60s compatibility sweep, and changed tickets' comment fetches run concurrently.
   - Latency saved: unchanged active tickets save one Plane comment round-trip per ticket per tick, usually 200-600ms each. When 4 changed tickets all need comment reads, wall-clock becomes one comment RTT instead of four, saving roughly 600-1800ms per poll batch.
   - Tradeoff: relies on Plane bumping issue `updated_at` for comments for fastest steering; the 60s sweep preserves eventual delivery on installs that do not.

3. `src/dispatch/dispatcher.ts`: done tickets set Plane state before best-effort GitHub publishing, then promote dependents immediately.
   - Latency saved: the done transition no longer waits for GitHub create/push, typically 2-8s. Dependent DAG tickets start in the same finish handler instead of waiting for the next poll, saving one poll interval, now 5s by default and 15s on existing configs.
   - Tradeoff: a ticket may show `done` before the GitHub URL comment is posted. Publishing was already best-effort and failure-tolerant.

4. `src/worker/worktree.ts`: concurrent `ensureProjectRepo(repoRoot, slug)` calls for the same project share one in-flight provisioning promise.
   - Latency saved: sibling tickets sharing a project avoid duplicate `git ls-remote`/clone/init work. For N concurrent siblings, this removes N-1 remote probes or clones; a typical saved probe is 300ms-2s, and a duplicate clone can be much higher.
   - Tradeoff: none intended; failed provisioning clears the in-flight entry so the next attempt retries.

5. `src/plane/client.ts`: Plane client bootstrap is now single-flight.
   - Latency saved: parallel callers, especially `beckett plan`, no longer duplicate project and workflow-state discovery. This removes duplicate project/states page fetches, typically 2 HTTP round-trips per extra concurrent caller.
   - Tradeoff: none intended; failed bootstrap clears the promise and remains retryable.

6. `src/cli/beckett.ts`: `beckett plan` files each independent DAG layer concurrently instead of serially.
   - Latency saved: for a layer width W, issue creation wall-clock drops from W POST round-trips to one POST round-trip. A 6-ticket independent root layer at 300-700ms per POST saves about 1.5-3.5s.
   - Tradeoff: Plane sees short bursts of create requests; dependencies are still respected level-by-level, so `blockedBy` identifiers remain correct.

## Audited But Left Alone

- `src/dispatch/spawn.ts`: per-worker metadata writes and `currentBranch()` are small local filesystem/git costs compared with harness cold start; changing them would save only milliseconds and risks weakening handle/debug information.
- `src/drivers/claude.ts` and `src/drivers/codex.ts`: 60s spawn-start timeouts are failure ceilings, not normal-path waits. Lowering them would only fail slow but valid harness launches faster.
- `src/concierge/index.ts` and `src/discord/gateway.ts`: the Discord relay is already long-lived and fire-and-forget for ticket updates; the largest delay is the Concierge model turn, not the gateway post path.

## Verification

- `src/plane/poll.test.ts` covers unchanged-ticket comment skips, changed-ticket comment reads, and parallel comment fetch order.
- `src/dispatch/dispatcher.test.ts` covers immediate dependent promotion from a worker completion without waiting for a later poller `done` event.
