/** Snapshot collector for the status dashboard. All network/disk work stays here, never in renderers. */
import { boredBaseUrl } from "../bored/client.ts";
import { readSpendLedger, summarizeSpendWindows } from "../spend.ts";
import type { SystemMetrics } from "../system-metrics.ts";
import type { TrackerPoller } from "../tracker/poll.ts";
import type { TrackerClient } from "../tracker/client.ts";
import { readUptimeSnapshot } from "../uptime.ts";
import type { CoreOperationHealth, HarnessUsage, StatusDashboardSnapshot } from "./types.ts";

export interface StatusSnapshotCollectorDeps {
  version: string;
  pollIntervalMs: number;
  poller: Pick<TrackerPoller, "stats">;
  tracker: Pick<TrackerClient, "stats">;
  metrics: { read(): Promise<SystemMetrics> };
  lifecycleLedgerPath: string;
  spendPath: string;
  boredUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface HealthProbe {
  reachable: boolean;
  status: number | null;
  version: string | null;
}

/** Long-lived collector: it retains /health's last known success between 60-second snapshots. */
export class StatusSnapshotCollector {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private healthLastOkAt: number | null = null;
  private healthFailures = 0;
  private healthVersion: string | null = null;

  constructor(private readonly deps: StatusSnapshotCollectorDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async collect(): Promise<StatusDashboardSnapshot> {
    const now = this.now();
    const [system, probe] = await Promise.all([this.deps.metrics.read(), this.probeHealth()]);
    const poll = this.deps.poller.stats();
    const tracker = this.deps.tracker.stats();
    const trackerFailedAfterSuccess = tracker.lastErrorAt !== null &&
      (tracker.lastOkAt === null || tracker.lastErrorAt > tracker.lastOkAt);
    const health: CoreOperationHealth[] = [
      {
        name: "Tracker poll",
        reachable: poll.lastPollAt === null ? null : poll.consecutiveFailures === 0,
        lastSuccessAt: poll.lastPollAt,
        lastSuccessAgeMs: poll.lastPollAgeMs,
        consecutiveFailures: poll.consecutiveFailures,
        detail: poll.consecutiveFailures ? `${poll.consecutiveFailures} consecutive failures` : undefined,
      },
      {
        name: "Bored API",
        reachable: tracker.lastOkAt === null ? null : !trackerFailedAfterSuccess && isSuccess(tracker.lastHttpStatus),
        lastSuccessAt: tracker.lastOkAt,
        lastSuccessAgeMs: age(now, tracker.lastOkAt),
        consecutiveFailures: trackerFailedAfterSuccess ? 1 : 0,
        detail: tracker.lastHttpStatus === null ? undefined : `HTTP ${tracker.lastHttpStatus}`,
      },
      {
        name: "Bored /health",
        reachable: probe.reachable,
        lastSuccessAt: this.healthLastOkAt,
        lastSuccessAgeMs: age(now, this.healthLastOkAt),
        consecutiveFailures: this.healthFailures,
        detail: probe.status === null ? "request failed" : `HTTP ${probe.status}`,
      },
    ];
    return {
      collectedAt: new Date(now).toISOString(),
      pollIntervalMs: this.deps.pollIntervalMs,
      versions: {
        beckett: this.deps.version,
        bun: process.versions.bun ?? "unknown",
        bored: probe.version ?? this.healthVersion,
      },
      uptime: readUptimeSnapshot(this.deps.lifecycleLedgerPath, now),
      system,
      health,
      harnessUsage: usage(this.deps.spendPath, now),
    };
  }

  private async probeHealth(): Promise<HealthProbe> {
    try {
      const response = await this.fetchImpl(`${(this.deps.boredUrl ?? boredBaseUrl()).replace(/\/$/, "")}/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      });
      const status = response.status;
      if (!response.ok) {
        this.healthFailures++;
        return { reachable: false, status, version: null };
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const version = typeof body?.version === "string" ? body.version : null;
      this.healthLastOkAt = this.now();
      this.healthFailures = 0;
      if (version) this.healthVersion = version;
      return { reachable: true, status, version };
    } catch {
      this.healthFailures++;
      return { reachable: false, status: null, version: null };
    }
  }
}

function usage(path: string, now: number): HarnessUsage[] {
  const windows = summarizeSpendWindows(readSpendLedger(path), now);
  const rows24 = new Map(windows.last24h.byHarness.map((row) => [row.name, row]));
  const rows7 = new Map(windows.last7d.byHarness.map((row) => [row.name, row]));
  return [...new Set([...rows24.keys(), ...rows7.keys()])].sort().map((harness) => ({
    harness,
    last24h: compact(rows24.get(harness)),
    last7d: compact(rows7.get(harness)),
  }));
}

function compact(row: { records: number; turns: number; tokensIn: number; tokensOut: number; costUsd: number | null } | undefined) {
  return row ?? { records: 0, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
}

function age(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, now - at);
}

function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

export function createStatusSnapshotCollector(deps: StatusSnapshotCollectorDeps): StatusSnapshotCollector {
  return new StatusSnapshotCollector(deps);
}
