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

/** Plain, already-collected plan capacity data; renderers never fetch or read files. */
export interface SubscriptionLimits {
  claude: {
    available: boolean;
    limits: Array<{ label: string; percentUsed: number; resetsAt: string | null; severity: string | null }>;
    overage?: { used: number; limit: number; currency: string } | null;
  };
  codex: {
    available: boolean;
    limits: Array<{ label: string; percentUsed: number; resetsAt: string | null; severity: string | null }>;
    observedAgeMs: number | null;
    stale: boolean;
  };
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
  subscriptionLimits: SubscriptionLimits;
}
