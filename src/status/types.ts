import type { SystemMetrics } from "../system-metrics.ts";
import type { UptimeSnapshot } from "../uptime.ts";

/** One core operation observed by the status snapshot collector. */
export interface CoreOperationHealth {
  name: string;
  /** Whether the most recent observation could reach the operation. null means not observed yet. */
  reachable: boolean | null;
  lastSuccessAt: number | null;
  lastSuccessAgeMs: number | null;
  consecutiveFailures: number;
  /** A short, non-secret diagnostic such as an HTTP status. */
  detail?: string;
}

export interface HarnessUsage {
  harness: string;
  last24h: { records: number; turns: number; tokensIn: number; tokensOut: number; costUsd: number | null };
  last7d: { records: number; turns: number; tokensIn: number; tokensOut: number; costUsd: number | null };
}

/** All I/O has already happened by the time this value reaches a renderer. */
export interface StatusDashboardSnapshot {
  collectedAt: string;
  /** The tracker cadence, used to give health staleness a concrete meaning. */
  pollIntervalMs: number;
  versions: { beckett: string; bun: string; bored: string | null };
  uptime: UptimeSnapshot;
  system: SystemMetrics;
  health: CoreOperationHealth[];
  harnessUsage: HarnessUsage[];
}
