/** Durable, append-only per-stage spend ledger. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type SpendOutcome = "done" | "rework" | "failed" | "cancelled";

export interface SpendRecord {
  ticketId: string;
  /** Extra context used by `beckett spend` grouping. */
  project: string | null;
  stage: "implement" | "review";
  harness: string;
  model: string;
  effort: string;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number;
  outcome: SpendOutcome;
  reviewTier: "self" | "fresh";
  ts: string;
}

/**
 * Append one complete JSONL record in one O_APPEND syscall, then fsync it. O_APPEND prevents
 * competing daemon processes from overwriting each other. The leading newline also quarantines a
 * crash-truncated prior row before the next valid row, so a restart cannot poison later records.
 */
export function appendSpendRecord(path: string, record: SpendRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    // One write keeps each small record atomic under O_APPEND. A short write is left as an
    // ignorable tail rather than a second write that could interleave with another writer.
    const bytes = Buffer.from(`\n${JSON.stringify(record)}\n`, "utf8");
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("short write appending spend ledger");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read valid rows only. A crash-truncated final write (or old hand-edited junk) is harmless. */
export function readSpendLedger(path: string): SpendRecord[] {
  let body: string;
  try { body = readFileSync(path, "utf8"); } catch { return []; }
  const rows: SpendRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as SpendRecord;
      if (isSpendRecord(value)) rows.push(value);
    } catch { /* crash-truncated JSONL tail: ignore */ }
  }
  return rows;
}

function isSpendRecord(v: unknown): v is SpendRecord {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  return typeof x.ticketId === "string" && (x.stage === "implement" || x.stage === "review") &&
    typeof x.ts === "string" && typeof x.turns === "number" && typeof x.toolCalls === "number" &&
    typeof x.tokensIn === "number" && typeof x.tokensOut === "number" &&
    (typeof x.costUsd === "number" || x.costUsd === null);
}

export function parseSince(input: string, now = Date.now()): number | null {
  const relative = /^(\d+(?:\.\d+)?)([smhdw])$/i.exec(input.trim());
  if (relative) {
    const units: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };
    return now - Number(relative[1]) * units[relative[2]!.toLowerCase()]!;
  }
  const absolute = Date.parse(input);
  return Number.isNaN(absolute) ? null : absolute;
}

export interface SpendSummaryOptions {
  /** ISO timestamp, epoch milliseconds, or a relative `parseSince` window such as `24h`. */
  since?: string | number;
  /** Injectable clock for rolling-window snapshots. */
  now?: number;
}

function rowsSince(rows: SpendRecord[], since: SpendSummaryOptions["since"], now: number): SpendRecord[] {
  if (since === undefined) return rows;
  const start = typeof since === "number" ? since : parseSince(since, now);
  if (start === null) throw new Error(`invalid spend window: ${since}`);
  return rows.filter((row) => {
    const at = Date.parse(row.ts);
    return Number.isFinite(at) && at >= start;
  });
}

/**
 * Aggregate ledger rows, optionally over a rolling window. Harnesses deliberately come from the
 * ledger itself: a harness rename or addition must show up without a dashboard code change.
 */
export function summarizeSpend(rows: SpendRecord[], options: SpendSummaryOptions = {}) {
  const selected = rowsSince(rows, options.since, options.now ?? Date.now());
  const total = (items: SpendRecord[]) => ({
    records: items.length,
    turns: items.reduce((n, r) => n + r.turns, 0),
    toolCalls: items.reduce((n, r) => n + r.toolCalls, 0),
    tokensIn: items.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: items.reduce((n, r) => n + r.tokensOut, 0),
    costUsd: items.some((r) => r.costUsd !== null) ? items.reduce((n, r) => n + (r.costUsd ?? 0), 0) : null,
    unknownCostRecords: items.filter((r) => r.costUsd === null).length,
  });
  const by = (key: (r: SpendRecord) => string) => {
    const groups = new Map<string, SpendRecord[]>();
    for (const row of selected) {
      const name = key(row);
      groups.set(name, [...(groups.get(name) ?? []), row]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ name, ...total(items) }));
  };
  return {
    totals: total(selected),
    byProject: by((r) => r.project || "(unknown)"),
    byModel: by((r) => r.model),
    byStage: by((r) => r.stage),
    byHarness: by((r) => r.harness),
  };
}

