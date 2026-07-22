/** Background browser agent: detach, park/surface/resume, keychain secrets, durable outcomes. */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRuntime } from "./runtime.ts";
import type { Config, Logger } from "../types.ts";
import type { KeychainReader } from "../secret/keychain-read.ts";
import {
  createBrowserAgent,
  redactKnownBrowserInputs,
  secretsPreamble,
  type BrowserAgentQuestion,
  type BrowserAgentRun,
} from "./agent.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
is_resume=0
for arg in "$@"; do
  [ "$arg" = "--resume" ] && is_resume=1
done
input="$(cat)"
if [ "$is_resume" = "1" ]; then args_file=args-resume.txt; else args_file=args.txt; fi
printf '%s\n' "$@" > "$PWD/$args_file"
printf '%s' "$input" > "$PWD/input-$args_file"
if [[ "$input" == *ASK_COLOR* ]]; then
  printf '%s\n' '{"session_id":"test","structured_output":{"status":"needs_input","summary":"I reached the color choice.","question":"Which color should I choose?","proofApplicable":true}}'
elif [[ "$input" == *SECOND_QUESTION* ]]; then
  printf '%s\n' '{"session_id":"test","structured_output":{"status":"needs_input","summary":"One more decision.","question":"The saved password is hunter2. Should I continue?","proofApplicable":false}}'
elif [[ "$input" == *BROWSER_FAIL* ]]; then
  printf '%s\n' '{"session_id":"test","structured_output":{"status":"failed","summary":"The site rejected the request.","question":null,"proofApplicable":false}}'
else
  printf '{"session_id":"test","structured_output":{"status":"completed","summary":"BROWSER:%s","question":null,"proofApplicable":true}}\n' "$input"
fi
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
      throw new Error("not used by agent unit tests");
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

function fakeKeychain(values: Record<string, string>, totpCodes: string[] = []): KeychainReader {
  const codes = [...totpCodes];
  return {
    async read(entry) {
      return {
        entry,
        fields: [...Object.keys(values), ...(totpCodes.length > 0 ? ["totp"] : [])],
        values: { ...values },
        hasTotp: totpCodes.length > 0,
      };
    },
    async totp() {
      const code = codes.shift();
      if (!code) throw new Error("no more codes");
      return code;
    },
  };
}

function setup(
  overrides: Partial<Config["quick"]> = {},
  behavior: {
    onQuestion?: (run: BrowserAgentRun, question: BrowserAgentQuestion) => Promise<string>;
    onOutcome?: (run: BrowserAgentRun) => void | Promise<void>;
    browser?: BrowserRuntime;
    keychain?: KeychainReader;
    dir?: string;
  } = {},
) {
  const dir = behavior.dir ?? mkdtempSync(join(tmpdir(), "browser-agent-test-"));
  const outcomes: BrowserAgentRun[] = [];
  const questions: { run: BrowserAgentRun; question: BrowserAgentQuestion }[] = [];
  const agent = createBrowserAgent({
    config: makeConfig(dir, overrides),
    logger: quietLog,
    browser: behavior.browser ?? fakeBrowser(),
    ...(behavior.keychain ? { keychain: behavior.keychain } : {}),
    onOutcome: behavior.onOutcome ?? ((run) => {
      outcomes.push(structuredClone(run));
    }),
    onQuestion: behavior.onQuestion ?? (async (run, question) => {
      questions.push({ run, question });
      return `question-${questions.length}`;
    }),
  });
  return { dir, agent, outcomes, questions };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test state");
    await Bun.sleep(20);
  }
}

