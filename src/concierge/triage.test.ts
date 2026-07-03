import { describe, expect, test } from "bun:test";
import { extractVerdictJson, parseVerdict } from "./triage.ts";

const VERDICT = '{"interject":true,"kind":"feature-wish","confidence":0.85,"reason":"concrete wish"}';

describe("parseVerdict", () => {
  test("parses a bare verdict object on stdout", () => {
    expect(parseVerdict(VERDICT).kind).toBe("feature-wish");
  });

  test("parses a clean verdict inside the claude --output-format json envelope", () => {
    const stdout = JSON.stringify({ type: "result", result: VERDICT });
    expect(parseVerdict(stdout).interject).toBe(true);
  });

  test("parses a fenced verdict inside the envelope (the prod fail-closed bug)", () => {
    const stdout = JSON.stringify({ type: "result", result: "```json\n" + VERDICT + "\n```" });
    const v = parseVerdict(stdout);
    expect(v.interject).toBe(true);
    expect(v.confidence).toBe(0.85);
  });

  test("parses a verdict wrapped in prose inside the envelope", () => {
    const stdout = JSON.stringify({ type: "result", result: `Here is my classification:\n${VERDICT}\nDone.` });
    expect(parseVerdict(stdout).kind).toBe("feature-wish");
  });

  test("still throws (fails closed upstream) on garbage", () => {
    expect(() => parseVerdict(JSON.stringify({ type: "result", result: "no json here" }))).toThrow();
  });
});

describe("extractVerdictJson", () => {
  test("strips ```json fences", () => {
    expect(extractVerdictJson("```json\n" + VERDICT + "\n```")).toBe(VERDICT);
  });

  test("strips bare ``` fences", () => {
    expect(extractVerdictJson("```\n" + VERDICT + "\n```")).toBe(VERDICT);
  });

  test("extracts the object from surrounding prose", () => {
    expect(extractVerdictJson(`sure!\n${VERDICT}\nhope that helps`)).toBe(VERDICT);
  });

  test("passes clean JSON through untouched", () => {
    expect(extractVerdictJson(VERDICT)).toBe(VERDICT);
  });
});
