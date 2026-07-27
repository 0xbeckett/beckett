/**
 * Bounded browser-lease guard used by the production deploy before it restarts the daemon.
 *
 * A browser run has a live Claude session and Chromium lease, neither of which can survive a
 * daemon restart.  Do not restart underneath one: wait briefly with an explicit operator-facing
 * message, then refuse rather than silently discarding it.
 */

export interface BrowserRunForDrain {
  runId: string;
  state: string;
  startedAt: number;
  task?: string;
}

export interface BrowserDrainResult {
  drained: boolean;
  runs: BrowserRunForDrain[];
}

export interface BrowserDrainOptions {
  /** Reads the JSON payload printed by `beckett browser status`. */
  status: () => Promise<unknown>;
  /** Maximum time to wait. The caller is responsible for applying an upper bound. */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each bounded sleep while a lease is still live. */
  onWaiting?: (runs: BrowserRunForDrain[], remainingMs: number) => void;
}

/** Extract only runs that would lose volatile browser state if the daemon stopped now. */
export function liveBrowserRuns(status: unknown): BrowserRunForDrain[] {
  if (!status || typeof status !== "object") return [];
  const data = (status as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const runs = (data as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter((run): run is BrowserRunForDrain => {
    if (!run || typeof run !== "object") return false;
    const value = run as Record<string, unknown>;
    return (
      typeof value.runId === "string" &&
      (value.state === "running" || value.state === "waiting") &&
      typeof value.startedAt === "number"
    );
  });
}

/**
 * Poll browser status until its volatile leases drain, or until the finite deadline expires.
 * Queued runs are deliberately not blockers: the browser agent's durable ledger re-queues them
 * on boot; only running/waiting runs would be destroyed by a restart.
 */
export async function waitForBrowserDrain(options: BrowserDrainOptions): Promise<BrowserDrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const deadline = now() + Math.max(0, options.waitMs);
  let runs: BrowserRunForDrain[] = [];

  while (true) {
    runs = liveBrowserRuns(await options.status());
    if (runs.length === 0) return { drained: true, runs: [] };

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { drained: false, runs };
    options.onWaiting?.(runs, remainingMs);
    await sleep(Math.min(pollMs, remainingMs));
  }
}
