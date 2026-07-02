/**
 * Beckett — PiDriver unit tests (`src/drivers/pi.test.ts`)
 * =======================================================================================
 * Covers the two OPS-56 hardening invariants without spawning a real process:
 *   1. VERSION-AGNOSTIC SESSIONS — buildArgs NEVER emits `--session-id`; a fresh run passes no
 *      session flag (pi mints its own id), a resume replays it via `--session <id>`.
 *   2. LOUD PROVIDER ERRORS — an `agent_end` whose last assistant turn ended in a provider error
 *      (`stopReason:"error"`) yields `finished status:"error"`, NOT a masked success.
 * Plus: NDJSON normalization, tolerant parsing, and the pure probe/version helpers.
 *
 * The NDJSON fixtures are verbatim shapes from the installed pi 0.80.3 `--mode json` stream.
 */

import { test, expect } from "bun:test";
import { defaultConfig } from "../config.ts";
import type { WorkerEvent } from "../types.ts";
import { PiDriver, providerErrorOf, scanProbeOutput, semverGte } from "./pi.ts";

/** A PiDriver wired to a sink that collects every normalized event. */
function driverWithSink(): { driver: PiDriver; events: WorkerEvent[] } {
  const driver = new PiDriver(defaultConfig());
  const events: WorkerEvent[] = [];
  driver.onEvent((e) => events.push(e));
  return { driver, events };
}

const kinds = (events: WorkerEvent[]) => events.map((e) => e.kind);

// ── the real quota-exhausted stream captured from `pi -p --mode json` (openai-codex) ──────────
const QUOTA_EXHAUSTED_STREAM = [
  `{"type":"session","version":3,"id":"019f2027-b017-7df0-873a-ac1d622e1d7e","cwd":"/tmp/x"}`,
  `{"type":"agent_start"}`,
  `{"type":"turn_start"}`,
  `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
  `{"type":"message_end","message":{"role":"assistant","content":[],"provider":"openai-codex","model":"gpt-5.5","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"Codex error: The usage limit has been reached"}}`,
  `{"type":"turn_end","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"Codex error: The usage limit has been reached"},"toolResults":[]}`,
  `{"type":"agent_end","messages":[],"willRetry":false}`,
];

// =======================================================================================
// version-agnostic sessions (OPS-56 fix #1)
// =======================================================================================

test("buildArgs NEVER emits --session-id (version-agnostic; the OPS-56 root cause)", () => {
  const driver = new PiDriver(defaultConfig());
  // fresh launch
  const fresh = (driver as any).buildArgs("do the thing", false) as string[];
  expect(fresh).not.toContain("--session-id");
  expect(fresh).not.toContain("--session"); // pi mints its own id on a fresh run
  expect(fresh).toContain("--mode");
  expect(fresh).toContain("json");
  expect(fresh.at(-1)).toBe("do the thing");
});

test("buildArgs on resume replays the captured id via --session <id>, never --session-id", () => {
  const driver = new PiDriver(defaultConfig());
  (driver as any).sessionId = "cafe1234-session-id";
  const resumed = (driver as any).buildArgs("continue", true) as string[];
  expect(resumed).not.toContain("--session-id");
  const i = resumed.indexOf("--session");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(resumed[i + 1]).toBe("cafe1234-session-id");
});

test("buildArgs appends the system prompt only on the FIRST launch", () => {
  const driver = new PiDriver(defaultConfig());
  (driver as any).spec = { systemAppend: "SCOPE+CRITERIA", envelope: { effort: "high" } };
  const fresh = (driver as any).buildArgs("task", false) as string[];
  expect(fresh).toContain("--append-system-prompt");
  (driver as any).sessionId = "s1";
  const resumed = (driver as any).buildArgs("task", true) as string[];
  expect(resumed).not.toContain("--append-system-prompt");
});

// =======================================================================================
// loud provider errors (OPS-56 fix #2)
// =======================================================================================

test("a quota-exhausted run FAILS LOUDLY instead of masking as success (the OPS-56 silent death)", () => {
  const { driver, events } = driverWithSink();
  for (const line of QUOTA_EXHAUSTED_STREAM) driver.handleLine(line);

  const finished = events.find((e) => e.kind === "finished");
  expect(finished).toBeDefined();
  expect((finished as any).status).toBe("error");
  expect((finished as any).subtype).toBe("error_provider");

  // the provider cause is surfaced as an error event, not swallowed
  const err = events.find((e) => e.kind === "error") as any;
  expect(err?.message).toContain("usage limit");
});

test("a clean run with real output finishes as success", () => {
  const { driver, events } = driverWithSink();
  driver.handleLine(`{"type":"session","version":3,"id":"abc","cwd":"/tmp"}`);
  driver.handleLine(`{"type":"turn_start"}`);
  driver.handleLine(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"end_turn"}}`,
  );
  driver.handleLine(
    `{"type":"turn_end","message":{"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}}}}`,
  );
  driver.handleLine(`{"type":"agent_end","messages":[],"willRetry":false}`);

  const finished = events.find((e) => e.kind === "finished") as any;
  expect(finished.status).toBe("success");
  expect(kinds(events)).toContain("session_started");
  expect(kinds(events)).toContain("assistant_text");
  expect(kinds(events)).toContain("turn_completed");
  // real per-turn cost is accumulated into telemetry
  expect(driver.getTelemetry().usdEstimate).toBeCloseTo(0.01, 5);
  expect(driver.getTelemetry().tokens.input).toBe(10);
});

test("a later successful turn clears an earlier transient provider error", () => {
  const { driver, events } = driverWithSink();
  driver.handleLine(`{"type":"session","version":3,"id":"abc","cwd":"/tmp"}`);
  driver.handleLine(
    `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"transient blip"}}`,
  );
  driver.handleLine(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}],"stopReason":"end_turn"}}`,
  );
  driver.handleLine(`{"type":"agent_end","messages":[],"willRetry":false}`);
  const finished = events.find((e) => e.kind === "finished") as any;
  expect(finished.status).toBe("success");
});

// =======================================================================================
// NDJSON normalization + tolerant parsing (Spec 02 §7.2)
// =======================================================================================

test("tool start/end normalize to tool_call/tool_result + synthesize a file_change for edits", () => {
  const { driver, events } = driverWithSink();
  driver.handleLine(`{"type":"session","version":3,"id":"abc","cwd":"/tmp"}`);
  driver.handleLine(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"src/a.ts"}}`);
  driver.handleLine(`{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","isError":false}`);

  const call = events.find((e) => e.kind === "tool_call") as any;
  expect(call.tool).toBe("edit");
  expect(call.toolId).toBe("t1");
  const fc = events.find((e) => e.kind === "file_change") as any;
  expect(fc.paths[0].path).toBe("src/a.ts");
  expect(driver.getTelemetry().toolCalls).toBe(1);
});

