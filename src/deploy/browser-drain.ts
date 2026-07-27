/**
 * Bounded browser-run preflight used by production deploys before restarting the daemon.
 *
 * Browser runs own a volatile Claude session and Chromium lease. Neither survives a restart, so
 * a deploy must wait for every accepted run to finish or refuse before it calls systemctl.
 */

export interface BrowserRunForDrain {
  runId: string;
  state: string;
  startedAt: number;
}

export interface BrowserDrainResult {
  drained: boolean;
  runs: BrowserRunForDrain[];
}

export interface BrowserDrainOptions {
  /** Reads the JSON emitted by `beckett browser status` from the still-running daemon. */
  status: () => Promise<unknown>;
  /** Maximum time to wait. Callers must cap this at a safe operational limit. */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each bounded sleep while accepted browser work remains. */
  onWaiting?: (runs: BrowserRunForDrain[], remainingMs: number) => void;
}

/**
 * Extract work that a restart would cancel. The CLI prints the bus `data` directly, while a
 * direct control-bus caller receives `{ ok, data }`; accepting both prevents the preflight from
 * accidentally treating a live CLI result as idle.
 */
export function restartBlockingBrowserRuns(status: unknown): BrowserRunForDrain[] {
  if (!status || typeof status !== "object") return [];
  const envelope = status as { data?: unknown; runs?: unknown };
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : status;
  const runs = (data as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter((run): run is BrowserRunForDrain => {
    if (!run || typeof run !== "object") return false;
    const value = run as Record<string, unknown>;
    // Queued is included deliberately: this daemon cancels queued work during shutdown rather
    // than replaying it later, so it too must be protected from a deploy.
    return (
      typeof value.runId === "string" &&
      (value.state === "queued" || value.state === "running" || value.state === "waiting") &&
      typeof value.startedAt === "number"
    );
  });
}

/** Poll until all accepted browser work drains, or return the blockers at a finite deadline. */
export async function waitForBrowserDrain(options: BrowserDrainOptions): Promise<BrowserDrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const deadline = now() + Math.max(0, options.waitMs);

  while (true) {
    const runs = restartBlockingBrowserRuns(await options.status());
    if (runs.length === 0) return { drained: true, runs: [] };

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { drained: false, runs };
    options.onWaiting?.(runs, remainingMs);
    await sleep(Math.min(pollMs, remainingMs));
  }
}
