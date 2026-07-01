/**
 * Coverage for the PiDriver's event normalizer (`src/drivers/pi.ts`). The parser is the risky
 * part — it maps pi's `--mode json` NDJSON into Beckett's {@link WorkerEvent} stream — so it's
 * pinned here against event lines copied VERBATIM from a real `pi 0.78.0` run (session →
 * tool_execution → assistant message → agent_end), rather than trusting a live spawn. `handleLine`
 * is driven directly; spawn/process lifecycle is out of scope for a unit test.
 */

import { expect, test } from "bun:test";
import { PiDriver } from "./pi.ts";
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

test("a malformed line becomes kind:unknown, never throws", () => {
  const { events, feed, driver } = harness();
  expect(() => driver.handleLine("not json at all {{{")).not.toThrow();
  expect(events.some((e) => e.kind === "unknown")).toBe(true);
});

test("kind is the pi-cli-stream driver tag", () => {
  const { driver } = harness();
  expect(driver.kind).toBe("pi-cli-stream");
});
