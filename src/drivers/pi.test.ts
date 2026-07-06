/**
 * Coverage for the PiDriver's event normalizer (`src/drivers/pi.ts`). The parser is the risky
 * part — it maps pi's `--mode json` NDJSON into Beckett's {@link WorkerEvent} stream — so it's
 * Also guards the OPS-56 / issue #12 regression: the modern session argv (`--session-id` for a
 * caller-minted first launch) and the preflight that catches stale CLI/version drift.
 *
 * pinned here against event lines copied from a real pi JSON run (session →
 * tool_execution → assistant message → agent_end), rather than trusting a live spawn. `handleLine`
 * is driven directly; spawn/process lifecycle is out of scope for a unit test.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDriver, piPreflight } from "./pi.ts";
import type { Config, WorkerEvent } from "../types.ts";

/** Minimal config exposing just what the parser reads. */
const config = {
  harness: {
    pi: { enabled: true, bin: "pi", default_provider: "openai-codex", default_model: "gpt-5.5", thinking: "high" },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** A driver with a collector attached; feed it raw JSON lines via handleLine. */
function harness() {
  const events: WorkerEvent[] = [];
  const driver = new PiDriver(config, quietLog);
  driver.onEvent((e) => events.push(e));
  const feed = (obj: unknown) => driver.handleLine(JSON.stringify(obj));
  return { driver, events, feed };
}

const CALL = "call_abc|fc_def";

test("normalizes a full pi run: session → tool → assistant → agent_end", () => {
  const { events, feed } = harness();

  feed({ type: "session", version: 3, id: "019f1c8b-0f77-7a29-b896-6a00ec141c14", cwd: "/x" });
  feed({ type: "agent_start" });
  feed({ type: "turn_start" });
  feed({ type: "tool_execution_start", toolCallId: CALL, toolName: "bash", args: { command: "echo hi" } });
  feed({ type: "tool_execution_end", toolCallId: CALL, toolName: "bash", result: { content: [] }, isError: false });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"status":"complete","summary":"did the thing","filesChanged":["a.ts"],"checksRun":null,"blockedReason":null}' }],
      usage: { input: 2539, output: 22, cacheRead: 0, cacheWrite: 0 },
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 2539, output: 22, cacheRead: 5, cacheWrite: 0 } }, toolResults: [] });
  feed({ type: "agent_end", messages: [] });

  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("session_started");
  expect(kinds).toContain("turn_started");
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("tool_result");
  expect(kinds).toContain("assistant_text");
  expect(kinds).toContain("turn_completed");
  expect(kinds).toContain("finished");

  const session = events.find((e) => e.kind === "session_started");
  expect(session).toMatchObject({ sessionId: "019f1c8b-0f77-7a29-b896-6a00ec141c14", model: "gpt-5.5" });

  const call = events.find((e) => e.kind === "tool_call");
  expect(call).toMatchObject({ tool: "bash", toolId: CALL });
  expect((call as { input: { command: string } }).input.command).toBe("echo hi");

  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: CALL, isError: false });

  const usage = events.find((e) => e.kind === "turn_completed") as { usage: { input: number; cacheRead: number } };
  expect(usage.usage.input).toBe(2539);
  expect(usage.usage.cacheRead).toBe(5); // pi cacheRead → TokenUsage.cacheRead

  // agent_end → success finish, with the done-signal parsed out of the final assistant message.
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    structuredOutput: { status: string; summary: string } | null;
  };
  expect(fin.status).toBe("success");
  expect(fin.structuredOutput).toMatchObject({ status: "complete", summary: "did the thing" });
});

test("a failed tool is surfaced as an errored tool_result", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } });
  feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true });
  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: "t1", isError: true });
});

test("an edit/write tool synthesizes a file_change (pi has no native file event)", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "src/new.ts" } });
  feed({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", result: {}, isError: false });
  const fc = events.find((e) => e.kind === "file_change") as { paths: { path: string; kind: string }[] } | undefined;
  expect(fc).toBeDefined();
  expect(fc!.paths[0]).toMatchObject({ path: "src/new.ts", kind: "update" });
});

test("done-signal parses from a ```json fenced block (lenient)", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: 'Here is my result:\n```json\n{"status":"blocked","summary":"needs a key","blockedReason":"no PAT"}\n```\nlet me know.' }],
    },
  });
  feed({ type: "agent_end", messages: [] });
  const fin = events.find((e) => e.kind === "finished") as { structuredOutput: { status: string } | null };
  expect(fin.structuredOutput).toMatchObject({ status: "blocked" });
});

test("a run whose last turn died on a provider error finishes as ERROR, not empty success", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "turn_start" });
  // The exact shape pi emits when auth is missing/expired: an empty assistant message carrying
  // stopReason:"error", then a clean agent_end. Without the runError guard this finished as an
  // instant empty "success" and the dispatcher advanced the ticket on nothing.
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "No API key for provider: openai-codex",
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "error" }, toolResults: [] });
  feed({ type: "agent_end", messages: [], willRetry: false });

  const err = events.find((e) => e.kind === "error");
  expect(err).toMatchObject({ message: "No API key for provider: openai-codex" });
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    subtype: string;
    errorClass?: string;
    structuredOutput: { status: string } | null;
  };
  expect(fin.status).toBe("error");
  expect(fin.subtype).toBe("error_provider");
  expect(fin.errorClass).toBe("auth"); // "no api key" classifies as auth → dispatcher holds, no blind retry
  expect(fin.structuredOutput).toMatchObject({ status: "blocked" });
});

