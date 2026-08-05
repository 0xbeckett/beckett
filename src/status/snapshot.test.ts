import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSpendRecord } from "../spend.ts";
import { recordBoot, uptimeLedgerPath } from "../uptime.ts";
import { createStatusSnapshotCollector } from "./snapshot.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("snapshot collector gathers lifecycle, metrics, polled-operation health, and rolling harness usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-snapshot-"));
  dirs.push(dir);
  const now = 10_000_000;
  const lifecycle = uptimeLedgerPath(dir);
  recordBoot(lifecycle, now - 20_000);
  appendSpendRecord(join(dir, "spend.jsonl"), {
    ticketId: "OPS-1", project: null, stage: "implement", harness: "claude", model: "m", effort: "low",
    turns: 2, toolCalls: 1, tokensIn: 100, tokensOut: 25, costUsd: null, durationMs: 1, outcome: "done", reviewTier: "self",
    ts: new Date(now - 1_000).toISOString(),
  });
  const collector = createStatusSnapshotCollector({
    version: "test", pollIntervalMs: 5_000,
    poller: { stats: () => ({ lastPollAt: now - 1_000, lastPollAgeMs: 1_000, consecutiveFailures: 0 }) },
    tracker: { stats: () => ({ lastHttpStatus: 200, lastOkAt: now - 1_000, lastErrorAt: null, lastError: null }) },
    metrics: { read: async () => ({ source: "proc", collectedAt: new Date(now).toISOString(), cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 }) },
    lifecycleLedgerPath: lifecycle, spendPath: join(dir, "spend.jsonl"), now: () => now,
    fetch: (async () => ({ ok: true, status: 200, json: async () => ({ version: "bored-test" }) } as Response)) as unknown as typeof fetch,
    ccusage: { collect: async () => ({ available: true, sessionCostUsd: 1.5, dailyCostUsd: 4.25, observedAt: new Date(now).toISOString() }) },
  });

  const snapshot = await collector.collect();
  expect(snapshot.ccusage).toEqual({ available: true, sessionCostUsd: 1.5, dailyCostUsd: 4.25, observedAt: new Date(now).toISOString() });
  expect(snapshot.uptime.currentUptimeMs).toBe(20_000);
  expect(snapshot.versions).toMatchObject({ beckett: "test", bored: "bored-test" });
  expect(snapshot.health.map((entry) => [entry.name, entry.reachable])).toEqual([
    ["Tracker poll", true], ["Bored API", true], ["Bored /health", true],
  ]);
  expect(snapshot.harnessUsage).toEqual([{ harness: "claude", last24h: expect.objectContaining({ turns: 2 }), last7d: expect.objectContaining({ turns: 2 }) }]);
});

test("snapshot collector degrades to unavailable ccusage spend instead of throwing when the source fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-snapshot-"));
  dirs.push(dir);
  const now = 10_000_000;
  const lifecycle = uptimeLedgerPath(dir);
  recordBoot(lifecycle, now - 20_000);
  const collector = createStatusSnapshotCollector({
    version: "test", pollIntervalMs: 5_000,
    poller: { stats: () => ({ lastPollAt: null, lastPollAgeMs: null, consecutiveFailures: 0 }) },
    tracker: { stats: () => ({ lastHttpStatus: null, lastOkAt: null, lastErrorAt: null, lastError: null }) },
    metrics: { read: async () => ({ source: "proc", collectedAt: new Date(now).toISOString(), cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 }) },
    lifecycleLedgerPath: lifecycle, spendPath: join(dir, "spend.jsonl"), now: () => now,
    fetch: (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch,
    ccusage: { collect: async () => { throw new Error("npx ccusage failed"); } },
  });

  const snapshot = await collector.collect();
  expect(snapshot.ccusage).toEqual({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null });
});
