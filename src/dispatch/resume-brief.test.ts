/**
 * Resume-brief construction tests (`src/dispatch/resume-brief.ts`, OPS-125).
 * The brief a restart-resumed worker is handed must re-anchor it on the four durable facts:
 * ticket, stage, review-diff base SHA, and where its accumulated context lives (transcript + the
 * committed checkpoint trail). Pure function → no mocks.
 */
import { describe, expect, test } from "bun:test";
import type { Ticket } from "../plane/types.ts";
import { buildResumeBrief, steeringBlock } from "./resume-brief.ts";

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt-1",
    identifier: over.identifier ?? "OPS-125",
    title: over.title ?? "Blip-proof workers",
    description: "",
    body: "",
    state: "in_progress",
    assignees: [],
    casting: {},
    criteria: [],
    blockedBy: [],
    projectId: "proj-1",
    url: "http://x",
    updatedAt: "now",
  } as Ticket;
}

describe("buildResumeBrief (OPS-125)", () => {
  test("includes ticket, stage, base SHA, and a context/transcript pointer", () => {
    const brief = buildResumeBrief(ticket(), "review", "abc1234");
    // ticket
    expect(brief).toContain("[OPS-125]");
    expect(brief).toContain("Blip-proof workers");
    // stage
    expect(brief).toContain("mid-**review**");
    expect(brief).toContain("continue the review work");
    // base SHA — surfaced verbatim AND as the diff base
    expect(brief).toContain("abc1234");
    expect(brief).toContain("git diff abc1234..HEAD");
    // accumulated context pointer — the restored transcript + the committed checkpoint trail
    expect(brief.toLowerCase()).toContain("transcript");
    expect(brief).toContain("git log --oneline");
    expect(brief).toContain("checkpoint");
    // RESUMES, not a fresh start
    expect(brief).toContain("RESUMES");
  });

  test("falls back to `git diff HEAD` and omits the base note when no base SHA was captured", () => {
    const brief = buildResumeBrief(ticket(), "implement", "HEAD");
    expect(brief).toContain("git diff HEAD");
    expect(brief).not.toContain("git diff HEAD..HEAD");
    expect(brief).not.toContain("review/diff base");
    expect(brief).toContain("mid-**implement**");
  });

  test("folds buffered steering into the brief so it reaches the resumed worker", () => {
    const brief = buildResumeBrief(ticket(), "implement", "abc1234", [
      "prefer the smaller diff",
      "don't touch the outbox",
    ]);
    expect(brief).toContain("Steering from the user");
    expect(brief).toContain("- prefer the smaller diff");
    expect(brief).toContain("- don't touch the outbox");
  });

  test("no steering → no steering block", () => {
    expect(buildResumeBrief(ticket(), "implement", "abc1234")).not.toContain("Steering from the user");
    expect(steeringBlock(undefined)).toBe("");
    expect(steeringBlock([])).toBe("");
  });
});
