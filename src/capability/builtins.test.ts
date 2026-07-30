/**
 * Coverage for the builtin config fragments (`src/capability/builtins.ts`) — the V5 Phase 1c
 * contract: the top-level config schema is COMPOSED from per-capability fragments, and the
 * composition validates identically to the retired monolith (the byte-level proof is the
 * `deploy/config.toml.example` drift test + the CLI characterization snapshot of
 * `config print-default`; these tests pin the composition mechanics themselves).
 */

import { expect, test } from "bun:test";
import { builtinCapabilities, builtinCapabilityRegistry, configFragments } from "./builtins.ts";
import { composeConfigSchema, defaultConfig, validateConfig } from "../config.ts";

test("every top-level config key is owned by exactly one builtin capability fragment", () => {
  const fragmentKeys = Object.keys(configFragments);
  // The fully-defaulted config is the ground truth for "what keys exist".
  expect(fragmentKeys.sort()).toEqual(Object.keys(defaultConfig()).sort());
  // …and each mounts through a registered capability (configKey → fragment), none dropped.
  const registered = builtinCapabilityRegistry().configFragments();
  expect([...registered.keys()].sort()).toEqual(fragmentKeys.sort());
});

test("fragment order is registration order — the observable TOML section order", () => {
  const registry = builtinCapabilityRegistry();
  expect([...registry.configFragments().keys()]).toEqual(Object.keys(configFragments));
});

test("builtin capabilities are config-only stubs in Phase 1c (verbs/commands arrive in later phases)", () => {
  for (const capability of builtinCapabilities()) {
    expect(capability.configSchema).toBeDefined();
    expect(capability.cliVerbs).toEqual([]);
    expect(capability.busCommands).toEqual([]);
  }
});

test("the composed schema parses an empty config to the fully-defaulted Config", () => {
  const composed = composeConfigSchema(builtinCapabilityRegistry());
  const parsed = composed.safeParse({});
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data).toEqual(defaultConfig());
});

test("a top-level key no capability claims is still a loud refuse-to-start", () => {
  expect(() => validateConfig({ not_a_capability: {} })).toThrow(/refusing to start/);
});

// issue #128: the concierge chat seat dropped from claude-opus-5 to claude-sonnet-5 @ medium,
// safe ONLY because the Plan stage now guarantees a strong-seat-authored brief ahead of every
// implement worker (see the doc comment on `concierge.model` in builtins.ts). Pin both defaults
// directly so a future edit that quietly reverts one half of that trade — or drops effort back
// to "" / xhigh (banned on Sonnet per user doctrine claude-model-casting) — fails loudly here
// instead of only showing up as an unexplained spend/behavior shift days later.
test("concierge defaults to claude-sonnet-5 at medium effort (issue #128)", () => {
  const config = defaultConfig();
  expect(config.concierge.model).toBe("claude-sonnet-5");
  expect(config.concierge.effort).toBe("medium");
});

test("concierge.model and concierge.effort are real overridable knobs, not hardcodes", () => {
  const config = validateConfig({ concierge: { model: "claude-opus-5", effort: "high" } });
  expect(config.concierge.model).toBe("claude-opus-5");
  expect(config.concierge.effort).toBe("high");
});

// issue #128: `[supervise] max_plan_cycles` is the config key stages.ts's `retryCapsFor` expects
// to wire up (see RetryCaps.planCycles's doc comment there) — pin its default and overridability
// here so that wiring lands against a schema that is already tested, not a bare hope the two
// sides agree on the key name and shape.
test("supervise.max_plan_cycles defaults to 2, mirroring max_design_cycles (issue #128)", () => {
  const config = defaultConfig();
  expect(config.supervise.max_plan_cycles).toBe(2);
  expect(config.supervise.max_plan_cycles).toBe(config.supervise.max_design_cycles);
});

test("supervise.max_plan_cycles is a real overridable knob, not a hardcode", () => {
  const config = validateConfig({ supervise: { max_plan_cycles: 5 } });
  expect(config.supervise.max_plan_cycles).toBe(5);
});
