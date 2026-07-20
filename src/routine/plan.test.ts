/** Routine dispatch-plan building: agent lane, browser lane, and the legacy x-shitpost fold. */

import { expect, test } from "bun:test";
import { buildDispatchPlan, LEGACY_SHITPOST_INPUT } from "./plan.ts";
import type { Routine, RoutineAction } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";

function routine(action: RoutineAction): Routine {
  return {
    id: "r",
    name: "r",
    builtin: true,
    enabled: true,
    action,
    schedule: { cadence: { kind: "daily" }, window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" } },
    state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
    createdAt: "t",
    updatedAt: "t",
  };
}

test("agent action → agent lane carrying the invocation, not composed text", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "agent", agentId: "social-media", input: "compose today's shitpost", credsEntry: "x.com" }),
  );
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe("social-media");
  expect(plan.agentInput).toBe("compose today's shitpost");
  expect(plan.browserTask).toBeNull(); // authored live by the agent, not knowable at plan time
  expect(plan.credsEntry).toBe("x.com");
});

test("browser action → browser lane with the static task known at plan time", () => {
  const plan = buildDispatchPlan(routine({ kind: "browser", task: "go do the thing", credsEntry: "x.com" }));
  expect(plan.lane).toBe("browser");
  expect(plan.browserTask).toBe("go do the thing");
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
});

test("legacy x-shitpost action folds onto the social-media agent lane — one runtime path", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "x-shitpost", account: "@beckposting", credsEntry: "x.com" }),
  );
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe(SOCIAL_MEDIA_AGENT_ID);
  expect(plan.agentInput).toBe(LEGACY_SHITPOST_INPUT);
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBe("x.com");
});

test("a plan never carries a secret value — only the jingle entry NAME", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "agent", agentId: "social-media", input: "x", credsEntry: "x.com" }),
  );
  expect(plan.credsEntry).toBe("x.com");
  expect(JSON.stringify(plan).toLowerCase()).not.toContain("password");
});