test("a transient errored turn followed by a successful one still finishes as success", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
  });
  feed({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "recovered and done" }] },
  });
  feed({ type: "agent_end", messages: [] });
  const fin = events.find((e) => e.kind === "finished") as { status: string };
  expect(fin.status).toBe("success");
});

test("a malformed line becomes kind:unknown, never throws", () => {
  const { events, feed, driver } = harness();
  expect(() => driver.handleLine("not json at all {{{")).not.toThrow();
  expect(events.some((e) => e.kind === "unknown")).toBe(true);
});

test("kind is the pi-cli-stream driver tag", () => {
  const { driver } = harness();
  expect(driver.kind).toBe("pi-cli-stream");
});

// ── issue #12: modern pi session argv. ──
// buildArgs is private; drive it via bracket access with a stubbed session id + spec.
function argsFor(isResume: boolean, sessionId: string | null): string[] {
  const driver = new PiDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildArgs(prompt: string, isResume: boolean): string[];
  };
  driver.sessionId = sessionId;
  driver.spec = { envelope: { effort: "high" } };
  return driver.buildArgs("do the thing", isResume);
}

test("first launch pins Beckett's caller-minted id with --session-id", () => {
  const id = "cafe1234-0000-0000-0000-000000000000";
  const args = argsFor(/*isResume*/ false, id);
  const i = args.indexOf("--session-id");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe(id);
  expect(args).not.toContain("--session");
  expect(args).toContain("--mode");
  expect(args).toContain("json");
  expect(args[args.length - 1]).toBe("do the thing"); // prompt is the trailing positional
});

test("resume pins the existing id with --session <id>", () => {
  const id = "cafe1234-0000-0000-0000-000000000000";
  const args = argsFor(/*isResume*/ true, id);
  expect(args).not.toContain("--session-id");
  const i = args.indexOf("--session");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe(id);
});

// ── OPS-56: preflight catches a broken/absent pi harness loudly. ──
test("preflight FAILS loudly for a missing binary (no silent code-1)", async () => {
  const badConfig = {
    harness: { pi: { ...(config.harness as { pi: object }).pi, bin: "definitely-not-a-real-pi-binary-xyz" } },
  } as unknown as Config;
  const pf = await piPreflight(badConfig);
  expect(pf.ok).toBe(false);
  expect(pf.problems.length).toBeGreaterThan(0);
  expect(pf.problems.join(" ")).toContain("definitely-not-a-real-pi-binary-xyz");
});

test("preflight rejects stale pi without --session-id support", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-old-pi-"));
  const oldHome = process.env.HOME;
  try {
    const bin = join(dir, "pi-old");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  --version) echo 0.72.1 ;;",
        "  --help) echo '--mode --session --print' ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    const authDir = join(dir, ".pi/agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), '{"openai-codex":{}}\n', "utf8");
    process.env.HOME = dir;

    const oldConfig = {
      harness: { pi: { ...(config.harness as { pi: object }).pi, bin } },
    } as unknown as Config;
    const pf = await piPreflight(oldConfig);
    expect(pf.ok).toBe(false);
    expect(pf.problems.join(" ")).toContain("need >=0.78.0");
    expect(pf.problems.join(" ")).toContain("--session-id");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── issue #31: config & telemetry truthfulness. ──
test("turn_end usage.cost.total accumulates into getTelemetry().usdEstimate", () => {
  const { driver, feed } = harness();
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.0125 } } },
    toolResults: [],
  });
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 200, output: 20, cost: { total: 0.025 } } },
    toolResults: [],
  });
  expect(driver.getTelemetry().usdEstimate).toBeCloseTo(0.0375, 6);
});

test("usdEstimate stays null when pi reports no cost", () => {
  const { driver, feed } = harness();
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 100, output: 10 } },
    toolResults: [],
  });
  expect(driver.getTelemetry().usdEstimate).toBeNull();
});

test("worker env is pinned: --no-extensions --no-skills --no-themes on every launch", () => {
  for (const isResume of [false, true]) {
    const args = argsFor(isResume, "cafe1234-0000-0000-0000-000000000000");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-themes");
  }
});

test("un-cast worker falls back to config.harness.pi.thinking for --thinking", () => {
  const driver = new PiDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildArgs(prompt: string, isResume: boolean): string[];
  };
  driver.sessionId = null;
  driver.spec = { envelope: {} }; // no cast effort
  const args = driver.buildArgs("go", false);
  const i = args.indexOf("--thinking");
  expect(args[i + 1]).toBe("high"); // the config default, not claude's
});

test("process-exit diagnostics include the stderr tail", () => {
  const driver = new PiDriver(config, quietLog) as unknown as {
    stderrRing: { record(text: string): void };
    processExitMessage(code: number): string;
    spawnFailureError(reason: string | number): Error;
  };
  driver.stderrRing.record("first line\nunknown option: --session-id");
  const exit = driver.processExitMessage(1);
  expect(exit).toContain("unknown option: --session-id");
  const startup = driver.spawnFailureError("code 1");
  expect(startup.message).toContain("unknown option: --session-id");
});