/**
 * Sum one ticket incarnation's accrued cost from the ledger (#77). Rows with unknown (null) cost
 * add 0. `notBefore` scopes a recycled display identifier to its current filing; rows with a
 * malformed timestamp are excluded when that boundary is supplied.
 */
export function spendForTicket(rows: SpendRecord[], ticketId: string, notBefore?: number): number {
  return rows.reduce((n, r) => {
    if (r.ticketId !== ticketId) return n;
    if (notBefore !== undefined) {
      const at = Date.parse(r.ts);
      if (!Number.isFinite(at) || at < notBefore) return n;
    }
    return n + (r.costUsd ?? 0);
  }, 0);
}

/** One task's rollup for the per-task ledger view and the weekly bill (#77). */
export interface TicketSpend {
  ticketId: string;
  project: string | null;
  records: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** null only when EVERY row for the task lacked cost data — a partial-unknown task still sums. */
  costUsd: number | null;
  unknownCostRecords: number;
}

/**
 * Per-ticket rollup, optionally over a rolling window, sorted by cost desc then id (#77). A task
 * whose rows all lack cost data reports `costUsd: null` rather than a misleading $0.
 */
export function summarizeSpendByTicket(rows: SpendRecord[], options: SpendSummaryOptions = {}): TicketSpend[] {
  const selected = rowsSince(rows, options.since, options.now ?? Date.now());
  const groups = new Map<string, SpendRecord[]>();
  for (const row of selected) groups.set(row.ticketId, [...(groups.get(row.ticketId) ?? []), row]);
  const items: TicketSpend[] = [...groups.entries()].map(([ticketId, rs]) => ({
    ticketId,
    project: rs.find((r) => r.project)?.project ?? null,
    records: rs.length,
    turns: rs.reduce((n, r) => n + r.turns, 0),
    tokensIn: rs.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: rs.reduce((n, r) => n + r.tokensOut, 0),
    costUsd: rs.some((r) => r.costUsd !== null) ? rs.reduce((n, r) => n + (r.costUsd ?? 0), 0) : null,
    unknownCostRecords: rs.filter((r) => r.costUsd === null).length,
  }));
  return items.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || a.ticketId.localeCompare(b.ticketId));
}

/** How many tasks the weekly bill enumerates before collapsing the tail into a "+N more" line. */
const WEEKLY_BILL_MAX_ROWS = 20;

/**
 * Render the weekly per-task bill posted to the channel (#77). Pure: the caller supplies the rows
 * (read once from the ledger) and the clock. Reuses the same aggregation the dashboard/CLI use, so
 * a rename or a new harness shows up here with no code change. An empty ledger yields a plain
 * "nothing recorded" line rather than an error — a fresh install has no history to bill.
 */
export function formatWeeklyBill(rows: SpendRecord[], options: { now?: number; since?: string } = {}): string {
  const since = options.since ?? "7d";
  const now = options.now ?? Date.now();
  const byTicket = summarizeSpendByTicket(rows, { since, now });
  const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
  if (byTicket.length === 0) {
    return "🧾 **Weekly bill** — no worker spend recorded in the last 7 days.";
  }
  const totalCost = summarizeSpend(rows, { since, now }).totals.costUsd;
  const shown = byTicket.slice(0, WEEKLY_BILL_MAX_ROWS);
  const lines = shown.map((t) => {
    const label = t.project ? `${t.ticketId} (${t.project})` : t.ticketId;
    const unknown = t.unknownCostRecords > 0 ? ` · ${t.unknownCostRecords} run(s) w/o cost data` : "";
    return `• **${label}** — ${money(t.costUsd)} · ${t.records} run(s)${unknown}`;
  });
  if (byTicket.length > shown.length) {
    lines.push(`• …and ${byTicket.length - shown.length} more task(s)`);
  }
  const header = `🧾 **Weekly bill** — ${money(totalCost)} across ${byTicket.length} task(s) over the last 7 days`;
  return [header, "", ...lines].join("\n");
}

/** Status-card ready rolling summaries. Both boundaries use `parseSince`, not calendar days. */
export function summarizeSpendWindows(rows: SpendRecord[], now = Date.now()) {
  return {
    last24h: summarizeSpend(rows, { since: "24h", now }),
    last7d: summarizeSpend(rows, { since: "7d", now }),
  };
}
