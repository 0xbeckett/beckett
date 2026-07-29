/** Quick-runner lifecycle: the fire-and-report no-ticket lane. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, LaneHarness, Logger } from "../types.ts";
import { laneConfig, writeClaudeLaneStub, writePiLaneStub } from "../test/lane-stubs.ts";
import { createQuickRunner, findAgent, QUICK_AGENTS, type QuickRun } from "./index.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

function makeConfig(
  dir: string,
  overrides: Partial<Config["quick"]> = {},
  lane: LaneHarness = "pi",
): Config {
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
    harness: {
      claude: { bin: writeClaudeLaneStub(dir), default_model: "claude-default", permission_mode: "bypassPermissions", extra_flags: [] },
      pi: { bin: writePiLaneStub(dir), default_provider: "openai-codex", default_model: "gpt-5.6-terra", thinking: "high" },
      lanes: laneConfig({ quick: { harness: lane } }),
    },
  } as unknown as Config;
}

function setup(overrides: Partial<Config["quick"]> = {}, lane: LaneHarness = "pi") {
  const dir = mkdtempSync(join(tmpdir(), "quick-test-"));
  const detached: QuickRun[] = [];
  const runner = createQuickRunner({
    config: makeConfig(dir, overrides, lane),
    logger: quietLog,
    onDetachedResult: (run) => {
      detached.push(run);
    },
  });
  return { dir, runner, detached };
}

/** The argv the stub recorded for the most recent run in `dir`. */
function recordedArgs(dir: string): string[] {
  const runs = readdirSync(join(dir, "quick"));
  for (const run of runs) {
    const path = join(dir, "quick", run, "args.txt");
    if (existsSync(path)) return readFileSync(path, "utf8").trim().split("\n");
  }
  throw new Error("no quick run recorded its argv");
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
    expect(QUICK_AGENTS.map((agent) => agent.name)).toEqual(["quick-code", "repo-explorer", "pi-extension"]);
    expect(findAgent("quick-code")?.name).toBe("quick-code");
    expect(findAgent("computer-use")).toBeUndefined();
    expect(setup().runner.agents()).toHaveLength(3);
  });

  test("every registered agent has a readable prompt file", () => {
    for (const agent of QUICK_AGENTS) {
      const prompt = readFileSync(join(import.meta.dir, "agents", agent.promptFile), "utf8");
      expect(prompt.trim().length).toBeGreaterThan(200);
    }
  });
});

describe("harness lane (#125)", () => {
  test("quick agents spawn under pi by default and return a usable report", async () => {
    for (const agent of QUICK_AGENTS) {
      const { dir, runner } = setup();
      const out = await runner.run(agent.name, `summarize this for ${agent.name}`, "chan");
      if (!("done" in out)) throw new Error("expected sync result");
      expect(out.state).toBe("done");
      // The report survives pi's NDJSON envelope, not just claude's plain text.
      expect(out.result).toBe(`REPORT:summarize this for ${agent.name}`);

      const args = recordedArgs(dir);
      expect(args).toContain("--mode");
      expect(args).toContain("json");
      expect(args).toContain("--provider");
      expect(args).toContain("openai-codex");
      expect(args).toContain("gpt-5.6-terra"); // pi's default model, not the claude `quick.model`
      expect(args).toContain("--thinking");
      // The prompt is positional under pi and must be last.
      expect(args.at(-1)).toBe(`summarize this for ${agent.name}`);
      // The agent's system prompt still reaches the harness.
      expect(args).toContain("--append-system-prompt");
      // claude-only flags must not leak into a pi invocation.
      expect(args).not.toContain("--permission-mode");
      expect(args).not.toContain("--output-format");
    }
  });

  test('[harness.lanes.quick] harness = "claude" pins the lane back, restoring its old seat', async () => {
    const { dir, runner } = setup({}, "claude");
    const out = await runner.run("quick-code", "say hi", "chan");
    if (!("done" in out)) throw new Error("expected sync result");
    expect(out).toMatchObject({ state: "done", result: "REPORT:say hi" });

    const args = recordedArgs(dir);
    expect(args).toContain("--output-format");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("test-model"); // config.quick.model — the pre-#125 seat, unchanged
    expect(args).toContain("--effort");
    expect(args).not.toContain("--mode");
  });

  test("a pi run whose last turn died on a provider error is an error, not an empty success", async () => {
    const { runner } = setup();
    const out = await runner.run("quick-code", "PIERROR please", "chan");
    if (!("done" in out)) throw new Error("expected sync result");
    expect(out.state).toBe("error");
    expect(out.result).toContain("No API key found for anthropic");
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
