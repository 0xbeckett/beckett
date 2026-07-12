import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import {
  parseClaudeUsageResult,
  parseCodexSubscriptionUsage,
  queryCodexAppServer,
  readAllSubscriptionUsage,
  readClaudeSubscriptionUsage,
  readCodexSubscriptionUsage,
  usageProbeEnv,
  type CodexRpcSnapshot,
  type CommandResult,
} from "./subscription-usage.ts";

const NOW = 1_784_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 414,
    duration_api_ms: 0,
    num_turns: 0,
    result: [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 9% used \u00b7 resets Jul 12 at 2:50am (Asia/Singapore)",
      "Current week (all models): 3% used \u00b7 resets Jul 18 at 5pm (Asia/Singapore)",
      "Current week (Fable): 2% used \u00b7 resets Jul 18 at 5pm (Asia/Singapore)",
    ].join("\n"),
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    ...overrides,
  });
}

function codexSnapshot(overrides: Partial<CodexRpcSnapshot> = {}): CodexRpcSnapshot {
  return {
    account: {
      account: { type: "chatgpt", email: "must-not-leak@example.test", planType: "pro" },
      requiresOpenaiAuth: true,
    },
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_783_803_736 },
        secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_784_354_510 },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        planType: "pro",
      },
      rateLimitsByLimitId: {
        ignored: { limitName: "A separate model limit must not become a subscription" },
      },
      rateLimitResetCredits: { availableCount: 3, credits: [] },
    },
    ...overrides,
  };
}

describe("Claude subscription usage", () => {
  test("parses every provider-reported limit row and computes remaining usage", () => {
    expect(parseClaudeUsageResult(claudeResult())).toEqual([
      {
        label: "Session",
        usedPercent: 9,
        remainingPercent: 91,
        reset: { kind: "label", text: "Jul 12 at 2:50am (Asia/Singapore)" },
      },
      {
        label: "Week (all models)",
        usedPercent: 3,
        remainingPercent: 97,
        reset: { kind: "label", text: "Jul 18 at 5pm (Asia/Singapore)" },
      },
      {
        label: "Week (Fable)",
        usedPercent: 2,
        remainingPercent: 98,
        reset: { kind: "label", text: "Jul 18 at 5pm (Asia/Singapore)" },
      },
    ]);
  });

  test("rejects anything that consumed a model turn or tokens", () => {
    expect(parseClaudeUsageResult(claudeResult({ num_turns: 1 }))).toBeNull();
    expect(
      parseClaudeUsageResult(
        claudeResult({
          usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      ),
    ).toBeNull();
    expect(parseClaudeUsageResult(claudeResult({ duration_api_ms: 1 }))).toBeNull();
  });

  test("uses auth status plus the safe, non-persisted zero-turn command", async () => {
    const config = defaultConfig();
    config.harness.claude.bin = "claude-test";
    const calls: string[][] = [];
    const timeouts: number[] = [];
    const commandRunner = async (
      argv: string[],
      opts: { timeoutMs: number },
    ): Promise<CommandResult> => {
      calls.push(argv);
      timeouts.push(opts.timeoutMs);
      if (argv[1] === "auth") {
        return {
          code: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            email: "must-not-leak@example.test",
            subscriptionType: "max",
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: claudeResult(), stderr: "" };
    };

    const usage = await readClaudeSubscriptionUsage(config, { commandRunner, now: () => NOW });

    expect(calls).toEqual([
      ["claude-test", "auth", "status", "--json"],
      [
        "claude-test",
        "--safe-mode",
        "--no-session-persistence",
        "--max-turns",
        "0",
        "-p",
        "/usage",
        "--output-format",
        "json",
      ],
    ]);
    expect(timeouts).toEqual([10_000, 30_000]);
    expect(usage).toMatchObject({ provider: "claude", plan: "Max", status: "ok", observedAt: NOW });
    expect(usage.windows).toHaveLength(3);
    expect(JSON.stringify(usage)).not.toContain("must-not-leak");
  });

  test("fails closed on logout, timeout, or output drift", async () => {
    const config = defaultConfig();
    const loggedOut = await readClaudeSubscriptionUsage(config, {
      commandRunner: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: "" }),
      now: () => NOW,
    });
    expect(loggedOut).toMatchObject({ status: "disconnected", reason: "not-connected", windows: [] });

    const timedOut = await readClaudeSubscriptionUsage(config, {
      commandRunner: async () => ({ code: 137, stdout: "", stderr: "secret", timedOut: true }),
      now: () => NOW,
    });
    expect(timedOut).toMatchObject({ status: "unavailable", reason: "timeout", windows: [] });
    expect(JSON.stringify(timedOut)).not.toContain("secret");

    let call = 0;
    const drifted = await readClaudeSubscriptionUsage(config, {
      commandRunner: async () =>
        ++call === 1
          ? { code: 0, stdout: '{"loggedIn":true,"subscriptionType":"max"}', stderr: "" }
          : { code: 0, stdout: claudeResult({ result: "The usage screen changed." }), stderr: "" },
      now: () => NOW,
    });
    expect(drifted).toMatchObject({ status: "unavailable", reason: "no-usage-windows", windows: [] });
  });

  test("drops unknown rows and reset text that is not a strict provider date", () => {
    const raw = claudeResult({
      result: [
        "Current account email: 4% used · resets hidden@example.test",
        "Current session: 5% used · resets hidden@example.test",
        "Current session: 6% used · resets after billing for account 123",
        "Current week (all models): 6% used · resets Jul 18 at 5pm (Asia/Singapore)",
      ].join("\n"),
    });
    expect(parseClaudeUsageResult(raw)).toEqual([{
      label: "Week (all models)",
      usedPercent: 6,
      remainingPercent: 94,
      reset: { kind: "label", text: "Jul 18 at 5pm (Asia/Singapore)" },
    }]);
  });
});

describe("Codex subscription usage", () => {
  test("maps structured primary/secondary windows, plan, credits, and resets", () => {
    const usage = parseCodexSubscriptionUsage(codexSnapshot(), NOW);
    expect(usage).toEqual({
      provider: "codex",
      plan: "Pro",
      status: "ok",
      windows: [
        {
          label: "5-hour window",
          usedPercent: 8,
          remainingPercent: 92,
          reset: { kind: "timestamp", at: 1_783_803_736 },
        },
        {
          label: "Weekly window",
          usedPercent: 17,
          remainingPercent: 83,
          reset: { kind: "timestamp", at: 1_784_354_510 },
        },
      ],
      credits: { unlimited: false, balance: "12.50", resetCount: 3 },
      observedAt: NOW,
    });
    expect(JSON.stringify(usage)).not.toContain("must-not-leak");
    expect(JSON.stringify(usage)).not.toContain("separate model");
  });

  test("does not present API-key auth or a missing account as a subscription", () => {
    const apiKey = parseCodexSubscriptionUsage(
      codexSnapshot({
        account: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      }),
      NOW,
    );
    expect(apiKey).toMatchObject({ status: "disconnected", reason: "not-subscription", windows: [] });

    const missing = parseCodexSubscriptionUsage(
      codexSnapshot({ account: { account: null, requiresOpenaiAuth: true } }),
      NOW,
    );
    expect(missing).toMatchObject({ status: "disconnected", reason: "not-connected", windows: [] });
  });

  test("accepts nullable duration and credit balance from the app-server schema", () => {
    const snapshot = codexSnapshot();
    (snapshot.rateLimits as any).rateLimits.primary.windowDurationMins = null;
    (snapshot.rateLimits as any).rateLimits.credits.balance = null;
    const usage = parseCodexSubscriptionUsage(snapshot, NOW);
    expect(usage).toMatchObject({ status: "ok", credits: { unlimited: false, resetCount: 3 } });
    expect(usage.windows[0]).toMatchObject({ label: "Primary window", remainingPercent: 92 });
    expect(usage.credits).not.toHaveProperty("balance");
  });

  test("performs the app-server handshake and tolerates notifications/out-of-order replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-codex-rpc-"));
    dirs.push(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(
      bin,
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
let account = false;
let limits = false;
let sent = false;
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }) + "\\n");
  } else if (message.method === "initialized") {
    initialized = true;
  } else if (initialized && message.method === "account/read") {
    account = true;
  } else if (initialized && message.method === "account/rateLimits/read") {
    limits = true;
  }
  if (account && limits && !sent) {
    sent = true;
    process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: {} }) + "\\n");
    process.stdout.write(JSON.stringify({ id: 3, result: { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 123 }, secondary: null, planType: "pro" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt", planType: "pro", email: "hidden@example.test" }, requiresOpenaiAuth: true } }) + "\\n");
  }
}
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);

    const snapshot = await queryCodexAppServer(bin, {
      env: process.env as Record<string, string | undefined>,
      timeoutMs: 2_000,
    });
    expect(snapshot).toMatchObject({
      account: { account: { type: "chatgpt", planType: "pro" } },
      rateLimits: { rateLimits: { primary: { usedPercent: 1 } } },
    });
  });

  test("times out and reaps an app-server that stops answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-codex-rpc-timeout-"));
    dirs.push(dir);
    const bin = join(dir, "fake-codex");
    writeFileSync(
      bin,
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }) + "\\n");
  }
}
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    const config = defaultConfig();
    config.harness.codex.bin = bin;

    const usage = await readCodexSubscriptionUsage(config, { timeoutMs: 100, now: () => NOW });
    expect(usage).toMatchObject({ provider: "codex", status: "unavailable", reason: "timeout" });
  });
});

