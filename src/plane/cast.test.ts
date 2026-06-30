/**
 * Tests for the cast block parse/serialize round-trip (`src/plane/cast.ts`).
 * The cast block is how per-stage harness assignment + acceptance criteria are stored inside
 * a Plane issue description — its round-trip integrity is load-bearing for the whole queue.
 */
import { describe, expect, test } from "bun:test";
import { parseCast, serializeCast, parseCastJson, CAST_FENCE, CRITERIA_HEADING } from "./cast.ts";
import type { Casting } from "./types.ts";

describe("cast round-trip", () => {
  test("serialize → parse recovers casting, criteria, and body", () => {
    const casting: Casting = {
      implement: { harness: "codex" },
      review: { harness: "claude", model: "claude-opus-4-8" },
    };
    const criteria = ["endpoint returns 200", "covered by a test"];
    const body = "Wire the /health endpoint.";

    const serialized = serializeCast(casting, criteria, body);
    const parsed = parseCast(serialized);

    expect(parsed.casting).toEqual(casting);
    expect(parsed.criteria).toEqual(criteria);
    expect(parsed.body.trim()).toBe(body);
  });

  test("serialize → parse round-trips blocked-by deps (the plan DAG edge)", () => {
    const blockedBy = ["OPS-41", "OPS-42"];
    const serialized = serializeCast({ implement: { harness: "codex" } }, ["it works"], "the prose", blockedBy);
    const parsed = parseCast(serialized);

    expect(parsed.blockedBy).toEqual(blockedBy);
    expect(parsed.casting).toEqual({ implement: { harness: "codex" } });
    expect(parsed.criteria).toEqual(["it works"]);
    expect(parsed.body.trim()).toBe("the prose");
  });

  test("no deps → no deps block, and parse yields an empty blockedBy", () => {
    const out = serializeCast({}, [], "just prose");
    expect(out).not.toContain("beckett-deps");
    expect(parseCast(out).blockedBy).toEqual([]);
  });

  test("serialize → parse round-trips the code project (slugified)", () => {
    const out = serializeCast({ implement: { harness: "claude" } }, ["it works"], "build it", [], "Balloons Game!");
    const parsed = parseCast(out);
    expect(out).toContain("beckett-project");
    expect(parsed.project).toBe("balloons-game"); // sanitized to a fs/GitHub-safe slug
    expect(parsed.body.trim()).toBe("build it");
    expect(parsed.casting).toEqual({ implement: { harness: "claude" } });
  });

  test("no project → no project block, and parse yields undefined", () => {
    const out = serializeCast({}, [], "just prose");
    expect(out).not.toContain("beckett-project");
    expect(parseCast(out).project).toBeUndefined();
  });

  test("serialized form contains the fence and the criteria heading", () => {
    const out = serializeCast({ implement: { harness: "codex" } }, ["does the thing"], "body");
    expect(out).toContain("```" + CAST_FENCE);
    expect(out).toContain(CRITERIA_HEADING);
  });

  test("frontend cast (claude/opus implement) round-trips", () => {
    const casting: Casting = {
      implement: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
      review: { harness: "claude", model: "claude-opus-4-8" },
    };
    const parsed = parseCast(serializeCast(casting, ["pixels are right"], "Build the settings panel."));
    expect(parsed.casting).toEqual(casting);
  });
});

describe("cast degradation (never throws on bad input)", () => {
  test("description with no cast block → empty casting, body preserved", () => {
    const parsed = parseCast("just some prose, no fence here");
    expect(parsed.casting).toEqual({});
    expect(parsed.body).toContain("just some prose");
  });

  test("malformed cast JSON → empty casting, does not throw", () => {
    const desc = "```" + CAST_FENCE + "\n{ not valid json ,, }\n```\n\nbody text";
    let parsed!: ReturnType<typeof parseCast>;
    expect(() => (parsed = parseCast(desc))).not.toThrow();
    expect(parsed.casting).toEqual({});
  });

  test("parseCastJson rejects non-harness shapes", () => {
    expect(parseCastJson("{}")).toEqual({});
    // a stage whose value isn't a valid HarnessSpec is dropped, not crashed on
    expect(() => parseCastJson('{"implement": 42}')).not.toThrow();
  });

  test("empty casting serializes without a fence", () => {
    const out = serializeCast({}, ["only criteria"], "body");
    expect(out).not.toContain(CAST_FENCE);
    expect(out).toContain(CRITERIA_HEADING);
  });
});
