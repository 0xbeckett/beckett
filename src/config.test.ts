/**
 * Coverage for config loading & validation (`src/config.ts`) — the refuse-to-start contract.
 * Issue #31: `harness.claude.extra_flags` must not be able to smuggle a duplicate of a
 * driver-owned flag past the exact-token dedup in `ClaudeDriver.buildArgs`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigToml, loadConfig, validateConfig } from "./config.ts";
import { browserHostSettings } from "./browser/runtime.ts";

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

test("tracker config parses with defaults and a custom board list", () => {
  const config = loadToml(`
[tracker]
default_board = "vid"
boards = ["ops", "vid"]
`);
  expect(config.tracker.default_board).toBe("vid");
  expect(config.tracker.boards).toEqual(["ops", "vid"]);
  expect(config.tracker.poll_secs).toBe(5);
});

test("an empty config yields the stock board set with ops as default", () => {
  const config = loadToml("");
  expect(config.tracker.default_board).toBe("ops");
  expect(config.tracker.boards).toEqual(["ops", "int", "vid", "vidpip"]);
});

test("legacy [plane] section folds into [tracker] — an existing box keeps booting (OPS-191)", () => {
  // The exact shape of a pre-cutover host config: flat [plane] with Plane-only keys.
  const config = loadToml(`
[plane]
project_slug = "ops"
base_url = "https://plane.0xbeckett.me"
workspace_slug = "beckett"
poll_secs = 3

[plane.state_map]
in_progress = "Doing"
`);
  expect(config).not.toHaveProperty("plane");
  expect(config.tracker.poll_secs).toBe(3);
  expect(config.tracker.default_board).toBe("ops");
  expect(config.tracker.boards).toEqual(["ops", "int", "vid", "vidpip"]);
});

test("legacy [plane.boards.<name>] tables collapse to their names", () => {
  const config = loadToml(`
[plane]
default_board = "web"

[plane.boards.web]
project_slug = "WEB"
`);
  expect(config.tracker.default_board).toBe("web");
  expect(config.tracker.boards).toEqual(["ops", "int", "vid", "vidpip", "web"]);
});

test("an explicit [tracker] section wins over a lingering [plane] one", () => {
  const config = loadToml(`
[plane]
poll_secs = 3

[tracker]
poll_secs = 9
`);
  expect(config.tracker.poll_secs).toBe(9);
});

test("unknown default board is a loud config error listing valid boards", () => {
  expect(() => loadToml(`[tracker]\ndefault_board = "missing"\n`)).toThrow(/unknown default_board "missing" \(have: ops, int, vid, vidpip\)/);
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
    triage_threshold: 0.55,
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

test("computer-use defaults to one stable full-Chromium profile and bounded tool output", () => {
  expect(validateConfig({}).quick).toMatchObject({
    browser_profile_dir: "browser/profile",
    browser_headless: true,
    browser_viewport_width: 1440,
    browser_viewport_height: 900,
    browser_eval_timeout_ms: 60_000,
    browser_max_output_chars: 24_000,
    browser_question_wait_secs: 3_600,
  });
  expect(() => validateConfig({ quick: { browser_max_output_chars: 4_095 } })).toThrow();
  expect(() => validateConfig({ quick: { browser_max_output_chars: 1_000_001 } })).toThrow();
});

test("computer-use rejects profiles that expose Beckett state or traverse a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-profile-test-"));
  try {
    for (const profile of [".", "..", dir]) {
      expect(() => browserHostSettings(validateConfig({
        paths: { beckett_dir: dir },
        quick: { browser_profile_dir: profile },
      }))).toThrow("dedicated directory");
    }
    symlinkSync(tmpdir(), join(dir, "browser"));
    expect(() => browserHostSettings(validateConfig({
      paths: { beckett_dir: dir },
      quick: { browser_profile_dir: "browser/profile" },
    }))).toThrow("must not contain symlinks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
