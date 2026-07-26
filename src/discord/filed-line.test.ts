/**
 * Filed-line tests (`src/discord/filed-line.ts`).
 * Pins the three things a caller depends on: nothing filed renders `null` (post NOTHING, not an
 * empty subtext line), singular vs plural wording, and that filing order survives while
 * duplicates and junk do not. The sanitization block is the important half — the line must be
 * structurally incapable of carrying a mention, a backtick, or a newline.
 */

import { describe, expect, test } from "bun:test";
import { formatFiledLine, normalizeFiledRefs } from "./filed-line.ts";

describe("formatFiledLine — nothing to say", () => {
  test("empty list renders nothing at all", () => {
    expect(formatFiledLine([])).toBeNull();
  });

  test("blank and whitespace-only refs render nothing", () => {
    expect(formatFiledLine([""])).toBeNull();
    expect(formatFiledLine(["   "])).toBeNull();
    expect(formatFiledLine(["", "  ", "\t", "\n"])).toBeNull();
    expect(formatFiledLine(["#"])).toBeNull();
    expect(formatFiledLine(["#", " # "])).toBeNull();
  });

  test("a list of only junk renders nothing (never a bare '-# ')", () => {
    expect(formatFiledLine(["abc", "@everyone", "`x`"])).toBeNull();
  });
});

describe("formatFiledLine — wording", () => {
  test("one ref is singular with no colon", () => {
    expect(formatFiledLine(["1"])).toBe("-# filed ticket 1");
    expect(formatFiledLine(["#1"])).toBe("-# filed ticket 1");
    expect(formatFiledLine(["#1.2"])).toBe("-# filed ticket 1.2");
    expect(formatFiledLine(["  #42  "])).toBe("-# filed ticket 42");
  });

  test("many refs are plural, colon-separated, comma-joined", () => {
    expect(formatFiledLine(["1", "2", "3"])).toBe("-# filed tickets: 1, 2, 3");
    expect(formatFiledLine(["#1", "2", "#3.1"])).toBe("-# filed tickets: 1, 2, 3.1");
  });

  test("a duplicate collapsing to one ref falls back to the singular wording", () => {
    expect(formatFiledLine(["7", "#7"])).toBe("-# filed ticket 7");
  });

  test("junk mixed with one good ref renders the singular line", () => {
    expect(formatFiledLine(["nope", "12", ""])).toBe("-# filed ticket 12");
  });
});

describe("formatFiledLine — ordering", () => {
  test("filing order is preserved, never sorted", () => {
    expect(formatFiledLine(["10", "2", "33", "4"])).toBe("-# filed tickets: 10, 2, 33, 4");
    expect(formatFiledLine(["3", "1", "2"])).toBe("-# filed tickets: 3, 1, 2");
  });

  test("dedupe keeps the FIRST sighting's position", () => {
    expect(formatFiledLine(["5", "1", "5", "2"])).toBe("-# filed tickets: 5, 1, 2");
    expect(normalizeFiledRefs(["#9", "1", "9", " 9 "])).toEqual(["9", "1"]);
  });

  test("mixed spellings of the same ref are one ref", () => {
    expect(normalizeFiledRefs(["#3", "3", " #3", "3 "])).toEqual(["3"]);
  });
});

describe("formatFiledLine — sanitization", () => {
  test("only a leading '#' is stripped, not an interior one", () => {
    expect(normalizeFiledRefs(["1#2"])).toEqual([]);
    expect(normalizeFiledRefs(["##1"])).toEqual([]);
  });

  test("non-numeric refs are dropped", () => {
    expect(normalizeFiledRefs(["abc", "1a", "a1", "1-2", "1,2", "1 2", "-1", "+1"])).toEqual([]);
  });

  test("malformed dotted refs are dropped", () => {
    expect(normalizeFiledRefs(["1.", ".1", "1..2", "1.2.", "."])).toEqual([]);
  });

  test("a ref carrying a mention can never reach the line", () => {
    for (const evil of ["@everyone", "@here", "<@1234>", "1 <@&999>", "<#555>"]) {
      expect(formatFiledLine([evil])).toBeNull();
    }
  });

  test("a ref carrying a backtick or newline can never reach the line", () => {
    for (const evil of ["`1`", "1`", "1\n2", "1\n-# filed ticket 999", "1\r\n2", "1 2"]) {
      expect(formatFiledLine([evil])).toBeNull();
    }
    // Surrounding whitespace on an otherwise-valid ref is trimmed, not rejected.
    expect(formatFiledLine([" 1\n"])).toBe("-# filed ticket 1");
  });

  test("no rendered line ever contains a mention, backtick, or newline", () => {
    const line = formatFiledLine(["#1", "@everyone", "`2`", "3\n4", "5.6", "<@7>", "8"]);
    expect(line).toBe("-# filed tickets: 1, 5.6, 8");
    expect(line).not.toContain("@");
    expect(line).not.toContain("`");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("<");
  });

  test("deep dotted refs are legal", () => {
    expect(formatFiledLine(["1.2.3.4.5"])).toBe("-# filed ticket 1.2.3.4.5");
  });

  test("the input array is never mutated", () => {
    const refs = ["#2", "2", "junk", "1"];
    formatFiledLine(refs);
    expect(refs).toEqual(["#2", "2", "junk", "1"]);
  });
});
