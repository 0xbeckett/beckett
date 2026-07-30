# `p-turn-budget` — in-run turn and dollar ceilings

**Priority 4.** Small, and it makes an existing config promise true.

## Problem

Two ceilings that don't exist under pi:

**Turns.** `claude --max-turns` caps a run. pi has none (`LANE_GAPS.maxTurns`,
`src/drivers/lane.ts:135-137`), so the only bound on a pi worker is the caller's wall-clock
timeout. A worker in a tool-call loop burns its entire wall-clock budget and reports nothing.

**Dollars.** `budget.per_task_usd_cap` is configured at **$40** in `~/.beckett/config.toml`, with
a comment explaining the distribution it was chosen from. But pi reports real per-turn cost and
`PiDriver` accumulates it *for telemetry only* (`src/drivers/pi.ts:973-988`) — nothing consults
it mid-run. The cap is enforced, if at all, after the money is spent. The recorded outliers that
motivated the cap ran $45–$109; a post-hoc cap would not have stopped any of them.

This matters much more now than it did. Adding OpenRouter means adding a *metered* account —
subscription overruns cost patience, credit overruns cost cash.

## Mechanism

`pi.on("turn_start")` / `pi.on("turn_end")` plus `ctx.abort()`.

1. Flags: `pi.registerFlag("max-turns", …)` and `pi.registerFlag("max-usd", …)`.
2. Count `turn_start`. Sum `turn_end.message.usage.cost.total` — the same field `PiDriver` reads,
   so the two numbers agree by construction.
3. On breach, do **not** just abort. Abort produces a worker that dies with no explanation, which
   is the failure mode Beckett has repeatedly paid for. Instead:
   - inject one final user turn: "You have hit your budget ceiling (`<what>`: `<value>` of
     `<limit>`). Stop working. Emit your done-signal now with `status: "blocked"` and
     `blockedReason` naming the ceiling, listing what you completed and what remains";
   - allow exactly that one turn (a small grace allowance above the ceiling — name it, e.g. 10%);
   - then `ctx.abort()` if it doesn't comply.

   A worker that stops *and reports its state* is resumable. One that is killed is not, and
   re-running it from scratch costs more than the ceiling saved.
4. Emit a warning frame at 80% of either ceiling, so the ticket shows the approach rather than
   only the arrival.
5. **Report cost honestly when the provider doesn't.** `usage.cost.total` is present for
   OpenRouter and populated from model metadata elsewhere; where it is zero or absent, the dollar
   ceiling cannot be enforced and the extension must say so at startup rather than silently
   enforcing only the turn cap. A budget guard you believe in but that isn't running is worse than
   none.

## Beckett-side changes this enables

- `PiDriver.buildArgs` passes `-e <p-turn-budget> --max-usd <remaining-per-task-budget>`, computed
  from `budget.per_task_usd_cap` minus what the ticket has already spent per `src/spend.ts`. That
  makes the cap a genuine per-*task* cap across retries and rework cycles, not a per-run one.
- `LANE_GAPS.maxTurns` deleted; lanes can pass real turn caps.
- `error_budget` becomes a distinguishable outcome, separate from `crash` and from wall-clock
  timeout — which today are the same undifferentiated dead worker.

## Verification

1. A fixture worker in a deliberate loop hits the turn cap, emits a `blocked` done-signal naming
   the ceiling, and exits — assert the done-signal reaches `PiDriver`, not just that the process
   died.
2. A worker given `--max-usd 0.01` against a real cheap model stops after the first turn or two
   with `blocked`.
3. The 80% warning fires exactly once.
4. A healthy short run is completely unaffected — no extra turns, no warnings.
5. The dollar total the extension computes equals `PiDriver.usdEstimate()` for the same run.

## Failure modes

- **Grace turn also loops.** Hence the hard `ctx.abort()` backstop. Test it.
- **Interaction with `MAX_SETTLE_DRAINS`.** The budget's grace turn and the driver's steering
  drain both want to be "the last turn." Budget wins: a run over its ceiling should not spend more
  turns draining nudges.
- **Resumed sessions.** Turn count resets on relaunch (`--session <id>`), so the turn cap is
  per-process while the dollar cap should be per-task. Be explicit about which is which; a turn
  cap that silently resets on every crash-resume is not a cap.

## Size

**S.** Two counters and a graceful stop. The judgment is all in the graceful-stop design and in
being honest when cost data is unavailable.
