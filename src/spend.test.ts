import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendSpendRecord, parseSince, readSpendLedger, summarizeSpend } from "./spend.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function row(overrides = {}) {
  return {
    ticketId: "OPS-123", project: "beckett", stage: "implement" as const,
    harness: "pi", model: "gpt-test", effort: "medium", turns: 2, toolCalls: 3,
    tokensIn: 100, tokensOut: 20, costUsd: null, durationMs: 44, outcome: "done" as const,
    reviewTier: "self" as const, ts: "2026-07-10T00:00:00.000Z", ...overrides,
  };
}

test("spend ledger appends JSONL and ignores a crash-truncated tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-spend-")); dirs.push(dir);
  const path = join(dir, "nested", "spend.jsonl");
  appendSpendRecord(path, row());
  appendSpendRecord(path, row({ stage: "review", outcome: "rework", costUsd: 0.25 }));
  appendFileSync(path, '{"ticketId":"interrupted"');
  const rows = readSpendLedger(path);
  expect(rows).toHaveLength(2);
  expect(summarizeSpend(rows)).toMatchObject({
    totals: { records: 2, costUsd: 0.25, unknownCostRecords: 1 },
    byProject: [{ name: "beckett", records: 2 }],
  });
});

test("relative --since windows are parsed", () => {
  expect(parseSince("24h", 100_000_000)).toBe(13_600_000);
  expect(parseSince("nonsense")).toBeNull();
});
