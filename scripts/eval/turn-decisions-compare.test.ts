import { describe, expect, test } from "bun:test";
import { formatComparisonTable, parseModelsArg } from "./turn-decisions-compare.ts";
import type { FixtureResult, TurnEvalSummary, TurnFixture } from "../../src/eval/turn-decisions.ts";

function fixture(id: string, family: TurnFixture["family"] = "pass-vs-speak"): TurnFixture {
  return {
    id,
    family,
    title: id,
    channel: "chan",
    speaker: { name: "someone", role: "member" },
    addressedToBeckett: true,
    message: `msg for ${id}`,
    expect: { decision: "send", actions: ["answer_inline"] },
    rationale: "test fixture",
  };
}

function result(f: TurnFixture, ok: boolean, parseFailed = false): FixtureResult {
  return {
    fixture: f,
    runs: [],
    ok,
    decisionOk: ok,
    actionOk: ok,
    parseFailed,
    elapsedMs: 1,
  };
}

function summary(model: string, results: FixtureResult[]): TurnEvalSummary {
  const passed = results.filter((r) => r.ok).length;
  const byFamily: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const fam = (byFamily[r.fixture.family] ??= { total: 0, passed: 0 });
    fam.total += 1;
    if (r.ok) fam.passed += 1;
  }
  return {
    model,
    total: results.length,
    passed,
    failed: results.length - passed,
    parseFailures: results.filter((r) => r.parseFailed).length,
    byFamily,
    results,
    gatePassed: passed === results.length,
    allowedFailures: 0,
  };
}

describe("parseModelsArg", () => {
  test("splits, trims, and dedupes a comma-separated list", () => {
    expect(parseModelsArg("a/model, b/model ,a/model")).toEqual(["a/model", "b/model"]);
  });

  test("throws when no --models flag was given (no baked-in default)", () => {
    expect(() => parseModelsArg(undefined)).toThrow(/--models is required/);
  });

  test("throws on an empty or whitespace-only value", () => {
    expect(() => parseModelsArg("  ,  ,")).toThrow(/--models is required/);
  });
});

describe("formatComparisonTable", () => {
  const fA = fixture("owner-1", "owner-gating");
  const fB = fixture("denial-1", "denial-diagnosis");

  test("renders a per-fixture-id row and a totals row per model", () => {
    const opus = summary("opus-slug", [result(fA, true), result(fB, true)]);
    const sonnet = summary("sonnet-slug", [result(fA, true), result(fB, false)]);
    const table = formatComparisonTable([opus, sonnet]);

    expect(table).toContain("opus-slug");
    expect(table).toContain("sonnet-slug");
    expect(table).toContain("owner-1");
    expect(table).toContain("denial-1");
    expect(table).toContain("TOTAL");
    expect(table).toContain("2/2"); // opus totals
    expect(table).toContain("1/2"); // sonnet totals
  });

  test("marks a passing fixture PASS and a failing one FAIL, per model column", () => {
    const opus = summary("opus-slug", [result(fA, true)]);
    const sonnet = summary("sonnet-slug", [result(fA, false)]);
    const table = formatComparisonTable([opus, sonnet]);
    const row = table.split("\n").find((line) => line.startsWith("owner-1"));
    expect(row).toBeDefined();
    expect(row).toContain("PASS");
    expect(row).toContain("FAIL");
  });

  test("marks an unparseable output ERR, distinct from FAIL", () => {
    const opus = summary("opus-slug", [result(fA, false, true)]);
    const table = formatComparisonTable([opus]);
    const row = table.split("\n").find((line) => line.startsWith("owner-1"));
    expect(row).toContain("ERR");
  });

  test("includes a per-model, per-family breakdown line", () => {
    const opus = summary("opus-slug", [result(fA, true), result(fB, true)]);
    const table = formatComparisonTable([opus]);
    expect(table).toContain("By family:");
    expect(table).toContain("owner-gating: opus-slug=1/1");
    expect(table).toContain("denial-diagnosis: opus-slug=1/1");
  });

  test("returns a placeholder for an empty summaries array (no network call needed to hit this)", () => {
    expect(formatComparisonTable([])).toBe("(no models given)");
  });
});
