/**
 * Plan artifact formatting tests (`src/dispatch/plan-artifact.ts`).
 * Pure functions, no mocks: these pin the two guarantees the module exists for (see its header
 * comment) — the ceiling/drop-order defense against a runaway doc, and the byte-identical
 * "no plan → no change" degrade for every ticket that predates (or otherwise lacks) one.
 */
import { describe, expect, test } from "bun:test";
import {
  PLAN_SECTIONS,
  PLAN_TOKEN_CEILING,
  planContextBlock,
  planNoRederiveNote,
  planReviewPointer,
  planWithinCeiling,
} from "./plan-artifact.ts";

const CEILING_CHARS = PLAN_TOKEN_CEILING * 4;

describe("planWithinCeiling", () => {
  test("fits at and just under the char budget", () => {
    expect(planWithinCeiling("x".repeat(CEILING_CHARS))).toBe(true);
    expect(planWithinCeiling("x".repeat(CEILING_CHARS - 1))).toBe(true);
  });

  test("fails just over the char budget", () => {
    expect(planWithinCeiling("x".repeat(CEILING_CHARS + 1))).toBe(false);
  });
});

describe("planContextBlock — missing plan degrades to exactly today's behavior", () => {
  test("undefined doc returns empty string", () => {
    expect(planContextBlock(undefined, "abc1234")).toBe("");
  });

  test("empty/whitespace-only doc returns empty string", () => {
    expect(planContextBlock("", "abc1234")).toBe("");
    expect(planContextBlock("   \n\t  ", "abc1234")).toBe("");
  });
});

describe("planContextBlock — a doc that fits", () => {
  const doc = [
    "## Scope & files",
    "",
    "Touch src/foo.ts and src/bar.ts only.",
    "",
    "## Approach",
    "",
    "Do the thing the straightforward way.",
    "",
    "## Open questions",
    "",
    "None.",
  ].join("\n");

  test("wraps in <plan>, carries the sha freshness marker, preserves doc order", () => {
    const block = planContextBlock(doc, "deadbeef1234");
    expect(block.startsWith("<plan>\n")).toBe(true);
    expect(block).toContain("plan authored against deadbee; if HEAD has moved further, re-verify affected sections.");
    expect(block).toContain("## Scope & files");
    expect(block).toContain("Touch src/foo.ts and src/bar.ts only.");
    expect(block.indexOf("Scope & files")).toBeLessThan(block.indexOf("Approach"));
    expect(block.indexOf("Approach")).toBeLessThan(block.indexOf("Open questions"));
    expect(block.endsWith("</plan>\n\n")).toBe(true);
  });

  test("no sha falls back to an 'unspecified revision' header instead of a broken template", () => {
    const block = planContextBlock(doc, undefined);
    expect(block).toContain("plan authored at an unspecified revision; re-verify affected sections if this looks stale.");
  });

  test("a doc with no recognizable headings still renders (fallback preamble), never throws", () => {
    const block = planContextBlock("just some plain prose, no headings at all.", "abc1234");
    expect(block).toContain("just some plain prose, no headings at all.");
    expect(block).toContain("<plan>");
  });
});

