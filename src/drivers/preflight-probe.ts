/**
 * Beckett — preflight probe helper (`src/drivers/preflight-probe.ts`)
 * =======================================================================================
 * A shared, correctly-classified wrapper around `Bun.spawnSync` for the harness preflights
 * (`pi` / `claude` / `codex`). It exists to fix a single, expensive bug (issue #54):
 *
 *   `Bun.spawnSync({ timeout })` returns `exitCode: null` when the child is KILLED — either
 *   by the timeout budget or an external signal — NOT when the child fails. A child that
 *   exits non-zero carries a real number in `exitCode`. The old preflights funnelled BOTH
 *   into the same "exited N: <stderr>" branch, so a probe that merely lost a race for CPU
 *   under machine load looked identical to a genuinely broken install. The dispatcher then
 *   fell open and silently downgraded the cast to another harness — a deliberate model/effort/
 *   cost choice rewritten by a transient load spike, reported as a bare "exited null".
 *
 * {@link probeCommand} draws the line the OS already draws: a `null` exit code (with a signal)
 * is a KILL/timeout, distinct from a real non-zero exit. On a timeout it RETRIES with a longer
 * budget before giving up, so a probe starved by two heavy workers gets a second, roomier
 * chance to answer before its harness is declared unavailable.
 */

/** The classified outcome of one or more {@link probeCommand} attempts. */
export interface ProbeResult {
  /** The child ran to completion and exited 0. */
  ok: boolean;
  /**
   * The child was KILLED (timed out against its budget, or signalled) rather than exiting on
   * its own — `Bun.spawnSync` reports this as `exitCode: null` plus a `signalCode`. This is the
   * "transient load, not broken" case: the probe never got to answer, so it must NOT be treated
   * as a real failure of the binary.
   */
  timedOut: boolean;
  /** The real exit code when the child exited on its own; null when it was killed. */
  exitCode: number | null;
  /** The signal that killed the child (e.g. "SIGTERM"), when {@link timedOut}. */
  signalCode: string | null;
  stdout: string;
  stderr: string;
  /** How many attempts ran (>1 only when an earlier attempt timed out and was retried). */
  attempts: number;
  /** The timeout budget (ms) of the FINAL attempt — what a "did not complete" message reports. */
  budgetMs: number;
  /** An exception from spawn itself (binary not on PATH); null when the child at least started. */
  spawnError: Error | null;
}

/** Default escalating budgets (ms): a generous first try, then a roomier retry under load. */
export const DEFAULT_PROBE_BUDGETS_MS = [30_000, 60_000] as const;

/**
 * Run a short probe command (`<bin> --version` / `--help`) and classify the outcome so a KILLED
 * probe is never mistaken for a failed one. Retries once per subsequent budget when — and only
 * when — an attempt was KILLED (timed out); a real non-zero exit is returned immediately (a
 * broken binary won't fix itself with more time). A spawn exception (binary absent) is captured
 * on `spawnError` rather than thrown, so callers keep their existing try/catch-free flow.
 */
export function probeCommand(
  cmd: string[],
  env: Record<string, string | undefined>,
  opts: { budgets?: readonly number[] } = {},
): ProbeResult {
  const budgets = opts.budgets && opts.budgets.length > 0 ? opts.budgets : DEFAULT_PROBE_BUDGETS_MS;
  let last: ProbeResult | null = null;

  for (let attempt = 0; attempt < budgets.length; attempt++) {
    const budgetMs = budgets[attempt]!;
    try {
      const r = Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe", timeout: budgetMs });
      // A child killed by the timeout (or any signal) reports exitCode null + a signalCode. That
      // is a KILL, not a failure of the binary — the OS never let it answer.
      const killed = r.exitCode === null;
      last = {
        ok: r.success && r.exitCode === 0,
        timedOut: killed,
        exitCode: r.exitCode,
        signalCode: (r as { signalCode?: string | null }).signalCode ?? null,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
        attempts: attempt + 1,
        budgetMs,
        spawnError: null,
      };
      // Success, or a real (non-null) exit code: nothing a longer budget would change. Stop.
      if (!killed) return last;
      // Killed → fall through and retry with the next, larger budget (if any remain).
    } catch (err) {
      // Spawn itself threw (binary not runnable on PATH). Not a timeout — return immediately.
      return {
        ok: false,
        timedOut: false,
        exitCode: null,
        signalCode: null,
        stdout: "",
        stderr: "",
        attempts: attempt + 1,
        budgetMs,
        spawnError: err as Error,
      };
    }
  }

  // Every attempt was killed: report the last (largest-budget) timeout.
  return last!;
}
