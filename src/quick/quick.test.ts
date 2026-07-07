/**
 * Quick agents — runner behavior against a stub `claude` bin.
 * Covers the return-path contract (sync result / detach / hard timeout), the guard rails
 * (unknown agent, empty task, lane-full, disabled), and the computer-use MCP wiring.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuickRunner, QUICK_AGENTS, findAgent, type QuickRun } from "./index.ts";
import type { Config, Logger } from "../types.ts";

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as unknown as Logger;
})();

/** A stub claude bin: records its argv into cwd/args.txt, then behaves per markers in the task. */
function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
task="$2"
printf '%s\\n' "$@" > "$PWD/args.txt"
case "$task" in *SLEEP1*) sleep 1 ;; *SLEEPLONG*) sleep 30 ;; esac
if [[ "$task" == *FAIL* ]]; then echo "boom" >&2; exit 3; fi
echo "REPORT:$task"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(dir: string, overrides: Partial<Config["quick"]> = {}): Config {
  return {
    paths: {
      beckett_dir: dir,
      db: "beckett.db",
      events_dir: "events",
      logs_dir: "logs",
      memory_dir: "memory",
      socket: "beckett.sock",
      projects: "projects",
    },
    quick: {
      enabled: true,
      model: "test-model",
      effort: "low",
      sync_wait_secs: 2, // generous for sync-path tests: stub spawn + stream collection has real overhead

      hard_timeout_secs: 5,
      max_concurrent: 2,
      browser_mcp_command: ["fake-mcp", "--flag"],
      ...overrides,
    },
    harness: { claude: { bin: writeStubBin(dir), permission_mode: "bypassPermissions", extra_flags: [] } },
  } as unknown as Config;
}

function setup(overrides: Partial<Config["quick"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quick-test-"));
  const detached: QuickRun[] = [];
  const runner = createQuickRunner({
    config: makeConfig(dir, overrides),
    logger: quietLog,
    onDetachedResult: (run) => detached.push(run),
  });
  return { dir, runner, detached };
}

describe("registry", () => {
  test("ships the v1 roster and finds agents by name", () => {
    expect(QUICK_AGENTS.map((a) => a.name)).toEqual(["computer-use", "quick-code", "repo-explorer"]);
    expect(findAgent("quick-code")?.name).toBe("quick-code");
    expect(findAgent("nope")).toBeUndefined();
    const { runner } = setup();
    expect(runner.agents()).toHaveLength(3);
  });
});

describe("run — sync path", () => {
  test("fast run returns the report in the same call", async () => {
    const { runner, detached } = setup();
    const r = await runner.run("quick-code", "say hi", "chan-1");
    if (!("done" in r)) throw new Error("expected sync result");
    expect(r.state).toBe("done");
    expect(r.result).toBe("REPORT:say hi");
    expect(detached).toHaveLength(0);
  });

  test("nonzero exit becomes an error result carrying stderr", async () => {
    const { runner } = setup();
    const r = await runner.run("quick-code", "please FAIL now", null);
    if (!("done" in r)) throw new Error("expected sync result");
    expect(r.state).toBe("error");
    expect(r.result).toContain("code 3");
    expect(r.result).toContain("boom");
  });
});

describe("run — detach + timeout", () => {
  test("run outliving the sync window detaches, then delivers via onDetachedResult", async () => {
    const { runner, detached } = setup({ sync_wait_secs: 0.3 });
    const r = await runner.run("quick-code", "SLEEP1 then report", "chan-9");
    if (!("detached" in r)) throw new Error("expected detach");
    expect(detached).toHaveLength(0); // still running
    await Bun.sleep(1500);
    expect(detached).toHaveLength(1);
    expect(detached[0]!.state).toBe("done");
    expect(detached[0]!.result).toBe("REPORT:SLEEP1 then report");
    expect(detached[0]!.channelId).toBe("chan-9");
  });

  test("hard timeout kills the child and reports timeout", async () => {
    const { runner, detached } = setup({ sync_wait_secs: 0.3, hard_timeout_secs: 0.6 });
    const r = await runner.run("quick-code", "SLEEPLONG forever", "chan-2");
    if (!("detached" in r)) throw new Error("expected detach");
    await Bun.sleep(900);
    expect(detached).toHaveLength(1);
    expect(detached[0]!.state).toBe("timeout");
    expect(detached[0]!.result).toContain("timed out");
  });
});

describe("guard rails", () => {
  test("unknown agent / empty task / disabled all throw with usable messages", async () => {
    const { runner } = setup();
    await expect(runner.run("no-such-agent", "x", null)).rejects.toThrow(/unknown quick agent/);
    await expect(runner.run("quick-code", "   ", null)).rejects.toThrow(/non-empty task/);
    const off = setup({ enabled: false });
    await expect(off.runner.run("quick-code", "x", null)).rejects.toThrow(/disabled/);
  });

  test("lane-full rejection at max_concurrent", async () => {
    const { runner } = setup({ max_concurrent: 1, sync_wait_secs: 0.1 });
    const first = await runner.run("quick-code", "SLEEP1 hold the lane", null);
    expect("detached" in first).toBe(true);
    await expect(runner.run("quick-code", "second", null)).rejects.toThrow(/lane is full/);
    await Bun.sleep(1200); // let the held run finish so the test env has no strays
  });
});

describe("harness args", () => {
  test("plain agent: model/effort/prompt flags, no mcp-config", async () => {
    const { dir, runner } = setup();
    const r = await runner.run("quick-code", "inspect args", null);
    if (!("done" in r)) throw new Error("expected sync result");
    const runDir = join(dir, "quick", r.runId);
    const args = readFileSync(join(runDir, "args.txt"), "utf8");
    expect(args).toContain("test-model");
    expect(args).toContain("--effort");
    expect(args).toContain("--append-system-prompt");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("scratch"); // quick-code prompt mentions its scratch dir
  });

  test("computer-use gets a playwright mcp-config in its run dir", async () => {
    const { dir, runner } = setup();
    const r = await runner.run("computer-use", "inspect args", null);
    if (!("done" in r)) throw new Error("expected sync result");
    const runDir = join(dir, "quick", r.runId);
    expect(readFileSync(join(runDir, "args.txt"), "utf8")).toContain("--mcp-config");
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.playwright.command).toBe("fake-mcp");
    expect(mcp.mcpServers.playwright.args).toEqual(["--flag"]);
    expect(existsSync(join(runDir, "args.txt"))).toBe(true);
  });
});

describe("stats + stopAll", () => {
  test("stats shows live and recent runs; stopAll settles stragglers as errors", async () => {
    const { runner, detached } = setup({ sync_wait_secs: 0.3 });
    await runner.run("quick-code", "SLEEP1 straggler", "chan-3");
    expect(runner.stats().running).toBe(1);
    runner.stopAll();
    expect(runner.stats().running).toBe(0);
    expect(detached).toHaveLength(1);
    expect(detached[0]!.state).toBe("error");
    expect(detached[0]!.result).toContain("shut down");
  });
});
