import { expect, test } from "bun:test";
import { CodexDriver, estimateUsd } from "./codex.ts";
import type { Config } from "../types.ts";

const config = {
  harness: {
    codex: {
      default_model: "",
      default_effort: "high",
      sandbox_mode: "workspace-write",
      approval_policy: "never",
      network_default: false,
    },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

test("resume pins the captured codex thread id instead of --last", () => {
  const driver = new CodexDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildResumeArgs(prompt: string): string[];
  };
  driver.sessionId = "thread-123";
  driver.spec = {
    workspace: "/tmp/work",
    envelope: {},
  };

  const args = driver.buildResumeArgs("continue");

  expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-123"]);
  expect(args).not.toContain("--last");
  expect(args.at(-1)).toBe("continue");
});

test("spawn args pass the cast reasoning effort as a quoted codex config override", () => {
  const driver = new CodexDriver(config, quietLog) as unknown as {
    spec: unknown;
    buildSpawnArgs(prompt: string): string[];
  };
  driver.spec = {
    workspace: "/tmp/work",
    envelope: { effort: "low", network: false },
  };

  const args = driver.buildSpawnArgs("do it");

  expect(args).toContain("-c");
  expect(args).toContain('model_reasoning_effort="low"');
});

test("un-cast spawn falls back to config.harness.codex.default_effort", () => {
  const driver = new CodexDriver(config, quietLog) as unknown as {
    spec: unknown;
    buildSpawnArgs(prompt: string): string[];
  };
  driver.spec = { workspace: "/tmp/work", envelope: {} };
  expect(driver.buildSpawnArgs("go")).toContain('model_reasoning_effort="high"');
});

// ── issue #31: static price table (codex's stream has token counts but no $). ──
test("estimateUsd prices gpt-5.5 with cached input billed at the cache rate", () => {
  // cacheRead is a SUBSET of input: 1M input of which 400k cached →
  // 600k @ $1.25/M + 400k @ $0.125/M + 100k out @ $10/M = 0.75 + 0.05 + 1.0
  const usd = estimateUsd("gpt-5.5", {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 400_000,
    cacheCreate: 0,
  });
  expect(usd).toBeCloseTo(1.8, 6);
});

test("estimateUsd is null for unknown or blank models (honest, not invented)", () => {
  const tokens = { input: 1000, output: 100, cacheRead: 0, cacheCreate: 0 };
  expect(estimateUsd("", tokens)).toBeNull();
  expect(estimateUsd("some-future-model", tokens)).toBeNull();
});