describe("dispatch", () => {
  test("returns immediately, runs in the background, and reports the outcome", async () => {
    const { dir, agent, outcomes } = setup();
    const { runId } = await agent.run("inspect args", { channelId: "chan", requesterId: "owner" });
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const runDir = join(dir, "browser-agent", runId);
    await waitUntil(() => outcomes.length === 1);
    const args = readFileSync(join(runDir, "args.txt"), "utf8");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("mcp__browser__betterwright_browser");
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.browser.args[0]).toEndWith("/src/browser/mcp.ts");
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_RUN_ID).toBe(runId);
    expect(mcp.mcpServers.browser.env.BECKETT_BROWSER_CONTROL_TOKEN.length).toBeGreaterThanOrEqual(43);
    expect(outcomes[0]).toMatchObject({ state: "done", result: "BROWSER:inspect args", outcomeDelivered: false });
    expect(outcomes[0]!.proofFiles).toHaveLength(1);
  });

  test("rejects a second concurrent run and dispatches without channel/requester", async () => {
    const { agent, questions } = setup();
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1);
    await expect(agent.run("another", { channelId: "chan", requesterId: "owner" })).rejects.toThrow(/already working/);
    await expect(agent.run("x", { channelId: "", requesterId: "owner" })).rejects.toThrow(/origin channel/);
  });
});

describe("pause, surface, resume", () => {
  test("parks on a screenshot-backed question and resumes the same session", async () => {
    const { dir, agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1 && questions.length === 1);
    expect(questions[0]!.question.text).toBe("Which color should I choose?");
    expect(existsSync(questions[0]!.question.screenshot)).toBe(true);
    await agent.resume(runId, "blue");
    await waitUntil(() => outcomes.length === 1);
    expect(readFileSync(join(dir, "browser-agent", runId, "args-resume.txt"), "utf8")).toContain("--resume");
    expect(outcomes[0]).toMatchObject({ state: "done", result: "BROWSER:[redacted]" });
  });

  test("scrubs password and OTP answers from resumed summaries and later questions", async () => {
    const { agent, outcomes, questions } = setup();
    const { runId } = await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => questions.length === 1 && agent.stats().waiting === 1);
    await agent.resume(runId, "SECOND_QUESTION hunter2");
    await waitUntil(() => questions.length === 2 && agent.stats().waiting === 1);
    expect(questions[1]!.question.text).toContain("[redacted]");
    expect(questions[1]!.question.text).not.toContain("hunter2");
    await agent.resume(runId, "yes");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("done");
  });

  test("a question nobody answers times out and still reports back", async () => {
    const { agent, outcomes } = setup({ browser_question_wait_secs: 0.2 });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.state).toBe("timeout");
    expect(outcomes[0]!.result).toContain("Timed out waiting");
  });

  test("downgrades a claimed completion when proof capture fails", async () => {
    const browser = fakeBrowser();
    browser.release = async () => [];
    const { agent, outcomes } = setup({}, { browser });
    await agent.run("finish visibly", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ state: "error", proofFiles: [] });
    expect(outcomes[0]!.result).toContain("outcome as unverified");
  });
});

describe("keychain secrets", () => {
  test("resolves the entry at dispatch, names fields to the model, injects values per eval", async () => {
    const keychain = fakeKeychain({ email: "bot@example.com", password: "sup3r-secret-pw" }, ["739184", "224466"]);
    const { dir, agent, outcomes } = setup({}, { keychain });
    const { runId } = await agent.run("ASK_COLOR log in first", {
      channelId: "chan",
      requesterId: "owner",
      credsEntry: "x.com",
    });
    const first = await agent.evalSecrets(runId);
    expect(first).toMatchObject({ email: "bot@example.com", password: "sup3r-secret-pw", totp: "739184" });
    const second = await agent.evalSecrets(runId);
    expect(second!.totp).toBe("224466");
    await waitUntil(() => agent.stats().waiting === 1);
    // The model's task input names the fields but never the values.
    const input = readFileSync(join(dir, "browser-agent", runId, "input-args.txt"), "utf8");
    expect(input).toContain("secrets.password");
    expect(input).toContain('keychain entry "x.com"');
    expect(input).not.toContain("sup3r-secret-pw");
    await agent.resume(runId, "the password is sup3r-secret-pw and code 739184");
    await waitUntil(() => outcomes.length === 1);
    expect(outcomes[0]!.result).not.toContain("sup3r-secret-pw");
    expect(outcomes[0]!.result).not.toContain("739184");
    // The durable ledger never holds a secret value.
    const ledger = readFileSync(join(dir, "browser-agent", "runs.json"), "utf8");
    expect(ledger).not.toContain("sup3r-secret-pw");
    expect(ledger).not.toContain("739184");
    expect(ledger).toContain('"credsEntry": "x.com"');
  });

  test("a bad keychain entry fails the dispatch instantly", async () => {
    const keychain: KeychainReader = {
      async read() {
        throw new Error('jingle entry "nope" is not readable (1)');
      },
      async totp() {
        throw new Error("unused");
      },
    };
    const { agent } = setup({}, { keychain });
    await expect(
      agent.run("log in", { channelId: "chan", requesterId: "owner", credsEntry: "nope" }),
    ).rejects.toThrow(/not readable/);
    expect(agent.stats().running).toBe(0);
  });

  test("runs without a creds entry expose no secrets", async () => {
    const { agent, outcomes } = setup();
    const { runId } = await agent.run("plain lookup", { channelId: "chan", requesterId: "owner" });
    expect(await agent.evalSecrets(runId)).toBeNull();
    await waitUntil(() => outcomes.length === 1);
  });

  test("secretsPreamble lists fields, marks totp as per-script, and holds no values", () => {
    const preamble = secretsPreamble({
      entry: "x.com",
      fields: ["email", "password", "totp"],
      values: { email: "bot@example.com", password: "pw" },
      hasTotp: true,
    });
    expect(preamble).toContain("secrets.email");
    expect(preamble).toContain("secrets.totp");
    expect(preamble).not.toContain("bot@example.com");
  });
});

