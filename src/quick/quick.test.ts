/** Quick-runner lifecycle, including the resumable persistent-browser lane. */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRuntime } from "../browser/runtime.ts";
import type { Config, Logger } from "../types.ts";
import {
  createQuickRunner,
  findAgent,
  QUICK_AGENTS,
  redactKnownBrowserInputs,
  type QuickQuestion,
  type QuickRun,
} from "./index.ts";

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
is_browser=0
is_resume=0
for arg in "$@"; do
  [ "$arg" = "--json-schema" ] && is_browser=1
  [ "$arg" = "--resume" ] && is_resume=1
done
if [ "$is_browser" = "1" ]; then
  input="$(cat)"
  if [ "$is_resume" = "1" ]; then args_file=args-resume.txt; else args_file=args.txt; fi
  printf '%s\n' "$@" > "$PWD/$args_file"
  if [[ "$input" == *ASK_COLOR* ]]; then
    printf '%s\n' '{"session_id":"test","structured_output":{"status":"needs_input","summary":"I reached the color choice.","question":"Which color should I choose?","proofApplicable":true}}'
  elif [[ "$input" == *SECOND_QUESTION* ]]; then
    printf '%s\n' '{"session_id":"test","structured_output":{"status":"needs_input","summary":"One more decision.","question":"The saved password is hunter2. Should I continue?","proofApplicable":false}}'
  elif [[ "$input" == *BROWSER_FAIL* ]]; then
    printf '%s\n' '{"session_id":"test","structured_output":{"status":"failed","summary":"The site rejected the request.","question":null,"proofApplicable":false}}'
  else
    printf '{"session_id":"test","structured_output":{"status":"completed","summary":"BROWSER:%s","question":null,"proofApplicable":true}}\n' "$input"
  fi
  exit 0
fi
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
      browser_profile_dir: "browser/profile",
      browser_headless: true,
      browser_viewport_width: 1440,
      browser_viewport_height: 900,
      browser_launch_timeout_ms: 30_000,
      browser_action_timeout_ms: 10_000,
      browser_navigation_timeout_ms: 30_000,
      browser_eval_timeout_ms: 60_000,
      browser_max_output_chars: 24_000,
      browser_question_wait_secs: 60,
      ...overrides,
    },
    harness: { claude: { bin: writeStubBin(dir), permission_mode: "bypassPermissions", extra_flags: [] } },
  } as unknown as Config;
}

function fakeBrowser(): BrowserRuntime {
  let lease: { runId: string; artifactsDir: string } | null = null;
  return {
    async acquire(next) {
      lease = next;
      mkdirSync(next.artifactsDir, { recursive: true });
    },
    async evaluate() {
      throw new Error("not used by runner unit tests");
    },
    async capture(runId, name) {
      if (!lease || lease.runId !== runId) throw new Error("missing lease");
      const path = join(lease.artifactsDir, `${name}.png`);
      writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
      return path;
    },
    async checkpoint() {
      return { urls: ["about:blank"], activeIndex: 0 };
    },
    async restore() {},
    async release(runId, captureProof) {
      if (!lease || lease.runId !== runId) return [];
      const files = captureProof ? [await this.capture(runId, "proof")] : [];
      lease = null;
      return files;
    },
    hasLease(runId) {
      return lease?.runId === runId;
    },
    stats() {
      return { ready: !!lease, profileDir: "test", activeRunId: lease?.runId ?? null, pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 };
    },
    async stop() {
      lease = null;
    },
  };
}

function setup(
  overrides: Partial<Config["quick"]> = {},
  behavior: {
    onQuestion?: (run: QuickRun, question: QuickQuestion) => Promise<string>;
    browser?: BrowserRuntime;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "quick-test-"));
  const detached: QuickRun[] = [];
  const questions: { run: QuickRun; question: QuickQuestion }[] = [];
  const runner = createQuickRunner({
    config: makeConfig(dir, overrides),
    logger: quietLog,
    browser: behavior.browser ?? fakeBrowser(),
    onDetachedResult: (run) => {
      detached.push(run);
    },
    onQuestion: behavior.onQuestion ?? (async (run, question) => {
      questions.push({ run, question });
      return `question-${questions.length}`;
    }),
  });
  return { dir, runner, detached, questions };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test state");
    await Bun.sleep(20);
  }
}

