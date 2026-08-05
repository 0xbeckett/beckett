import { expect, test } from "bun:test";
import { CCUSAGE_CACHE_TTL_MS, CcusageSource } from "./ccusage.ts";

const BLOCKS_JSON = JSON.stringify({ blocks: [
  { id: "old", isActive: false, costUSD: 1.11 },
  { id: "current", isActive: true, costUSD: 2.5 },
] });
const DAILY_JSON = JSON.stringify({ daily: [{ period: "2026-08-04", totalCost: 6.75 }] });

function fakeExec(responses: Record<string, { code: number; stdout: string }>) {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    const key = argv.includes("blocks") ? "blocks" : "daily";
    return responses[key] ?? { code: 1, stdout: "" };
  };
  return { exec, calls };
}

test("source runs npx ccusage for the active block and the latest day, and caches the result", async () => {
  const { exec, calls } = fakeExec({
    blocks: { code: 0, stdout: BLOCKS_JSON },
    daily: { code: 0, stdout: DAILY_JSON },
  });
  let now = 0;
  const source = new CcusageSource({ exec, now: () => now });

  const first = await source.collect();
  expect(first).toEqual({ available: true, sessionCostUsd: 2.5, dailyCostUsd: 6.75, observedAt: new Date(0).toISOString() });
  expect(calls).toEqual([
    ["npx", "--yes", "ccusage", "blocks", "--active", "--json"],
    ["npx", "--yes", "ccusage", "daily", "--json", "--last", "1"],
  ]);

  now = CCUSAGE_CACHE_TTL_MS - 1;
  const cached = await source.collect();
  expect(cached).toEqual(first);
  expect(calls).toHaveLength(2);

  now = CCUSAGE_CACHE_TTL_MS + 1;
  await source.collect();
  expect(calls).toHaveLength(4);
});

test("a non-zero exit, unparsable output, or thrown error degrades to unavailable without throwing", async () => {
  const nonZero = new CcusageSource({ exec: async () => ({ code: 1, stdout: "" }), now: () => 0 });
  expect(await nonZero.collect()).toEqual({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null });

  const badJson = new CcusageSource({ exec: async () => ({ code: 0, stdout: "not json" }), now: () => 0 });
  expect(await badJson.collect()).toEqual({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null });

  const throws = new CcusageSource({ exec: async () => { throw new Error("npx not found"); }, now: () => 0 });
  expect(await throws.collect()).toEqual({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null });
});

test("no active block still reports a daily figure", async () => {
  const { exec } = fakeExec({
    blocks: { code: 0, stdout: JSON.stringify({ blocks: [] }) },
    daily: { code: 0, stdout: DAILY_JSON },
  });
  const source = new CcusageSource({ exec, now: () => 0 });
  expect(await source.collect()).toEqual({ available: true, sessionCostUsd: null, dailyCostUsd: 6.75, observedAt: new Date(0).toISOString() });
});