describe("planContextBlock — over-ceiling drop order", () => {
  const pad = (marker: string, n: number) => `${marker} ${"x".repeat(n)}`;

  test("drops 'Open questions' first when that alone brings the doc back under budget", () => {
    const doc = [
      "## Scope & files",
      "",
      pad("SCOPE_MARKER", 200),
      "",
      "## Approach",
      "",
      pad("APPROACH_MARKER", 200),
      "",
      "## Conventions & traps",
      "",
      pad("CONVENTIONS_MARKER", 200),
      "",
      "## Open questions",
      "",
      pad("OPEN_Q_MARKER", 3000), // large enough alone to push the doc over the ceiling
    ].join("\n");

    const block = planContextBlock(doc, "abc1234");
    expect(block).not.toContain("Open questions");
    expect(block).not.toContain("OPEN_Q_MARKER");
    // Everything else survives untouched — only the one droppable section was cut.
    expect(block).toContain("SCOPE_MARKER");
    expect(block).toContain("APPROACH_MARKER");
    expect(block).toContain("CONVENTIONS_MARKER");
    // Bounded: header + tags are the only allowed excess over the ceiling once the one
    // oversized droppable section is gone.
    expect(block.length).toBeLessThan(CEILING_CHARS + 400);
  });

  test("drops 'Conventions & traps' second when dropping only 'Open questions' isn't enough", () => {
    const doc = [
      "## Scope & files",
      "",
      pad("SCOPE_MARKER", 200),
      "",
      "## Approach",
      "",
      pad("APPROACH_MARKER", 200),
      "",
      "## Conventions & traps",
      "",
      // Large enough that dropping ONLY "Open questions" still leaves the doc over budget —
      // this is the case that requires the second drop step to actually fire.
      pad("CONVENTIONS_MARKER", 3000),
      "",
      "## Open questions",
      "",
      pad("OPEN_Q_MARKER", 2000),
    ].join("\n");

    const block = planContextBlock(doc, "abc1234");
    expect(block).not.toContain("Open questions");
    expect(block).not.toContain("Conventions & traps");
    expect(block).not.toContain("OPEN_Q_MARKER");
    expect(block).not.toContain("CONVENTIONS_MARKER");
    expect(block).toContain("SCOPE_MARKER");
    expect(block).toContain("APPROACH_MARKER");
  });

  test("never drops 'Scope & files' or 'Approach', and never overruns even when the rest can't fit", () => {
    const doc = [
      "## Scope & files",
      "",
      pad("SCOPE_MARKER", 200),
      "",
      "## Approach",
      "",
      pad("APPROACH_MARKER", 200),
      "",
      "## Conventions & traps",
      "",
      pad("CONVENTIONS_MARKER", 2000),
      "",
      "## Acceptance mapping",
      "",
      pad("ACCEPTANCE_MARKER", 3500), // alone, plus Scope+Approach, still exceeds the ceiling
      "",
      "## Verification commands",
      "",
      pad("VERIFY_MARKER", 100),
      "",
      "## Open questions",
      "",
      pad("OPEN_Q_MARKER", 2000),
    ].join("\n");

    const block = planContextBlock(doc, "abc1234");
    // The two protected sections survive in full even though the doc as a whole had to be cut.
    expect(block).toContain(pad("SCOPE_MARKER", 200));
    expect(block).toContain(pad("APPROACH_MARKER", 200));
    // Both droppable sections are gone.
    expect(block).not.toContain("OPEN_Q_MARKER");
    expect(block).not.toContain("CONVENTIONS_MARKER");
    // A truncation note is left so a reader knows content was cut, not silently missing.
    expect(block).toContain("truncated");
    // Bounded: well under the size of the untruncated doc, and within a small, fixed overhead
    // of the ceiling (header + tags + truncation note are the only allowed excess).
    expect(block.length).toBeLessThan(doc.length);
    expect(block.length).toBeLessThan(CEILING_CHARS + 400);
  });

  test("PLAN_SECTIONS names the 6 canonical sections in authoring order", () => {
    expect(PLAN_SECTIONS).toEqual([
      "Scope & files",
      "Approach",
      "Conventions & traps",
      "Acceptance mapping",
      "Verification commands",
      "Open questions",
    ]);
  });
});

describe("planNoRederiveNote", () => {
  test("fixed text: licenses investigating Open Questions or a plan discovered to be wrong", () => {
    const note = planNoRederiveNote();
    expect(note).toContain("do not re-derive them from scratch");
    expect(note).toContain("Open Questions");
    expect(note).toContain("anything you discover is actually wrong");
  });
});

describe("planReviewPointer", () => {
  test("fixed text: pointer only, names the path, does not inline the doc", () => {
    const line = planReviewPointer("docs/plan/ops-42.md");
    expect(line).toBe(
      "A shared-context plan exists at `docs/plan/ops-42.md` (read it if you need the intended " +
        "approach; the diff above is what actually shipped).",
    );
  });
});
