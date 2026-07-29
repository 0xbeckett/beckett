/**
 * Tests for the cast block parse/serialize round-trip (`src/tracker/cast.ts`).
 * The cast block is how per-stage harness assignment + acceptance criteria are stored inside
 * a ticket description — its round-trip integrity is load-bearing for the whole queue.
 */
import { describe, expect, test } from "bun:test";
import {
  branchRef,
  parseCast,
  serializeCast,
  parseCastJson,
  projectSlug,
  targetBranch,
  validateCasting,
  BLOCKED_MODELS,
  OPENAI_CODEX_PROVIDER,
  CAST_FENCE,
  CRITERIA_HEADING,
  TARGET_BRANCH_FENCE,
} from "./cast.ts";
import type { Casting } from "./types.ts";

describe("cast round-trip", () => {
  test("serialize → parse recovers casting, criteria, and body", () => {
    const casting: Casting = {
      implement: { harness: "codex" },
      review: { harness: "claude", model: "claude-opus-5" },
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

  test("task branch refs round-trip without leaking into the worker body", () => {
    const out = serializeCast({}, ["ships"], "implement it", [], "beckett", "#42.2", "design");
    expect(out).toContain("```beckett-branch\n42.2\n```");
    expect(out).toContain("```beckett-start-state\ndesign\n```");
    expect(parseCast(out)).toMatchObject({ branchRef: "42.2", startState: "design", body: "implement it" });
    expect(branchRef("#7.3.1")).toBe("7.3.1");
    expect(branchRef("42")).toBeUndefined();
    expect(branchRef("OPS-7")).toBeUndefined();
  });

  test("non-main target branch round-trips (the OPS-185 publish funnel)", () => {
    const out = serializeCast(
      { implement: { harness: "codex" } },
      ["ships to v5-daemon"],
      "implement it",
      [],
      "beckett",
      undefined,
      undefined,
      "v5-daemon",
    );
    expect(out).toContain("```" + TARGET_BRANCH_FENCE + "\nv5-daemon\n```");
    const parsed = parseCast(out);
    expect(parsed.targetBranch).toBe("v5-daemon");
    expect(parsed.project).toBe("beckett");
    expect(parsed.body.trim()).toBe("implement it"); // the funnel block never leaks into the worker body
  });

  test("no target branch → no block, and parse yields undefined (normal main-targeted ticket)", () => {
    const out = serializeCast({}, [], "just prose");
    expect(out).not.toContain(TARGET_BRANCH_FENCE);
    expect(parseCast(out).targetBranch).toBeUndefined();
  });

  test("target-branch names are validated — unsafe refs are dropped, safe ones kept", () => {
    expect(targetBranch("v5-daemon")).toBe("v5-daemon");
    expect(targetBranch("  release/1.2  ")).toBe("release/1.2");
    expect(targetBranch("main")).toBe("main"); // valid name; the publisher treats it as the default
    expect(targetBranch("")).toBeUndefined();
    expect(targetBranch("bad ref")).toBeUndefined(); // no spaces
    expect(targetBranch("/leading")).toBeUndefined();
    expect(targetBranch("trailing/")).toBeUndefined();
    expect(targetBranch("..")).toBeUndefined();
    expect(targetBranch("a..b")).toBeUndefined();
    expect(targetBranch("$(rm -rf)")).toBeUndefined(); // shell-metachar injection near a git refspec
  });

  test("serialized form contains the fence and the criteria heading", () => {
    const out = serializeCast({ implement: { harness: "codex" } }, ["does the thing"], "body");
    expect(out).toContain("```" + CAST_FENCE);
    expect(out).toContain(CRITERIA_HEADING);
  });

  test("frontend cast (claude/opus implement) round-trips", () => {
    const casting: Casting = {
      implement: { harness: "claude", model: "claude-opus-5", effort: "high" },
      review: { harness: "claude", model: "claude-opus-5" },
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

// #121: a stage may name pi's BACKEND, so a claude model can run inside pi. The field has to
// survive the description round-trip (the tracker is the only store) and the tier blocklist has to
// stop being global — SOL/bare gpt-5.6 are a ChatGPT-account fact, not an anthropic one.
describe("per-stage provider (#121)", () => {
  test("provider round-trips through serialize → parse", () => {
    const casting: Casting = {
      implement: { harness: "pi", provider: "anthropic", model: "claude-opus-5", effort: "high" },
      review: { harness: "pi", provider: "anthropic", model: "claude-fable-5" },
    };
    expect(parseCast(serializeCast(casting, [], "body")).casting).toEqual(casting);
  });

  test("parseCastJson accepts a provider and rejects an empty one", () => {
    expect(parseCastJson('{"implement":{"harness":"pi","provider":"anthropic"}}')).toEqual({
      implement: { harness: "pi", provider: "anthropic" },
    });
    // an empty provider is a malformed block, not a routing decision — degrade to {}
    expect(parseCastJson('{"implement":{"harness":"pi","provider":""}}')).toEqual({});
    expect(parseCastJson('{"implement":{"harness":"pi","provider":7}}')).toEqual({});
  });

  test("validateCasting accepts the anthropic pi cast the new defaults use", () => {
    expect(
      validateCasting({
        implement: { harness: "pi", provider: "anthropic", model: "claude-opus-5" },
        review: { harness: "pi", provider: "anthropic", model: "claude-fable-5", effort: "high" },
      }),
    ).toEqual([]);
  });

  test("the tier blocklist still fires on the openai-codex account", () => {
    for (const model of [...BLOCKED_MODELS, "SOL", "GPT-5.6"]) {
      // no provider ⇒ judged against the default backend, exactly as before #121
      expect(validateCasting({ implement: { harness: "pi", model } })).toHaveLength(1);
      expect(
        validateCasting({ implement: { harness: "pi", provider: OPENAI_CODEX_PROVIDER, model } }),
      ).toHaveLength(1);
    }
  });

  test("the tier blocklist does not reach another provider's catalog", () => {
    for (const model of [...BLOCKED_MODELS]) {
      expect(validateCasting({ implement: { harness: "pi", provider: "anthropic", model } })).toEqual([]);
    }
  });
});

describe("project slug safety", () => {
  test("dot path segments cannot escape the projects root", () => {
    expect(projectSlug(".")).toBe("project");
    expect(projectSlug("..")).toBe("project");
    expect(projectSlug("../")).toBe("project");
    expect(projectSlug("/")).toBe("project");
    expect(projectSlug("!!!")).toBe("project");
    expect(projectSlug("---")).toBe("project");
  });

  test("ordinary dots in project names remain intact", () => {
    expect(projectSlug("Beckett.Web v2")).toBe("beckett.web-v2");
  });
});