test("aggregate preserves healthy provider data when the other provider fails", async () => {
  const config = defaultConfig();
  let claudeCall = 0;
  const reports = await readAllSubscriptionUsage(config, {
    commandRunner: async () =>
      ++claudeCall === 1
        ? { code: 0, stdout: '{"loggedIn":true,"subscriptionType":"max"}', stderr: "" }
        : { code: 0, stdout: claudeResult(), stderr: "" },
    codexRpc: async () => {
      throw new Error("account endpoint unavailable and secret-shaped text");
    },
    now: () => NOW,
  });

  expect(reports).toHaveLength(2);
  expect(reports[0]).toMatchObject({ provider: "claude", status: "ok", plan: "Max" });
  expect(reports[1]).toMatchObject({ provider: "codex", status: "unavailable", reason: "command-failed" });
  expect(JSON.stringify(reports)).not.toContain("secret-shaped");
});

test("Codex adapter sanitizes an RPC failure without leaking process output", async () => {
  const config = defaultConfig();
  const usage = await readCodexSubscriptionUsage(config, {
    codexRpc: async () => await new Promise<CodexRpcSnapshot>((_, reject) => setTimeout(() => reject(new Error("late secret")), 1)),
    now: () => NOW,
  });
  expect(usage).toMatchObject({ provider: "codex", status: "unavailable", reason: "command-failed" });
  expect(JSON.stringify(usage)).not.toContain("late secret");
});

test("usage probe environment excludes unrelated daemon secrets", () => {
  expect(usageProbeEnv({
    HOME: "/tmp/home",
    PATH: "/bin",
    CODEX_HOME: "/tmp/codex",
    DISCORD_TOKEN: "discord-secret",
    PLANE_API_TOKEN: "plane-secret",
    GITHUB_PAT: "github-secret",
  })).toEqual({ HOME: "/tmp/home", PATH: "/bin", CODEX_HOME: "/tmp/codex" });
});
