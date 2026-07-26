/** Durable daemon lifecycle ledger and uptime/downtime snapshot source. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export type LifecycleEventKind = "boot" | "clean_shutdown" | "unclean_restart";

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  /** ISO-8601 timestamp so the JSONL ledger remains inspectable without Beckett. */
  at: string;
}

export interface DowntimeWindow {
  shutdownAt: string;
  bootAt: string;
  durationMs: number;
}

export type DowntimeHistory = "no-history" | "zero" | "recorded";

export interface UptimeSnapshot {
  currentUptimeMs: number | null;
  bootedAt: string | null;
  downtimeHistory: DowntimeHistory;
  /** Human-readable specifically so consumers never mistake no history for no downtime. */
  downtimeMessage: "no downtime history recorded yet" | "zero downtime" | "downtime recorded";
  downtimeWindows: DowntimeWindow[];
  totalDowntimeMs: number | null;
  uncleanRestarts: number;
}

/** The lifecycle ledger belongs directly in the durable Beckett state directory. */
export function uptimeLedgerPath(stateDir: string): string {
  return join(stateDir, "uptime.jsonl");
}

/** O_APPEND + fsync makes an acknowledged lifecycle transition survive a power loss. */
export function appendLifecycleEvent(path: string, event: LifecycleEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("short write appending uptime ledger");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.kind === "boot" || row.kind === "clean_shutdown" || row.kind === "unclean_restart") &&
    typeof row.at === "string" && Number.isFinite(Date.parse(row.at));
}

/** Invalid and crash-truncated JSONL rows are ignored, just like the spend ledger. */
export function readLifecycleLedger(path: string): LifecycleEvent[] {
  let body: string;
  try { body = readFileSync(path, "utf8"); } catch { return []; }
  const events: LifecycleEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isLifecycleEvent(event)) events.push(event);
    } catch { /* interrupted final append */ }
  }
  return events;
}

/**
 * Register a daemon boot. If the prior durable event was another boot, the prior process did not
 * reach its clean shutdown handler, so record that fact instead of fabricating a downtime span.
 */
export function recordBoot(path: string, now = Date.now()): LifecycleEvent[] {
  const prior = readLifecycleLedger(path);
  const last = prior.at(-1);
  const appended: LifecycleEvent[] = [];
  if (last?.kind === "boot") {
    const unclean: LifecycleEvent = { kind: "unclean_restart", at: new Date(now).toISOString() };
    appendLifecycleEvent(path, unclean);
    appended.push(unclean);
  }
  const boot: LifecycleEvent = { kind: "boot", at: new Date(now).toISOString() };
  appendLifecycleEvent(path, boot);
  appended.push(boot);
  return appended;
}

/** Register only a graceful process teardown; crashes leave the preceding boot unmatched. */
export function recordCleanShutdown(path: string, now = Date.now()): LifecycleEvent {
  const event: LifecycleEvent = { kind: "clean_shutdown", at: new Date(now).toISOString() };
  appendLifecycleEvent(path, event);
  return event;
}

/**
 * Pair only adjacent clean-shutdown → boot events. An unclean marker deliberately breaks the
 * pairing, because its elapsed time includes an unknown crash time and is not honest downtime.
 */
export function readUptime(path: string, now = Date.now()): UptimeSnapshot {
  const events = readLifecycleLedger(path);
  const windows: DowntimeWindow[] = [];
  for (let index = 0; index + 1 < events.length; index++) {
    const shutdown = events[index]!;
    const boot = events[index + 1]!;
    if (shutdown.kind !== "clean_shutdown" || boot.kind !== "boot") continue;
    const durationMs = Math.max(0, Date.parse(boot.at) - Date.parse(shutdown.at));
    windows.push({ shutdownAt: shutdown.at, bootAt: boot.at, durationMs });
  }
  const lastBoot = [...events].reverse().find((event) => event.kind === "boot");
  const total = windows.reduce((sum, window) => sum + window.durationMs, 0);
  const downtimeHistory: DowntimeHistory = windows.length === 0 ? "no-history" : total === 0 ? "zero" : "recorded";
  return {
    currentUptimeMs: lastBoot ? Math.max(0, now - Date.parse(lastBoot.at)) : null,
    bootedAt: lastBoot?.at ?? null,
    downtimeHistory,
    downtimeMessage: downtimeHistory === "no-history"
      ? "no downtime history recorded yet"
      : downtimeHistory === "zero" ? "zero downtime" : "downtime recorded",
    downtimeWindows: windows,
    totalDowntimeMs: windows.length ? total : null,
    uncleanRestarts: events.filter((event) => event.kind === "unclean_restart").length,
  };
}

/** Alias with an explicit name for status snapshot callers. */
export const readUptimeSnapshot = readUptime;
