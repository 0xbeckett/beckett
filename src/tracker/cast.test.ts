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
  isPlanStageEligible,
  isPlanExempt,
  taskKeyOf,
  defaultEffortFor,
  PLAN_STAGE_ALLOWLIST,
  CAST_FENCE,
  CRITERIA_HEADING,
  TARGET_BRANCH_FENCE,
} from "./cast.ts";
import type { Casting, Ticket } from "./types.ts";
import { validateConfig } from "../config.ts";

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

describe("plan-stage cast allowlist (issue #128)", () => {
  test("isPlanStageEligible accepts exactly the allowlisted strong-seat pairs", () => {
    expect(isPlanStageEligible({ harness: "claude", model: "claude-opus-5" })).toBe(true);
    expect(isPlanStageEligible({ harness: "claude", model: "claude-fable-5" })).toBe(true);
    // case-insensitive model match, same discipline as BLOCKED_MODELS
    expect(isPlanStageEligible({ harness: "claude", model: "CLAUDE-OPUS-5" })).toBe(true);
    expect(isPlanStageEligible({ harness: "claude", model: "claude-sonnet-5" })).toBe(false);
    expect(isPlanStageEligible({ harness: "claude", model: "claude-haiku-4-5" })).toBe(false);
    expect(isPlanStageEligible({ harness: "pi", model: "gpt-5.6-terra" })).toBe(false);
    expect(isPlanStageEligible({ harness: "claude" })).toBe(false); // no model named
  });

  test("validateCasting refuses a plan cast naming a non-strong-seat model", () => {
    const errors = validateCasting({ plan: { harness: "claude", model: "claude-sonnet-5" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("plan:");
    expect(errors[0]).toContain("strong-seat");
  });

  test("validateCasting refuses a plan cast on a non-claude harness even if the model name matches", () => {
    const errors = validateCasting({ plan: { harness: "pi", model: "gpt-5.6-terra", effort: "high" } });
    expect(errors).toHaveLength(1);
  });

  test("validateCasting accepts a plan cast on either allowlisted seat", () => {
    expect(validateCasting({ plan: { harness: "claude", model: "claude-opus-5", effort: "high" } })).toEqual([]);
    expect(validateCasting({ plan: { harness: "claude", model: "claude-fable-5", effort: "high" } })).toEqual([]);
  });

  test("validateCasting leaves every other stage's rules untouched", () => {
    expect(
      validateCasting({ implement: { harness: "claude", model: "claude-sonnet-5" }, review: { harness: "pi" } }),
    ).toEqual([]);
  });

  test("the allowlist names exactly two seats today", () => {
    expect([...PLAN_STAGE_ALLOWLIST].sort()).toEqual(["claude/claude-fable-5", "claude/claude-opus-5"]);
  });
});

// A REAL validated config (not a partial `as unknown as Config` cast) so `defaultEffortFor`'s
// production-matching defaults (claude xhigh, codex/pi high — `capability/builtins.ts`) are
// exercised exactly as they'd resolve for a live ticket.
const realConfig = validateConfig({ identity: { github_user: "0xbeckett" } });

function baseTicket(over: Partial<Pick<Ticket, "casting" | "branchRef" | "identifier">> = {}): Pick<
  Ticket,
  "casting" | "branchRef" | "identifier"
> {
  return { casting: over.casting ?? {}, identifier: over.identifier ?? "OPS-1", branchRef: over.branchRef };
}

describe("taskKeyOf — amortize per task, not per ticket (issue #128 correction pass)", () => {
  test("a branchRef'd ticket's task key is the leading number, not the branch suffix", () => {
    expect(taskKeyOf(baseTicket({ branchRef: "42.2" }))).toBe("42");
    expect(taskKeyOf(baseTicket({ branchRef: "42.1" }))).toBe("42"); // sibling branch → SAME task key
    expect(taskKeyOf(baseTicket({ branchRef: "7.3.1" }))).toBe("7");
  });

  test("no branchRef (single-ticket task) degrades to the ticket's own identifier", () => {
    expect(taskKeyOf(baseTicket({ identifier: "OPS-9" }))).toBe("OPS-9");
  });
});

describe("isPlanExempt — tiering (issue #128 correction pass)", () => {
  test("claude + high|xhigh implement effort REQUIRES a plan (not exempt)", () => {
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "claude", effort: "high" } } }), realConfig)).toBe(false);
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "claude", effort: "xhigh" } } }), realConfig)).toBe(false);
  });

  test("claude + low|medium implement effort is exempt (unless a fable review overrides it)", () => {
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "claude", effort: "low" } } }), realConfig)).toBe(true);
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "claude", effort: "medium" } } }), realConfig)).toBe(true);
  });

  test("no implement cast at all resolves through the harness default effort (claude defaults to xhigh → required)", () => {
    expect(isPlanExempt(baseTicket(), realConfig)).toBe(false);
  });

  // Regression pin for the correction pass's own measured finding: a literal "effort high|xhigh"
  // rule (its first-draft tiering, rejected) would force a plan onto the ENTIRE terra/luna cheap
  // lane — n=154 gpt-5.6-terra@high runs in the 14-day ledger window averaging $0.95/run — because
  // codex/pi's OWN harness defaults happen to be "high" too. Scoping the effort clause to
  // `harness === "claude"` is what dodges this; this test is the regression pin for that scoping.
  test("codex/pi at high|xhigh effort are STILL exempt — the terra/luna cheap lane is never gated on effort alone", () => {
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "codex", effort: "high" } } }), realConfig)).toBe(true);
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "pi", effort: "high" } } }), realConfig)).toBe(true);
    // Even with no explicit effort — codex/pi's own harness defaults (both "high" in production)
    // must not accidentally make an un-cast codex/pi ticket required.
    expect(isPlanExempt(baseTicket({ casting: { implement: { harness: "codex" } } }), realConfig)).toBe(true);
  });

  test("a claude-fable-5 review REQUIRES a plan regardless of implement's harness/effort", () => {
    const ticket = baseTicket({
      casting: {
        implement: { harness: "codex", effort: "low" },
        review: { harness: "claude", model: "claude-fable-5" },
      },
    });
    expect(isPlanExempt(ticket, realConfig)).toBe(false);
  });

  test("the self-punishing-bypass property: downgrading effort to dodge the plan also downgrades the worker", () => {
    // Same ticket, only the cast effort differs — exemption flips with it, so there is no way to
    // read the requested effort AND still exempt the ticket at the higher effort.
    const hard = baseTicket({ casting: { implement: { harness: "claude", effort: "high" } } });
    const easy = { ...hard, casting: { implement: { harness: "claude" as const, effort: "low" as const } } };
    expect(isPlanExempt(hard, realConfig)).toBe(false);
    expect(isPlanExempt(easy, realConfig)).toBe(true);
  });

  test("a partial/malformed config never throws — degrades toward REQUIRING a plan, the safe direction", () => {
    expect(() => isPlanExempt(baseTicket(), undefined as unknown as import("../types.ts").Config)).not.toThrow();
    expect(isPlanExempt(baseTicket(), undefined as unknown as import("../types.ts").Config)).toBe(false);
  });
});

describe("defaultEffortFor — production defaults survive a partial config (issue #128 hardening)", () => {
  test("matches builtins.ts's zod defaults for a fully-resolved config", () => {
    expect(defaultEffortFor("claude", realConfig)).toBe("xhigh");
    expect(defaultEffortFor("codex", realConfig)).toBe("high");
    expect(defaultEffortFor("pi", realConfig)).toBe("high");
  });

  test("a missing/partial config falls back to the same defaults rather than throwing", () => {
    expect(defaultEffortFor("claude", {} as import("../types.ts").Config)).toBe("xhigh");
    expect(defaultEffortFor("claude", undefined as unknown as import("../types.ts").Config)).toBe("xhigh");
  });
});
