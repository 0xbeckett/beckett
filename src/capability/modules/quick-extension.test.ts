/**
 * V6 Phase 3 — the quick organ on the extension contract (docs/v6-architecture.md §6).
 * Pins the lifecycle re-home (init constructs the ONE runner, stop drains stragglers, health
 * maps stats), the discovery surface (quick.run with router prose), an invoke that dispatches
 * the SAME runner the bus/CLI use — origin-derived identity, channel-override refusal, runner
 * guard throws surfaced as ok:false results, never a process exit — and the asCapability
 * projection into the CLI's pinned spine slot. The CLI/bus surfaces themselves stay pinned by
 * their characterization suites.
 */

import { expect, test } from "bun:test";
import { ActionClass, ExtensionRegistry, type ExtensionContext } from "../../ext/index.ts";
import { asCapability } from "../../ext/index.ts";
import { CapabilityRegistry } from "../index.ts";
import { createQuickExtension, type QuickExtension } from "./quick.ts";
import type { QuickRunner, QuickRunOutcome } from "../../quick/index.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

function ctx(): ExtensionContext {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

/** A stub-spawn runner: records dispatches, replays the runner's own guard throws verbatim. */
function fakeRunner(calls: string[]): QuickRunner {
  return {
    agents: () => [{ name: "quick-code", description: "d" }],
    async run(agent, task, channelId, requesterId = null): Promise<QuickRunOutcome> {
      calls.push(`run:${agent}:${task}:${channelId}:${requesterId}`);
      // The runner's own pinned guard string — invoke must pass it through untouched.
      if (agent === "full") throw new Error("quick lane is full (2/2 running) - retry shortly or file a ticket");
      if (agent === "slow") return { detached: true, runId: "run-slow" };
      return { done: true, state: "done", result: "the report", runId: "run-1" };
    },
    stats: () => ({ running: 1, runs: [] }),
    async stopAll() {
      calls.push("stopAll");
    },
  };
}

function build(): { ext: QuickExtension; calls: string[]; deps: ExtensionContext } {
  const deps = ctx();
  const calls: string[] = [];
  const ext = createQuickExtension({
    onDetachedResult: () => {},
    createRunner: () => fakeRunner(calls),
  })(deps);
  return { ext, calls, deps };
}

/** The derived-by-the-core origin identity (ext.invoke strips caller-supplied ids). */
const ORIGIN = { channelId: "chan", userId: "owner-1" };

// ── lifecycle: init constructs / stop drains / health ────────────────────────────────────

test("init constructs the one runner; the accessor refuses before it runs", async () => {
  const { ext, calls, deps } = build();
  expect(() => ext.runner()).toThrow(/not initialized/);
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  // Constructed but idle: nothing dispatched, nothing stopped.
  expect(calls).toEqual([]);
  expect(ext.runner()).toBeDefined();
});

test("stop drains stragglers through the SAME runner instance (stopAll)", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await registry.stopAll();
  expect(calls).toEqual(["stopAll"]);
});

test("health maps runner stats against the configured lane cap", async () => {
  const { ext, deps } = build();
  expect(ext.lifecycle!.health!()).toMatchObject({ ok: false, detail: "not initialized" });
  await ext.lifecycle!.init!(deps);
  const verdict = await ext.lifecycle!.health!();
  expect(verdict.ok).toBeTrue();
  expect(verdict.detail).toBe(`1/${deps.config.quick.max_concurrent} running`);
});

// ── discovery: the catalog carries router prose ──────────────────────────────────────────

test("advertises quick.run with routing prose, examples, and the FREE posture", () => {
  const { ext } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  const catalog = registry.catalog();
  expect(catalog.map((entry) => entry.capabilityId)).toEqual(["quick.run"]);
  const entry = catalog[0]!;
  expect(entry.description.length).toBeGreaterThan(40);
  expect(entry.examples.length).toBeGreaterThan(0);
  expect(entry.actionClass).toBe(ActionClass.FREE);
});

// ── dispatch: invoke routes to the one runner and never exits ────────────────────────────