test("a failed tool does NOT synthesize a file_change", () => {
  const { driver, events } = driverWithSink();
  driver.handleLine(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"write","args":{"path":"x"}}`);
  driver.handleLine(`{"type":"tool_execution_end","toolCallId":"t1","toolName":"write","isError":true}`);
  const result = events.find((e) => e.kind === "tool_result") as any;
  expect(result.isError).toBe(true);
  expect(kinds(events)).not.toContain("file_change");
});

test("malformed and unknown lines are tolerated (routed to unknown, never throw)", () => {
  const { driver, events } = driverWithSink();
  expect(() => driver.handleLine("this is not json")).not.toThrow();
  expect(() => driver.handleLine(`{"type":"some_future_event","x":1}`)).not.toThrow();
  expect(kinds(events).filter((k) => k === "unknown").length).toBe(2);
});

test("high-frequency streaming chatter is ignored, not surfaced as unknown", () => {
  const { driver, events } = driverWithSink();
  for (const t of ["message_update", "tool_execution_update", "message_start", "agent_start", "compaction_start"]) {
    driver.handleLine(`{"type":"${t}"}`);
  }
  expect(events.length).toBe(0);
});

// =======================================================================================
// pure helpers
// =======================================================================================

test("providerErrorOf recognizes a failed turn and only a failed turn", () => {
  expect(providerErrorOf({ stopReason: "error", errorMessage: "boom" })).toBe("boom");
  expect(providerErrorOf({ stopReason: "end_turn", errorMessage: "boom" })).toBeNull();
  expect(providerErrorOf({ stopReason: "error" })).toBe("provider error (no message)");
  expect(providerErrorOf(undefined)).toBeNull();
});

test("scanProbeOutput extracts the session handshake and the provider error from a captured stream", () => {
  const scan = scanProbeOutput(QUOTA_EXHAUSTED_STREAM.join("\n"));
  expect(scan.sessionSeen).toBe(true);
  expect(scan.providerError).toContain("usage limit");

  const healthy = scanProbeOutput(
    [`{"type":"session","id":"x"}`, `{"type":"agent_end"}`].join("\n"),
  );
  expect(healthy.sessionSeen).toBe(true);
  expect(healthy.providerError).toBeNull();

  const deadBinary = scanProbeOutput("Error: Unknown option: --session-id");
  expect(deadBinary.sessionSeen).toBe(false);
});

test("semverGte compares dotted versions (tolerates a leading v)", () => {
  expect(semverGte("0.80.3", "0.78.0")).toBe(true);
  expect(semverGte("0.72.1", "0.78.0")).toBe(false);
  expect(semverGte("v22.23.1", "20.0.0")).toBe(true);
  expect(semverGte(null, "1.0.0")).toBe(false);
});