describe("registry", () => {
  test("ships the quick-agent roster", () => {
    expect(QUICK_AGENTS.map((agent) => agent.name)).toEqual(["computer-use", "quick-code", "repo-explorer"]);
    expect(findAgent("quick-code")?.name).toBe("quick-code");
    expect(findAgent("nope")).toBeUndefined();
    expect(setup().runner.agents()).toHaveLength(3);
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

describe("browser run", () => {
  test("detaches immediately with one strict custom tool and replacement prompt", async () => {
    const { dir, runner, detached } = setup();
    const outcome = await runner.run("computer-use", "inspect args", "chan");
    if (!("detached" in outcome)) throw new Error("browser run must detach");
    expect(outcome.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const runDir = join(dir, "quick", outcome.runId);
    await waitUntil(() => existsSync(join(runDir, "args.txt")) && detached.length === 1);
    const args = readFileSync(join(runDir, "args.txt"), "utf8");
    expect(args).toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("mcp__browser__playwright_eval");
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.browser.args[0]).toEndWith("/src/browser/mcp.ts");
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_RUN_ID).toBe(outcome.runId);
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_CONTROL_TOKEN.length).toBeGreaterThanOrEqual(43);
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_MAX_OUTPUT_CHARS).toBe("24000");
    expect(detached[0]!.result).toBe("BROWSER:inspect args");
    expect(detached[0]!.proofFiles).toHaveLength(1);
  });

  test("parks on a screenshot-backed question and resumes the same session", async () => {
    const { dir, runner, detached, questions } = setup();
    const outcome = await runner.run("computer-use", "ASK_COLOR", "chan");
    if (!("detached" in outcome)) throw new Error("browser run must detach");
    await waitUntil(() => runner.stats().waiting === 1 && questions.length === 1);
    expect(questions[0]!.question.text).toBe("Which color should I choose?");
    expect(existsSync(questions[0]!.question.screenshot)).toBe(true);
    await runner.resume(outcome.runId, "blue");
    await waitUntil(() => detached.length === 1);
    expect(readFileSync(join(dir, "quick", outcome.runId, "args-resume.txt"), "utf8")).toContain("--resume");
    expect(detached[0]).toMatchObject({ state: "done", result: "BROWSER:[redacted]" });
  });

  test("scrubs password and OTP answers from resumed browser summaries", async () => {
    const { runner, detached } = setup();
    const outcome = await runner.run("computer-use", "ASK_COLOR", "chan");
    if (!("detached" in outcome)) throw new Error("browser run must detach");
    await waitUntil(() => runner.stats().waiting === 1);
    await runner.resume(outcome.runId, "Use hunter2 and OTP 739184");
    await waitUntil(() => detached.length === 1);
    expect(detached[0]!.result).toBe("BROWSER:[redacted]");
    expect(detached[0]!.result).not.toContain("hunter2");
    expect(detached[0]!.result).not.toContain("739184");
  });

  test("scrubs prior sensitive answers from every later browser question", async () => {
    const { runner, detached, questions } = setup();
    const outcome = await runner.run("computer-use", "ASK_COLOR", "chan");
    if (!("detached" in outcome)) throw new Error("browser run must detach");
    await waitUntil(() => questions.length === 1 && runner.stats().waiting === 1);
    await runner.resume(outcome.runId, "SECOND_QUESTION hunter2");
    await waitUntil(() => questions.length === 2 && runner.stats().waiting === 1);
    expect(questions[1]!.question.text).toContain("[redacted]");
    expect(questions[1]!.question.text).not.toContain("hunter2");
    await runner.resume(outcome.runId, "yes");
    await waitUntil(() => detached.length === 1);
    expect(detached[0]!.state).toBe("done");
  });

  test("treats every exact resumed answer as sensitive regardless of strength", () => {
    for (const answer of ["monkey", "abcde", "a!2", "123", "Lee"]) {
      expect(redactKnownBrowserInputs(`The prior answer was ${answer}.`, [answer])).toBe(
        "The prior answer was [redacted].",
      );
    }
    const extracted = redactKnownBrowserInputs("Should I use monkey again?", ["Use monkey"]);
    expect(extracted).not.toContain("monkey");
  });

  test("downgrades a claimed completion when proof capture fails", async () => {
    const browser = fakeBrowser();
    browser.release = async () => [];
    const { runner, detached } = setup({}, { browser });
    await runner.run("computer-use", "finish visibly", "chan");
    await waitUntil(() => detached.length === 1);
    expect(detached[0]).toMatchObject({ state: "error", proofFiles: [] });
    expect(detached[0]!.result).toContain("outcome as unverified");
  });
});

describe("guards and shutdown", () => {
  test("bad requests fail clearly", async () => {
    const { runner } = setup();
    await expect(runner.run("no-such-agent", "x", null)).rejects.toThrow(/unknown quick agent/);
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

  test("stopAll does not wait forever for an offline browser-question post", async () => {
    const { runner, detached } = setup({}, {
      onQuestion: async () => await new Promise<string>(() => undefined),
    });
    await runner.run("computer-use", "ASK_COLOR", "chan", "owner");
    await waitUntil(() => runner.stats().waiting === 1);
    await Promise.race([
      runner.stopAll(),
      Bun.sleep(500).then(() => { throw new Error("stopAll hung on question delivery"); }),
    ]);
    expect(runner.stats().waiting).toBe(0);
    expect(detached[0]).toMatchObject({ state: "error" });
  });
});
