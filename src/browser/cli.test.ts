/** `beckett browser` invocation building: session/profile injection and overrides. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types.ts";
import { buildBrowserInvocation, resolveAgentBrowserBin } from "./cli.ts";

function makeConfig(dir: string, overrides: Partial<Config["browser"]> = {}): Config {
  return {
    paths: {
      beckett_dir: dir,
      db: "beckett.db",
      events_dir: "events",
      logs_dir: "logs",
      memory_dir: "memory",
      socket: "beckett.sock",
      spend: "spend.jsonl",
      projects: "projects",
    },
    browser: {
      enabled: true,
      session: "beckett",
      bin: "",
      executable_path: "",
      idle_timeout_secs: 1_800,
      max_output_chars: 20_000,
      command_timeout_secs: 120,
      ...overrides,
    },
  } as unknown as Config;
}

describe("buildBrowserInvocation", () => {
  test("injects the default session, per-session profile, and idle timeout via env", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const invocation = buildBrowserInvocation(makeConfig(dir), ["open", "https://example.com"], {});
    expect(invocation.session).toBe("beckett");
    expect(invocation.env.AGENT_BROWSER_SESSION).toBe("beckett");
    expect(invocation.env.AGENT_BROWSER_PROFILE).toBe(join(dir, "browser", "profiles", "beckett"));
    expect(invocation.env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("1800000");
    expect(invocation.env.AGENT_BROWSER_MAX_OUTPUT).toBe("20000");
    expect(invocation.timeoutMs).toBe(120_000);
    expect(existsSync(invocation.profileDir)).toBe(true);
    expect(invocation.cmd.slice(1)).toEqual(["open", "https://example.com"]);
  });

  test("registers the jingle credential-provider plugin unless the caller pre-set a registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const invocation = buildBrowserInvocation(makeConfig(dir), ["plugin", "list"], {});
    const registry = JSON.parse(invocation.env.AGENT_BROWSER_PLUGINS ?? "[]") as Array<{ name: string; command: string; capabilities: string[] }>;
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ name: "jingle", capabilities: ["credential.read"] });
    expect(registry[0]!.command.endsWith("jingle-plugin.ts")).toBe(true);
    const overridden = buildBrowserInvocation(makeConfig(dir), ["plugin", "list"], { AGENT_BROWSER_PLUGINS: "[]" });
    expect(overridden.env.AGENT_BROWSER_PLUGINS).toBe("[]");
  });

  test("an explicit caller AGENT_BROWSER_MAX_OUTPUT wins over the config default", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const invocation = buildBrowserInvocation(makeConfig(dir), ["snapshot"], { AGENT_BROWSER_MAX_OUTPUT: "50000" });
    expect(invocation.env.AGENT_BROWSER_MAX_OUTPUT).toBe("50000");
  });

  test("an explicit --session names the profile; argv passes through untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const argv = ["--session", "ops-42", "snapshot", "-i"];
    const invocation = buildBrowserInvocation(makeConfig(dir), argv, {});
    expect(invocation.session).toBe("ops-42");
    expect(invocation.env.AGENT_BROWSER_PROFILE).toBe(join(dir, "browser", "profiles", "ops-42"));
    expect(invocation.cmd.slice(1)).toEqual(argv);
  });

  test("an explicit --profile suppresses profile-dir creation but env still defers to the flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const invocation = buildBrowserInvocation(makeConfig(dir), ["--profile", "/tmp/elsewhere", "open", "x"], {});
    expect(existsSync(join(dir, "browser", "profiles", "beckett"))).toBe(false);
    expect(invocation.cmd.slice(1)).toEqual(["--profile", "/tmp/elsewhere", "open", "x"]);
  });

  test("a configured executable path is prepended unless the caller overrides it", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    const config = makeConfig(dir, { executable_path: "/opt/chrome/chrome" });
    expect(buildBrowserInvocation(config, ["open", "x"], {}).cmd.slice(1, 3)).toEqual([
      "--executable-path",
      "/opt/chrome/chrome",
    ]);
    const overridden = buildBrowserInvocation(config, ["--executable-path", "/other", "open", "x"], {});
    expect(overridden.cmd.slice(1)).toEqual(["--executable-path", "/other", "open", "x"]);
  });

  test("rejects disabled config, empty argv, and hostile session names", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    expect(() => buildBrowserInvocation(makeConfig(dir, { enabled: false }), ["open", "x"], {})).toThrow(/disabled/);
    expect(() => buildBrowserInvocation(makeConfig(dir), [], {})).toThrow(/usage/);
    expect(() => buildBrowserInvocation(makeConfig(dir), ["--session", "../escape", "open", "x"], {})).toThrow(
      /session name/,
    );
  });

  test("resolves the repo-pinned binary by default and honors an explicit override", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-cli-test-"));
    expect(resolveAgentBrowserBin(makeConfig(dir))).toContain("node_modules");
    expect(resolveAgentBrowserBin(makeConfig(dir, { bin: "/usr/local/bin/agent-browser" }))).toBe(
      "/usr/local/bin/agent-browser",
    );
  });
});
