/**
 * Golden frame-sequence coverage for the CodexDriver `--json` parser (`src/drivers/codex.ts`).
 *
 * codex.test.ts pins only argv/pricing/preflight — every `handleLine` path was UNCOVERED, which
 * made the "byte-identical parser" bar unenforceable for the base.ts envelope/token-map dedup
 * (issue #19). This file drives `handleLine` over a recorded thread/item run and asserts the FULL
 * ordered WorkerEvent sequence plus the load-bearing field values (the codex token field-map, the
 * dedup-by-item-id, file_change kinds, the turn.failed subtype). Lines are hand-authored from a
 * real `codex exec --json` stream (same convention as pi.test.ts) to avoid a live-spawn dependency.
 */

import { expect, test } from "bun:test";
import { CodexDriver } from "./codex.ts";
import type { Config, WorkerEvent } from "../types.ts";

const config = {
  harness: {
    codex: {
      bin: "codex",
      default_model: "gpt-5-codex",
      default_effort: "medium",
      sandbox_mode: "workspace-write",
      approval_policy: "on-failure",
      network_default: false,
    },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function harness() {
  const events: WorkerEvent[] = [];
  const driver = new CodexDriver(config, quietLog) as unknown as {
    handleLine(line: string): void;
    onEvent(cb: (e: WorkerEvent) => void): () => void;
  };
  driver.onEvent((e) => events.push(e));
  const feed = (obj: unknown) => driver.handleLine(JSON.stringify(obj));
  return { driver, events, feed };
}

test("normalizes a full codex run: thread → turn → items → turn.completed", () => {
  const { events, feed } = harness();

  feed({ type: "thread.started", thread_id: "th_abc123" });
  feed({ type: "turn.started" });
  feed({ type: "item.started", item: { id: "it_cmd", type: "command_execution", command: "ls -la" } });
  feed({ type: "item.completed", item: { id: "it_cmd", type: "command_execution", command: "ls -la", exit_code: 0 } });
  feed({
    type: "item.completed",
    item: { id: "it_fc", type: "file_change", changes: [{ path: "src/new.ts", kind: "add" }, { path: "src/old.ts", kind: "delete" }] },
  });
  feed({
    type: "item.completed",
    item: { id: "it_todo", type: "todo_list", items: [{ text: "step one", completed: true }, { text: "step two", completed: false }] },
  });
  feed({
    type: "item.completed",
    item: { id: "it_msg", type: "agent_message", text: '{"status":"complete","summary":"did the thing"}' },
  });
  feed({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 300 } });

  const kinds = events.map((e) => e.kind);
  expect(kinds).toEqual([
    "session_started",
    "turn_started",
    "tool_call",
    "tool_result",
    "file_change",
    "plan_update",
    "assistant_text",
    "turn_completed",
    "finished",
  ]);

  const session = events.find((e) => e.kind === "session_started");
  expect(session).toMatchObject({ sessionId: "th_abc123", model: "gpt-5-codex" });

  const call = events.find((e) => e.kind === "tool_call");
  expect(call).toMatchObject({ tool: "ls -la", toolId: "it_cmd" });

  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: "it_cmd", isError: false });

  const fc = events.find((e) => e.kind === "file_change") as { paths: { path: string; kind: string }[] };
  expect(fc.paths).toEqual([{ path: "src/new.ts", kind: "add" }, { path: "src/old.ts", kind: "delete" }]);

  const plan = events.find((e) => e.kind === "plan_update") as { items: { text: string; done: boolean }[] };
  expect(plan.items).toEqual([{ text: "step one", done: true }, { text: "step two", done: false }]);

  // The load-bearing token field-map: codex `cached_input_tokens` → cacheRead, cacheCreate always 0.
  const turn = events.find((e) => e.kind === "turn_completed") as { usage: { input: number; output: number; cacheRead: number; cacheCreate: number } };
  expect(turn.usage).toEqual({ input: 1000, output: 200, cacheRead: 300, cacheCreate: 0 });

  const fin = events.find((e) => e.kind === "finished") as { status: string; subtype: string; structuredOutput: { status: string } | null };
  expect(fin.status).toBe("success");
  expect(fin.subtype).toBe("success");
  expect(fin.structuredOutput).toMatchObject({ status: "complete", summary: "did the thing" });
});

test("a command_execution item is counted once across started→completed (dedup by id)", () => {
  const { events, feed } = harness();
  feed({ type: "thread.started", thread_id: "th_1" });
  feed({ type: "item.started", item: { id: "dup", type: "command_execution", command: "echo" } });
  feed({ type: "item.updated", item: { id: "dup", type: "command_execution", command: "echo" } });
  feed({ type: "item.completed", item: { id: "dup", type: "command_execution", command: "echo", exit_code: 2 } });
  expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: "dup", isError: true }); // exit_code !== 0 → errored
});

test("turn.failed emits an error + error_turn_failed finish", () => {
  const { events, feed } = harness();
  feed({ type: "thread.started", thread_id: "th_2" });
  feed({ type: "turn.failed", error: { message: "model refused the request" } });
  const err = events.find((e) => e.kind === "error");
  expect(err).toMatchObject({ message: "model refused the request" });
  const fin = events.find((e) => e.kind === "finished") as { status: string; subtype: string };
  expect(fin.status).toBe("error");
  expect(fin.subtype).toBe("error_turn_failed");
});

test("a malformed line becomes kind:unknown carrying the raw string, never throws", () => {
  const { events, driver } = harness();
  expect(() => (driver as unknown as { handleLine(l: string): void }).handleLine("not json {{{")).not.toThrow();
  const unknown = events.find((e) => e.kind === "unknown") as { raw: unknown };
  expect(unknown).toBeDefined();
  expect(unknown.raw).toBe("not json {{{"); // parse-fail carries raw:line (the string)
});

test("an unknown top-level type becomes kind:unknown carrying the parsed object", () => {
  const { events, feed } = harness();
  feed({ type: "totally.new.event", foo: 1 });
  const unknown = events.find((e) => e.kind === "unknown") as { raw: unknown };
  expect(unknown.raw).toMatchObject({ type: "totally.new.event", foo: 1 }); // default carries raw:obj
});