test("quick.run validates at the seam and dispatches with the origin-derived identity", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  const invalid = await registry.invoke({ capabilityId: "quick.run", args: {} }, deps);
  expect(invalid.ok).toBeFalse();
  expect(invalid.error).toContain("invalid args");

  // No channel arg → the origin's channel and userId carry the run (defense in depth).
  const done = await registry.invoke(
    { capabilityId: "quick.run", args: { agent: "quick-code", task: "dedupe the wordlist" }, origin: ORIGIN },
    deps,
  );
  expect(done).toEqual({ ok: true, data: { done: true, state: "done", result: "the report", runId: "run-1" } });
  expect(calls).toEqual(["run:quick-code:dedupe the wordlist:chan:owner-1"]);
});

test("invoke returns the detached shape unchanged — the same outcome the bus/CLI see", async () => {
  const { ext, deps } = build();
  await ext.lifecycle!.init!(deps);
  const detached = await ext.invoke!(
    { capabilityId: "quick.run", args: { agent: "slow", task: "t" }, origin: ORIGIN },
    deps,
  );
  expect(detached).toEqual({ ok: true, data: { detached: true, runId: "run-slow" } });
});

test("a channel override may restate the origin channel but never redirect it", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);

  const redirected = await ext.invoke!(
    { capabilityId: "quick.run", args: { agent: "quick-code", task: "t", channelId: "elsewhere" }, origin: ORIGIN },
    deps,
  );
  expect(redirected).toEqual({
    ok: false,
    error: "quick runs must report back to the channel where the request began",
  });
  expect(calls).toEqual([]);

  const restated = await ext.invoke!(
    { capabilityId: "quick.run", args: { agent: "quick-code", task: "t", channelId: "chan" }, origin: ORIGIN },
    deps,
  );
  expect(restated.ok).toBeTrue();
  expect(calls).toEqual(["run:quick-code:t:chan:owner-1"]);
});

test("quick.run is FREE: no origin runs with a null requester, like a token-less bus caller", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);
  const result = await ext.invoke!(
    { capabilityId: "quick.run", args: { agent: "quick-code", task: "t", channelId: "chan-7" } },
    deps,
  );
  expect(result.ok).toBeTrue();
  expect(calls).toEqual(["run:quick-code:t:chan-7:null"]);
});

test("the runner's guard throws come back verbatim as ok:false results — never an exit", async () => {
  const { ext, deps } = build();
  await ext.lifecycle!.init!(deps);
  const full = await ext.invoke!(
    { capabilityId: "quick.run", args: { agent: "full", task: "t" }, origin: ORIGIN },
    deps,
  );
  expect(full).toEqual({
    ok: false,
    error: "quick lane is full (2/2 running) - retry shortly or file a ticket",
  });
});

test("unknown capabilities and pre-init calls refuse with results", async () => {
  const { ext, deps } = build();
  // Pre-init: the accessor throw is adapted to a result, not a process exit.
  const early = await ext.invoke!({ capabilityId: "quick.run", args: { agent: "a", task: "t" } }, deps);
  expect(early.ok).toBeFalse();
  expect(early.error).toContain("not initialized");

  await ext.lifecycle!.init!(deps);
  const unknown = await ext.invoke!({ capabilityId: "quick.nope", args: {} }, deps);
  expect(unknown).toEqual({ ok: false, error: 'quick: unknown capability "quick.nope"' });
});

// ── the Phase 1–4 bridge: the CLI registers the projection ───────────────────────────────

test("asCapability projects the carried v5 facets into the pinned CLI spine slot", () => {
  const { ext } = build();
  const projected = asCapability(ext);
  expect(projected.id).toBe("quick");
  expect(projected.summary).toBe("the NO-TICKET lane: dispatch a short-lived specialist harness");
  expect(projected.cliHelp).toBe("quick <agent>|list");
  expect(projected.skillDoc).toBe(".claude/skills/quick/SKILL.md");
  expect(projected.cliVerbs.map((v) => v.name)).toEqual(["quick"]);
  expect(typeof projected.cliVerbs[0]!.run).toBe("function");
  expect(projected.busCommands).toEqual([]);

  // The projection registers cleanly into the v5 spine (the CLI's exact move).
  const spine = new CapabilityRegistry();
  spine.register(projected);
  expect(spine.resolveCliVerb(["quick", "quick-code", "task"])!.capability.id).toBe("quick");
});
