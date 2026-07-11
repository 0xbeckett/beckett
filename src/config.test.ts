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

test("plane nested board config parses with default board and registered VID boards", () => {
  const config = loadToml(`
[plane]
default_board = "vid"

[plane.boards.vid]
project_slug = "VID"
[plane.boards.vid.state_map]
backlog = "Ideas"
todo = "Scripting"
in_progress = "Production"
in_review = "Review"
done = "Published"
cancelled = "Shelved"
`);
  expect(config.plane.default_board).toBe("vid");
  expect(config.plane.boards.ops!.project_slug).toBe("beckett");
  expect(config.plane.boards.int!.project_slug).toBe("INT");
  expect(config.plane.boards.int!.state_map.design_review).toBe("Review (Design)");
  expect(config.plane.boards.vid!.project_slug).toBe("VID");
  expect(config.plane.boards.vid!.state_map.in_progress).toBe("Production");
  expect(config.plane.boards.vidpip!.project_slug).toBe("VIDPIP");
});

test("legacy flat plane config normalizes into the ops board", () => {
  const config = loadToml(`
[plane]
project_slug = "legacy-ops"

[plane.state_map]
in_progress = "Doing"
`);
  expect(config.plane.default_board).toBe("ops");
  expect(config.plane.boards.ops!.project_slug).toBe("legacy-ops");
  expect(config.plane.boards.ops!.state_map.in_progress).toBe("Doing");
  expect(config.plane.boards.int!.project_slug).toBe("INT");
  expect(config.plane.boards.vid!.project_slug).toBe("VID");
  expect(config.plane).not.toHaveProperty("project_slug");
});

test("unknown default Plane board is a loud config error listing valid boards", () => {
  expect(() => loadToml(`[plane]\ndefault_board = "missing"\n`)).toThrow(/unknown default_board "missing" \(have: ops, int, vid, vidpip\)/);
});

test("github activity relay defaults route to the configured dev feed", () => {
  expect(validateConfig({}).github.activity).toMatchObject({
    enabled: true,
    repo: "0xbeckett/beckett",
    branch: "main",
    poll_secs: 60,
    channel_id: "1520658476974735490",
  });
});

test("proactivity defaults ship disabled and off", () => {
  const config = validateConfig({});
  expect(config.proactivity).toMatchObject({
    enabled: false,
    default_mode: "off",
    triage_provider: "claude",
    triage_model: "claude-haiku-4-5",
    triage_threshold: 0.45,
    burst_quiet_secs: 20,
    engaged_quiet_secs: 4,
    channel_cooldown_secs: 60,
    max_interjections_per_hour: 0,
    engaged_window_secs: 180,
    offer_ttl_secs: 600,
    transcript_window: 15,
    channels: {},
  });
});

test("proactivity classifier model defaults follow the selected provider", () => {
  expect(validateConfig({ proactivity: { triage_provider: "cerebras" } }).proactivity.triage_model).toBe(
    "gemma-4-31b",
  );
  expect(
    validateConfig({ proactivity: { triage_provider: "cerebras", triage_model: "claude-haiku-4-5" } })
      .proactivity.triage_model,
  ).toBe("gemma-4-31b");
  expect(
    validateConfig({ proactivity: { triage_provider: "cerebras", triage_model: "custom-cerebras-model" } })
      .proactivity.triage_model,
  ).toBe("custom-cerebras-model");
});

test("shared_context defaults ship enabled with the OPS-80 bounds", () => {
  const config = validateConfig({});
  expect(config.shared_context).toMatchObject({
    enabled: true,
    max_entries_per_channel: 200,
    max_age_hours: 72,
    inject_budget_tokens: 3000,
    roster_max: 12,
  });
});

test("proactivity runtime override merges over TOML", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-config-test-"));
  try {
    const configFile = join(dir, "config.toml");
    writeFileSync(
      configFile,
      `[proactivity]\nenabled = true\ndefault_mode = "suggest"\n\n[proactivity.channels]\n"chan-a" = "suggest"\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "proactivity.json"),
      JSON.stringify({ enabled: false, channels: { "chan-b": "auto" } }),
      "utf8",
    );
    const config = loadConfig({ env: { BECKETT_DIR: dir }, configFile });
    expect(config.proactivity.enabled).toBe(false);
    expect(config.proactivity.default_mode).toBe("suggest");
    expect(config.proactivity.channels).toEqual({ "chan-a": "suggest", "chan-b": "auto" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
