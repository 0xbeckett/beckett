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

export function summarizeSpend(rows: SpendRecord[]) {
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
    for (const row of rows) {
      const name = key(row);
      groups.set(name, [...(groups.get(name) ?? []), row]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ name, ...total(items) }));
  };
  return { totals: total(rows), byProject: by((r) => r.project || "(unknown)"), byModel: by((r) => r.model), byStage: by((r) => r.stage) };
}
