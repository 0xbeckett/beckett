/**
 * Plan Stage — CONSUMPTION-side integration tests (issue #128).
 * =======================================================================================
 * `plan-artifact.ts` (and `plan-artifact.test.ts`, its unit tests) is pure string formatting: it
 * takes a plan doc's raw text and a sha as plain strings and has no notion of a ticket id or a
 * task key at all — by construction it cannot behave differently depending on how its caller
 * looked the doc up. What THAT purity does not cover is the wiring one level up: `genericTaskPrompt`
 * / `workerSystemAppend` / `reviewStage.buildPrompt` (`dispatch/stages.ts`, STAGE-owned) are the
 * functions that actually thread `planDoc`/`planDocSha` from a `StagePromptArgs`/`StageAppendArgs`
 * into a worker's real turn-1 prompt and persona. This file is CONSUMPTION's read-only regression
 * pin over THAT seam, exercised entirely through already-exported surface
 * (`stageRegistry`/`StageView`, `dispatch/stages.ts:991`) — no edit to `stages.ts` or
 * `stages.test.ts` (STAGE owns both; a change there while another workflow edits them concurrently
 * would collide, see the Plan Stage synthesis's file-set split).
 *
 * Two things pinned here, matching this module's own two failure modes (`plan-artifact.ts`'s
 * header comment):
 *
 *   1. Byte-identical regardless of key. The Plan Stage synthesis's amortization step (STAGE
 *      half, not built here) re-keys `planVerified`/the plan-doc lookup from `ticket.id` to a
 *      shared `taskKey` so sibling branches of one task can reuse a single plan. Whatever key
 *      resolves the lookup, by the time it reaches `buildPrompt`/`buildSystemAppend` it is just a
 *      `planDoc`/`planDocSha` STRING on `StagePromptArgs`/`StageAppendArgs` — those types carry no
 *      key at all (`stages.ts:189-217`). This suite proves that property holds end to end: two
 *      calls that differ only in "how the doc was found" (simulated here by two lookups that
 *      happen to resolve to identical content — a ticket-keyed lookup and a task-keyed lookup for
 *      the same task's plan are supposed to do exactly that) produce byte-identical prompts.
 *   2. Missing-plan degrade holds through the real stage, not just the raw formatter. Every
 *      ticket that predates issue #128 (and any future ticket that reaches implement/review with
 *      no `planVerified` record) must get an unchanged prompt. `plan-artifact.test.ts` pins this
 *      at the formatter level; this file pins it through the actual `implement`/`review` stage
 *      objects a real spawn calls.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import type { Ticket } from "../tracker/types.ts";
import { validateConfig } from "../config.ts";
import { stageRegistry, type StageAppendArgs, type StagePromptArgs } from "./stages.ts";
import { planDocPath } from "./plan-stage.ts";

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

// A real validated config: `workerSystemAppend` composes the capability modules' prompt blocks
// (Phase 4), which need the full config shape, same as `stages.test.ts`'s own fixture.
const config: Config = validateConfig({
  models: { reviewer: "claude-sonnet-5" },
  harness: {
    claude: { default_effort: "xhigh" },
    codex: { default_effort: "high" },
    pi: { thinking: "medium" },
  },
  identity: { github_user: "0xbeckett" },
});

const PLAN_DOC = [
  "## Scope & files",
  "",
  "Touch src/foo.ts only.",
  "",
  "## Approach",
  "",
  "Do it the straightforward way.",
  "",
  "## Open questions",
  "",
  "None.",
].join("\n");

const PLAN_SHA = "deadbeef1234";

describe("plan doc reaches implement's prompt/append identically regardless of lookup key", () => {
  const ticket = makeTicket({ id: "tkt-9", identifier: "OPS-9" });

  // Two "lookups" standing in for a ticket-keyed vs. a task-keyed resolution of the SAME task's
  // plan (the amortization step's whole point: several sibling tickets share one verified plan,
  // however it was found). `StagePromptArgs`/`StageAppendArgs` carry no key — only the resolved
  // strings — so there is nothing for a lookup STYLE to leak into the prompt.
  const viaTicketKeyedLookup: StagePromptArgs = { ticket, planDoc: PLAN_DOC, planDocSha: PLAN_SHA };
  const viaTaskKeyedLookup: StagePromptArgs = { ticket, planDoc: PLAN_DOC, planDocSha: PLAN_SHA };

  test("genericTaskPrompt (implement's buildPrompt) is byte-identical either way", () => {
    const a = stageRegistry.prompt("implement", viaTicketKeyedLookup);
    const b = stageRegistry.prompt("implement", viaTaskKeyedLookup);
    expect(a).toBe(b);
    expect(a).toContain("<plan>");
    expect(a).toContain("plan authored against deadbee");
    expect(a.indexOf("<plan>")).toBeLessThan(a.indexOf("<task>"));
  });

  test("workerSystemAppend (implement's buildSystemAppend) is byte-identical either way", () => {
    const appendArgsA: StageAppendArgs = { ticket, config, planDoc: PLAN_DOC };
    const appendArgsB: StageAppendArgs = { ticket, config, planDoc: PLAN_DOC };
    const a = stageRegistry.systemAppend("implement", appendArgsA);
    const b = stageRegistry.systemAppend("implement", appendArgsB);
    expect(a).toBe(b);
    expect(a).toContain("do not re-derive them from scratch");
  });

  test("review's buildPrompt gets a pointer line, byte-identical either way, never a second inlined copy", () => {
    const a = stageRegistry.prompt("review", viaTicketKeyedLookup);
    const b = stageRegistry.prompt("review", viaTaskKeyedLookup);
    expect(a).toBe(b);
    expect(a).toContain(`A shared-context plan exists at \`${planDocPath(ticket)}\``);
    // The pointer names the path; it must NOT inline the plan doc's own body a second time.
    expect(a).not.toContain("Touch src/foo.ts only.");
  });
});

describe("missing plan degrades to exactly today's prompt through the real stages", () => {
  const ticket = makeTicket({ id: "tkt-10", identifier: "OPS-10" });
  const noPlanPromptArgs: StagePromptArgs = { ticket };
  const withUndefinedPlanArgs: StagePromptArgs = { ticket, planDoc: undefined, planDocSha: undefined };

  test("implement's prompt is identical whether planDoc is simply absent or explicitly undefined", () => {
    const a = stageRegistry.prompt("implement", noPlanPromptArgs);
    const b = stageRegistry.prompt("implement", withUndefinedPlanArgs);
    expect(a).toBe(b);
    expect(a).not.toContain("<plan>");
    expect(a.startsWith("<task>")).toBe(true);
  });

  test("implement's system append carries no plan note and matches the pre-#128 shape", () => {
    const a = stageRegistry.systemAppend("implement", { ticket, config });
    const b = stageRegistry.systemAppend("implement", { ticket, config, planDoc: undefined });
    expect(a).toBe(b);
    expect(a).not.toContain("do not re-derive them from scratch");
  });

  test("review's prompt carries no plan pointer when there is no verified plan on record", () => {
    const a = stageRegistry.prompt("review", noPlanPromptArgs);
    expect(a).not.toContain("A shared-context plan exists at");
  });
});