describe("durable outcomes and crash recovery", () => {
  test("a run that was live when the daemon died is reported as an error on recover", async () => {
    const { dir, agent, questions } = setup();
    await agent.run("ASK_COLOR", { channelId: "chan-7", requesterId: "owner" });
    await waitUntil(() => questions.length === 1 && agent.stats().waiting === 1);
    // Simulate a hard crash: a fresh agent over the same beckett dir, no stopAll.
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]).toMatchObject({ channelId: "chan-7", state: "error" });
    expect(revived.outcomes[0]!.result).toContain("daemon restarted");
    const ledger = JSON.parse(readFileSync(join(dir, "browser-agent", "runs.json"), "utf8")) as BrowserAgentRun[];
    expect(ledger.every((run) => run.outcomeDelivered)).toBe(true);
  });

  test("an undelivered outcome is retried by recover until the concierge takes it", async () => {
    const { dir, agent } = setup({}, {
      onOutcome: () => {
        throw new Error("concierge offline");
      },
    });
    await agent.run("plain task", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().running === 0);
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]!.state).toBe("done");
    const ledger = JSON.parse(readFileSync(join(dir, "browser-agent", "runs.json"), "utf8")) as BrowserAgentRun[];
    expect(ledger.every((run) => run.outcomeDelivered)).toBe(true);
  });

  test("stopAll settles live runs as errors that survive to the next boot", async () => {
    const failures: string[] = [];
    const { dir, agent } = setup({}, {
      onOutcome: (run) => {
        failures.push(run.runId);
        throw new Error("shutting down");
      },
    });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    await agent.stopAll();
    expect(agent.stats().running + agent.stats().waiting).toBe(0);
    const revived = setup({}, { dir });
    await revived.agent.recover();
    expect(revived.outcomes).toHaveLength(1);
    expect(revived.outcomes[0]!.result).toContain("shut down");
  });

  test("stopAll does not wait forever for an offline question post", async () => {
    const { agent } = setup({}, {
      onQuestion: async () => await new Promise<string>(() => undefined),
    });
    await agent.run("ASK_COLOR", { channelId: "chan", requesterId: "owner" });
    await waitUntil(() => agent.stats().waiting === 1);
    await Promise.race([
      agent.stopAll(),
      Bun.sleep(500).then(() => {
        throw new Error("stopAll hung on question delivery");
      }),
    ]);
    expect(agent.stats().waiting).toBe(0);
  });
});

describe("redaction", () => {
  test("treats every exact sensitive input as sensitive regardless of strength", () => {
    for (const answer of ["monkey", "abcde", "a!2", "123", "Lee"]) {
      expect(redactKnownBrowserInputs(`The prior answer was ${answer}.`, [answer])).toBe(
        "The prior answer was [redacted].",
      );
    }
    const extracted = redactKnownBrowserInputs("Should I use monkey again?", ["Use monkey"]);
    expect(extracted).not.toContain("monkey");
  });
});
