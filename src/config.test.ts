/**
 * Coverage for config loading & validation (`src/config.ts`) — the refuse-to-start contract.
 * Issue #31: `harness.claude.extra_flags` must not be able to smuggle a duplicate of a
 * driver-owned flag past the exact-token dedup in `ClaudeDriver.buildArgs`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigToml, loadConfig, validateConfig } from "./config.ts";

/** Load a config from a literal TOML body in an isolated temp beckett dir. */
function loadToml(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-config-test-"));
  try {
    const configFile = join(dir, "config.toml");
    writeFileSync(configFile, body, "utf8");
    return loadConfig({ env: { BECKETT_DIR: dir }, configFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("extra_flags naming a driver-owned flag is a loud refuse-to-start", () => {
  expect(() =>
    loadToml(`[harness.claude]\nextra_flags = ["--model", "opus"]\n`),
  ).toThrow(/extra_flags may not override driver-owned flags: --model/);
});

test("benign extra_flags load fine", () => {
  const config = loadToml(`[harness.claude]\nextra_flags = ["--include-hook-events"]\n`);
  expect(config.harness.claude.extra_flags).toEqual(["--include-hook-events"]);
});

test("per-harness default efforts land where they should", () => {
  const config = loadToml(
    `[harness.codex]\ndefault_effort = "low"\n\n[harness.pi]\nthinking = "medium"\n`,
  );
  expect(config.harness.codex.default_effort).toBe("low");
  expect(config.harness.pi.thinking).toBe("medium");
  expect(config.harness.claude.default_effort).toBe("xhigh"); // untouched default
});

describe("default-config example drift (issue #34)", () => {
  test("deploy/config.toml.example matches the live schema's defaults", () => {
    const committed = readFileSync(join(import.meta.dir, "..", "deploy", "config.toml.example"), "utf8");
    expect(committed).toBe(defaultConfigToml());
  });

  test("the generated example round-trips through the strict validator", () => {
    const parsed = Bun.TOML.parse(defaultConfigToml());
    expect(() => validateConfig(parsed)).not.toThrow();
  });
});
