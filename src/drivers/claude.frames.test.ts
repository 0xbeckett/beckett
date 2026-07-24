/**
 * Golden frame-sequence coverage for the ClaudeDriver stream-json parser (`src/drivers/claude.ts`).
 *
 * claude.test.ts pins only `handleResult` success — handleSystem/handleAssistant/handleUser/
 * handleStreamEvent were UNCOVERED, leaving the base.ts envelope/token-map dedup (issue #19)
 * unenforceable for claude. This file drives `handleLine` over a recorded system→assistant→user→
 * result run and asserts the FULL ordered WorkerEvent sequence plus the load-bearing field values
 * (the claude token field-map, turn_started synthesis, file_change from WRITE_TOOLS, the session
 * handshake). Lines are hand-authored from a real `claude -p --output-format stream-json` stream.
 */

import { expect, test } from "bun:test";
import { ClaudeDriver } from "./claude.ts";
import type { Config, WorkerEvent } from "../types.ts";

const config = {
  harness: {
    claude: {
      default_model: "claude-sonnet-4-5",
      default_effort: "medium",
      permission_mode: "bypassPermissions",
      extra_flags: [],
    },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function harness() {
  const events: WorkerEvent[] = [];
  const driver = new ClaudeDriver(config, quietLog) as unknown as {
    handleLine(line: string): void;
    onEvent(cb: (e: WorkerEvent) => void): () => void;
  };
  driver.onEvent((e) => events.push(e));
  const feed = (obj: unknown) => driver.handleLine(JSON.stringify(obj));
  return { driver, events, feed };
}

test("normalizes a full claude run: init → assistant(text+tool) → user(tool_result) → result", () => {
  const { events, feed } = harness();

  feed({ type: "system", subtype: "init", session_id: "sess-xyz", model: "claude-opus-4-8" });
  feed({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        { type: "text", text: "writing the file now" },
        { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "src/added.ts" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
    },
  });
  feed({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false }] },
  });
  feed({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
    structured_output: { status: "complete" },
  });

  const kinds = events.map((e) => e.kind);
  expect(kinds).toEqual([
    "session_started",
    "turn_started",
    "turn_completed",
    "assistant_text",
    "tool_call",
    "file_change",
    "tool_result",
    "finished",
  ]);

  const session = events.find((e) => e.kind === "session_started");
  expect(session).toMatchObject({ sessionId: "sess-xyz", model: "claude-opus-4-8" });

  // The load-bearing token field-map: input_tokens→input, cache_creation_input_tokens→cacheCreate.
  const turn = events.find((e) => e.kind === "turn_completed") as { usage: { input: number; output: number; cacheRead: number; cacheCreate: number } };
  expect(turn.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheCreate: 7 });

  const text = events.find((e) => e.kind === "assistant_text") as { text: string; partial: boolean };
  expect(text).toMatchObject({ text: "writing the file now", partial: false });

  const call = events.find((e) => e.kind === "tool_call") as { tool: string; toolId: string };
  expect(call).toMatchObject({ tool: "Write", toolId: "tu_1" });

  const fc = events.find((e) => e.kind === "file_change") as { paths: { path: string; kind: string }[] };
  expect(fc.paths).toEqual([{ path: "src/added.ts", kind: "add" }]); // Write → add

  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: "tu_1", isError: false });

  const fin = events.find((e) => e.kind === "finished") as { status: string; subtype: string; structuredOutput: { status: string } | null };
  expect(fin.status).toBe("success");
  expect(fin.subtype).toBe("success");
  expect(fin.structuredOutput).toMatchObject({ status: "complete" });
});

test("a stream_event text_delta emits a partial assistant_text", () => {
  const { events, feed } = harness();
  feed({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" });
  feed({ type: "stream_event", event: { delta: { type: "text_delta", text: "partial chunk" } } });
  const text = events.find((e) => e.kind === "assistant_text") as { text: string; partial: boolean };
  expect(text).toMatchObject({ text: "partial chunk", partial: true });
});

test("an unknown system subtype is tolerated as kind:unknown", () => {
  const { events, feed } = harness();
  feed({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" });
  feed({ type: "system", subtype: "thinking_tokens", count: 42 });
  const unknown = events.find((e) => e.kind === "unknown") as { raw: unknown };
  expect(unknown.raw).toMatchObject({ subtype: "thinking_tokens" });
});

test("a top-level error line emits an error event with the message", () => {
  const { events, feed } = harness();
  feed({ type: "error", message: "something went wrong" });
  const err = events.find((e) => e.kind === "error");
  expect(err).toMatchObject({ message: "something went wrong" });
});

test("a malformed line becomes kind:unknown carrying the raw string, never throws", () => {
  const { events, driver } = harness();
  expect(() => (driver as unknown as { handleLine(l: string): void }).handleLine("}}} not json")).not.toThrow();
  const unknown = events.find((e) => e.kind === "unknown") as { raw: unknown };
  expect(unknown.raw).toBe("}}} not json"); // parse-fail carries raw:line (the string)
});
