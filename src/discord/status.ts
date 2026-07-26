/** Pure Discord status-dashboard renderer: snapshot in, embed out. */
import type { DiscordEmbed } from "../types.ts";
import type { CoreOperationHealth, StatusDashboardSnapshot } from "../status/types.ts";

const GREEN = 0x2ea043;
const AMBER = 0xd29922;
const RED = 0xda3633;

/** Green means the operation is reachable, has no current failures, and succeeded within two poll intervals. */
export const HEALTH_GREEN_MAX_AGE_POLL_INTERVALS = 2;
/** Yellow means the operation is still reachable, but its last successful observation is older than two poll intervals. */
export const HEALTH_YELLOW_STALE_AFTER_POLL_INTERVALS = HEALTH_GREEN_MAX_AGE_POLL_INTERVALS;
/** Red means the operation is unreachable, has never succeeded, or has failed three consecutive observations. */
export const HEALTH_RED_CONSECUTIVE_FAILURES = 3;

type HealthColor = "green" | "yellow" | "red";

/** Render a fully collected dashboard snapshot without gateway, disk, or network access. */
export function renderStatusDashboardEmbed(snapshot: StatusDashboardSnapshot): DiscordEmbed {
  const health = snapshot.health.map((operation) => ({
    operation,
    color: healthColor(operation, snapshot.pollIntervalMs),
  }));
  return {
    title: "Beckett live status",
    description: "One live dashboard · updated every 60 seconds",
    color: health.some((entry) => entry.color === "red") ? RED : health.some((entry) => entry.color === "yellow") ? AMBER : GREEN,
    fields: [
      { name: "Uptime", value: formatDuration(snapshot.uptime.currentUptimeMs), inline: true },
      { name: "Downtime", value: downtime(snapshot), inline: true },
      { name: "Versions", value: `Beckett ${snapshot.versions.beckett}\nBun ${snapshot.versions.bun}\nBored ${snapshot.versions.bored ?? "unknown"}`, inline: true },
      { name: "CPU load", value: `${snapshot.system.cpuLoad.toFixed(1)}% (${snapshot.system.source})`, inline: true },
      { name: "RAM", value: usage(snapshot.system.memoryUsed, snapshot.system.memoryTotal), inline: true },
      { name: "Disk", value: usage(snapshot.system.diskUsed, snapshot.system.diskTotal), inline: true },
      { name: "Core API health", value: health.map(({ operation, color }) => healthLine(operation, color)).join("\n") || "No operations observed" },
      { name: "Harness usage", value: harnessUsage(snapshot) },
    ],
    footer: { text: "Health: green current · yellow stale but reachable · red unavailable" },
    timestamp: snapshot.collectedAt,
  };
}

/** Deterministic operation classification, exported for direct threshold tests. */
export function healthColor(operation: CoreOperationHealth, pollIntervalMs: number): HealthColor {
  const ageLimit = Math.max(1, pollIntervalMs) * HEALTH_YELLOW_STALE_AFTER_POLL_INTERVALS;
  if (
    operation.reachable !== true ||
    operation.lastSuccessAgeMs === null ||
    operation.consecutiveFailures >= HEALTH_RED_CONSECUTIVE_FAILURES
  ) return "red";
  if (operation.lastSuccessAgeMs > ageLimit) return "yellow";
  return "green";
}

function healthLine(operation: CoreOperationHealth, color: HealthColor): string {
  const icon = color === "green" ? "🟢" : color === "yellow" ? "🟡" : "🔴";
  const age = operation.lastSuccessAgeMs === null ? "never succeeded" : `last success ${formatDuration(operation.lastSuccessAgeMs)} ago`;
  return `${icon} **${operation.name}** — ${age}${operation.detail ? ` (${operation.detail})` : ""}`;
}

function downtime(snapshot: StatusDashboardSnapshot): string {
  if (snapshot.uptime.downtimeHistory === "no-history") {
    return `No downtime recorded since ${snapshot.uptime.bootedAt ? formatDate(snapshot.uptime.bootedAt) : "this daemon started"}`;
  }
  return `${formatDuration(snapshot.uptime.totalDowntimeMs)} recorded`;
}

function harnessUsage(snapshot: StatusDashboardSnapshot): string {
  if (snapshot.harnessUsage.length === 0) return "No harness activity in the last 7d";
  return snapshot.harnessUsage.map((row) => {
    const h24 = `${row.last24h.turns} turns · ${formatTokens(row.last24h.tokensIn + row.last24h.tokensOut)}`;
    const h7 = `${row.last7d.turns} turns · ${formatTokens(row.last7d.tokensIn + row.last7d.tokensOut)}`;
    return `**${row.harness}** — 24h: ${h24}; 7d: ${h7}`;
  }).join("\n").slice(0, 1_000);
}

function usage(used: number, total: number): string {
  const percent = total > 0 ? ` (${((used / total) * 100).toFixed(1)}%)` : "";
  return `${formatBytes(used)} / ${formatBytes(total)}${percent}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "Unknown";
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}
