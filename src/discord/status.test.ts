import { expect, test } from "bun:test";
import { healthColor, renderStatusDashboardEmbed } from "./status.ts";
import type { StatusDashboardSnapshot } from "../status/types.ts";

export const fixtureSnapshot: StatusDashboardSnapshot = {
  collectedAt: "2026-07-26T12:00:00.000Z",
  pollIntervalMs: 5_000,
  versions: { beckett: "6.5.2", bun: "1.3.14", bored: "1.0.0" },
  uptime: {
    currentUptimeMs: 3_661_000,
    bootedAt: "2026-07-26T10:58:59.000Z",
    downtimeHistory: "no-history",
    downtimeMessage: "no downtime history recorded yet",
    downtimeWindows: [],
    totalDowntimeMs: null,
    uncleanRestarts: 0,
  },
  system: {
    source: "netdata",
    collectedAt: "2026-07-26T12:00:00.000Z",
    cpu: { loadPercent: 14.2 },
    memory: { usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
    disk: { usedBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
    cpuLoad: 14.2,
    memoryUsed: 2 * 1024 ** 3,
    memoryTotal: 8 * 1024 ** 3,
    diskUsed: 50 * 1024 ** 3,
    diskTotal: 100 * 1024 ** 3,
  },
  health: [
    { name: "Tracker poll", reachable: true, lastSuccessAt: 1, lastSuccessAgeMs: 1_000, consecutiveFailures: 0 },
    { name: "Bored API", reachable: true, lastSuccessAt: 1, lastSuccessAgeMs: 15_000, consecutiveFailures: 0, detail: "HTTP 200" },
    { name: "Bored /health", reachable: false, lastSuccessAt: null, lastSuccessAgeMs: null, consecutiveFailures: 1 },
  ],
  harnessUsage: [
    { harness: "claude", last24h: { records: 2, turns: 3, tokensIn: 1200, tokensOut: 300, costUsd: 0.02 }, last7d: { records: 4, turns: 8, tokensIn: 3000, tokensOut: 1000, costUsd: 0.05 } },
  ],
};

test("pure status renderer exposes every dashboard panel from a fixture snapshot", () => {
  const embed = renderStatusDashboardEmbed(fixtureSnapshot);
  expect(embed.title).toBe("Beckett live status");
  expect(embed.fields?.map((field) => field.name)).toEqual([
    "Uptime", "Downtime", "Versions", "CPU load", "RAM", "Disk", "Core API health", "Harness usage",
  ]);
  expect(embed.fields?.[1]?.value).toContain("No downtime recorded since 2026-07-26");
  expect(embed.fields?.[6]?.value).toContain("Tracker poll");
  expect(embed.fields?.[7]?.value).toContain("24h:");
  expect(embed.fields?.[7]?.value).toContain("7d:");
});

test("health yellow has the concrete stale-but-reachable meaning", () => {
  const current = fixtureSnapshot.health[0]!;
  expect(healthColor(current, fixtureSnapshot.pollIntervalMs)).toBe("green");
  expect(healthColor({ ...current, lastSuccessAgeMs: 10_001 }, fixtureSnapshot.pollIntervalMs)).toBe("yellow");
  expect(healthColor({ ...current, reachable: false }, fixtureSnapshot.pollIntervalMs)).toBe("red");
  expect(healthColor({ ...current, consecutiveFailures: 3 }, fixtureSnapshot.pollIntervalMs)).toBe("red");
});
