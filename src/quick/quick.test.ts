/** Quick-runner lifecycle: the fire-and-report no-ticket lane. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Logger } from "../types.ts";
import { createQuickRunner, findAgent, QUICK_AGENTS, type QuickRun } from "./index.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
task="$2"
printf '%s\n' "$@" > "$PWD/args.txt"
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
      spend: "spend.jsonl",
      projects: "projects",
    },
    quick: {
      enabled: true,
      model: "test-model",
      effort: "low",
      sync_wait_secs: 2,
      hard_timeout_secs: 5,
      max_concurrent: 2,
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
    onDetachedResult: (run) => {
      detached.push(run);
    },
  });
  return { dir, runner, detached };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test state");
    await Bun.sleep(20);
  }
}

describe("registry", () => {
  test("ships the fire-and-report roster; browser work lives in the dedicated agent", () => {
    expect(QUICK_AGENTS.map((agent) => agent.name)).toEqual(["quick-code", "repo-explorer"]);
    expect(findAgent("quick-code")?.name).toBe("quick-code");
    expect(findAgent("computer-use")).toBeUndefined();
    expect(setup().runner.agents()).toHaveLength(2);
  });
});

describe("plain quick runs", () => {
  test("fast success and nonzero failure return synchronously", async () => {
    const { runner } = setup();
    const success = await runner.run("quick-code", "say hi", "chan-1");
    if (!("done" in success)) throw new Error("expected sync result");
    expect(success).toMatchObject({ state: "done", result: "REPORT:say hi" });
    const failure = await runner.run("quick-code", "please FAIL now", null);
    if (!("done" in failure)) throw new Error("expected sync result");
    expect(failure.state).toBe("error");
    expect(failure.result).toContain("boom");
  });

  test("detach, timeout, and lane-full contracts remain intact", async () => {
    const { runner, detached } = setup({ sync_wait_secs: 0.1, hard_timeout_secs: 0.5, max_concurrent: 1 });
    const first = await runner.run("quick-code", "SLEEPLONG hold", "chan");
    expect("detached" in first).toBe(true);
    await expect(runner.run("quick-code", "second", null)).rejects.toThrow(/lane is full/);
    await waitUntil(() => detached.length === 1);
    expect(detached[0]!.state).toBe("timeout");
  });
});

describe("guards and shutdown", () => {
  test("bad requests fail clearly and computer-use points at the browser agent", async () => {
    const { runner } = setup();
    await expect(runner.run("no-such-agent", "x", null)).rejects.toThrow(/unknown quick agent/);
    await expect(runner.run("computer-use", "log in somewhere", null)).rejects.toThrow(/beckett browser/);
    await expect(runner.run("quick-code", "   ", null)).rejects.toThrow(/non-empty task/);
    await expect(setup({ enabled: false }).runner.run("quick-code", "x", null)).rejects.toThrow(/disabled/);
  });

  test("stopAll settles live children", async () => {
    const { runner, detached } = setup({ sync_wait_secs: 0.1 });
    await runner.run("quick-code", "SLEEP1 straggler", "chan");
    expect(runner.stats().running).toBe(1);
    await runner.stopAll();
    expect(runner.stats().running).toBe(0);
    expect(detached[0]).toMatchObject({ state: "error" });
  });
});
