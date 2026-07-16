/**
 * Stage registry tests (`src/dispatch/stages.ts`, OPS-180).
 * The registry is the ONE place a worker stage is defined; these tests pin the contracts the
 * dispatcher and spawn helper rely on — state→stage staffing, per-stage default casts, the
 * unknown-stage fallbacks (generic prompt / worker persona / plain-claude cast), the
 * config-driven retry caps, and the single-source default-effort switch.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import type { Ticket } from "../plane/types.ts";
import { validateConfig } from "../config.ts";
import {
  StageRegistry,
  stageRegistry,
  retryCapsFor,
  defaultEffortFor,
  reviewEffortFor,
  isIntTicket,
} from "./stages.ts";

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: over.id ?? "tkt-1",
    identifier: over.identifier ?? "OPS-1",
    title: over.title ?? "Do a thing",
    description: "",
    body: over.body ?? "the body",
    state: over.state ?? "in_progress",
    assignees: [],
    casting: over.casting ?? {},
    criteria: over.criteria ?? ["it works"],
    blockedBy: [],
    projectId: over.projectId ?? "proj-1",
    url: "http://x",
    updatedAt: "now",
  };
}

// A REAL validated config (not a partial cast): Phase 4's workerSystemAppend builds the
// capability modules to compose their prompt blocks, so the append path needs the full
// config shape (paths defaults included), exactly like production.
const config: Config = validateConfig({
  models: { reviewer: "claude-sonnet-5" },
  harness: {
    claude: { default_effort: "xhigh" },
    codex: { default_effort: "high" },
    pi: { thinking: "medium" },
  },
  identity: { github_user: "0xbeckett" },
});

describe("StageRegistry", () => {
  test("built-ins are registered and map their entry states", () => {
    expect(stageRegistry.names().sort()).toEqual(["design", "design_check", "implement", "review"]);
    expect(stageRegistry.forState("in_progress")?.name).toBe("implement");
    expect(stageRegistry.forState("in_review")?.name).toBe("review");
    expect(stageRegistry.forState("design")?.name).toBe("design");
    // Held/terminal states staff nothing; design_check is spawned by design's finish, not a state.
    for (const state of ["backlog", "todo", "design_review", "done", "cancelled"] as const) {
      expect(stageRegistry.forState(state)).toBeUndefined();
    }
  });

  test("duplicate registration fails loudly", () => {
    const registry = new StageRegistry();
    const def = stageRegistry.get("implement")!;
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/);
  });

  test("design staffing is gated to INT tickets", () => {
    const guard = stageRegistry.get("design")!.entryGuard!;
    expect(guard(makeTicket({ identifier: "INT-3", projectId: "INT" }))).toBe(true);
    expect(guard(makeTicket({ identifier: "OPS-3" }))).toBe(false);
    expect(isIntTicket(makeTicket({ identifier: "OPS-3", projectId: "INT" }))).toBe(true);
  });

  test("stage spawn flags: implement captures the base sha, review preloads the diff", () => {
    expect(stageRegistry.get("implement")?.capturesBaseSha).toBe(true);
    expect(stageRegistry.get("review")?.preloadsDiff).toBe(true);
    expect(stageRegistry.get("design")?.capturesBaseSha).toBeUndefined();
    expect(stageRegistry.get("design")?.preloadsDiff).toBeUndefined();
  });
});

describe("per-stage default casts", () => {
  test("uncast stages get their historical defaults", () => {
    const ticket = makeTicket();
    expect(stageRegistry.resolveCast("implement", undefined, ticket, config)).toEqual({ harness: "claude" });
    expect(stageRegistry.resolveCast("design", undefined, ticket, config)).toEqual({
      harness: "claude",
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(stageRegistry.resolveCast("design_check", undefined, ticket, config)).toEqual({
      harness: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(stageRegistry.resolveCast("review", undefined, ticket, config)).toEqual({
      harness: "claude",
      model: "claude-sonnet-5", // config.models.reviewer
      effort: "high",
    });
  });

  test("review effort scales from the implement cast (issue #27)", () => {
    expect(reviewEffortFor(makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } }))).toBe("medium");
    expect(reviewEffortFor(makeTicket({ casting: { implement: { harness: "claude", effort: "xhigh" } } }))).toBe("xhigh");
    expect(reviewEffortFor(makeTicket())).toBe("high");
    // An explicit review cast that names no effort still gets the scaled default…
    const ticket = makeTicket({ casting: { implement: { harness: "claude", effort: "low" } } });
    expect(
      stageRegistry.resolveCast("review", { harness: "claude", model: "claude-opus-4-8" }, ticket, config),
    ).toEqual({ harness: "claude", model: "claude-opus-4-8", effort: "medium" });
    // …while an explicit effort wins untouched.
    expect(
      stageRegistry.resolveCast("review", { harness: "claude", effort: "xhigh" }, ticket, config),
    ).toEqual({ harness: "claude", effort: "xhigh" });
  });

  test("unknown stages fall back to plain claude", () => {
    expect(stageRegistry.resolveCast("mystery", undefined, makeTicket(), config)).toEqual({ harness: "claude" });
    expect(stageRegistry.resolveCast("mystery", { harness: "pi" }, makeTicket(), config)).toEqual({ harness: "pi" });
  });
});

describe("prompt + system-append fallbacks", () => {
  test("an unknown stage gets the generic task brief and the worker persona", () => {
    const ticket = makeTicket();
    const prompt = stageRegistry.prompt("mystery", { ticket });
    expect(prompt).toContain("<task>\n[OPS-1] Do a thing");
    expect(prompt).toContain("Acceptance criteria:\n- it works");
    const append = stageRegistry.systemAppend("mystery", { ticket, config, env: {} });
    expect(append).toContain("You are an autonomous worker implementing a ticket");
  });

  test("stage-specific briefs and personas resolve through the registry", () => {
    const ticket = makeTicket({ identifier: "INT-9", projectId: "INT" });
    expect(stageRegistry.prompt("design", { ticket })).toContain("docs/design/int-9.md");
    expect(stageRegistry.prompt("design_check", { ticket })).toContain("Sanity-check the INT design document");
    expect(stageRegistry.prompt("review", { ticket, reviewDiff: "diff --git a/x b/x\n+1" })).toContain("```diff");
    expect(stageRegistry.systemAppend("review", { ticket, config, env: {} })).toContain("autonomous REVIEWER");
    expect(stageRegistry.systemAppend("design", { ticket, config, env: {} })).toContain("This is a DESIGN stage");
    expect(stageRegistry.systemAppend("design_check", { ticket, config, env: {} })).toContain(
      "design-document completeness checker",
    );
  });
});

describe("worker persona composition (Phase 4)", () => {
  // The worker system append is COMPOSED from the capability modules' registered prompt
  // blocks (github guidance at priority 10, the deploy recipe at 30) with the design stage's
  // extra line interleaving at 20. These snapshots pin the composed output byte-for-byte —
  // it was proven identical to the pre-V5 concatenation when Phase 4 landed, and any future
  // drift in a block, its gating, or the ordering shows up here as a snapshot diff.
  test("implement persona: github guidance always, deploy recipe only when the ticket mentions deploy", () => {
    const plain = stageRegistry.systemAppend("implement", { ticket: makeTicket(), config, env: {} });
    expect(plain).toContain("GITHUB: don't push anything yourself.");
    expect(plain).not.toContain("DEPLOY DURABLY");
    expect(plain).toMatchSnapshot();

    const deploy = stageRegistry.systemAppend("implement", {
      ticket: makeTicket({ title: "Build a public dashboard site" }),
      config,
      env: {},
    });
    expect(deploy).toContain("DEPLOY DURABLY");
    expect(deploy).toMatchSnapshot();
  });

  test("design persona: the design-only line rides between the github guidance and the deploy recipe", () => {
    const append = stageRegistry.systemAppend("design", {
      ticket: makeTicket({ title: "Design the public dashboard site" }),
      config,
      env: {},
    });
    const guidance = append.indexOf("GITHUB:");
    const designLine = append.indexOf("This is a DESIGN stage");
    const recipe = append.indexOf("DEPLOY DURABLY");
    expect(guidance).toBeGreaterThan(-1);
    expect(designLine).toBeGreaterThan(guidance);
    expect(recipe).toBeGreaterThan(designLine);
    expect(append).toMatchSnapshot();
  });

  test("the composed guidance names the configured github owner", () => {
    const owned = validateConfig({ identity: { github_user: "someone-else" } });
    const append = stageRegistry.systemAppend("implement", { ticket: makeTicket(), config: owned, env: {} });
    expect(append).toContain("someone-else/ops-1");
  });
});

describe("config-driven retry caps (OPS-180)", () => {
  test("defaults equal the retired hardcoded constants", () => {
    expect(retryCapsFor({} as Config)).toEqual({
      reworkCycles: 3,
      designCycles: 2,
      implementRetries: 3,
      reviewInfraRetries: 1,
    });
  });

  test("[supervise] max_* keys drive the caps", () => {
    const caps = retryCapsFor({
      supervise: {
        max_rework_cycles: 5,
        max_design_cycles: 1,
        max_implement_retries: 7,
        max_review_infra_retries: 2,
      },
    } as unknown as Config);
    expect(caps).toEqual({ reworkCycles: 5, designCycles: 1, implementRetries: 7, reviewInfraRetries: 2 });
  });
});

describe("defaultEffortFor — the one source of truth", () => {
  test("resolves each harness's configured default", () => {
    expect(defaultEffortFor("claude", config)).toBe("xhigh");
    expect(defaultEffortFor("codex", config)).toBe("high");
    expect(defaultEffortFor("pi", config)).toBe("medium");
  });
});
