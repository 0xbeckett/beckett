#!/usr/bin/env node
/**
 * Beckett — scripted fake `pi --mode rpc` (`src/drivers/fixtures/fake-pi.mjs`)
 * =======================================================================================
 * A stand-in for the pi CLI that speaks JUST enough of pi's RPC protocol (docs/rpc.md) to drive
 * {@link PiDriver} through a real spawn: real process, real stdin channel, real process group.
 * `pi.steering.test.ts` uses it to prove the issue-#122 claims that a parser-level unit test
 * cannot — that a nudge reaches a RUNNING pi mid-turn, that a cancel leaves no orphan, and that a
 * buffered nudge is replayed exactly once.
 *
 * It also answers the preflight probes (`--version`, `--help`) so the driver's real `spawn()`
 * path — preflight included — runs unmodified against it.
 *
 * Behaviour is picked by FAKE_PI_MODE:
 *   long      — start a turn and HANG in a tool call until a `steer` arrives; then finish the turn,
 *                inject the steered text as a user message, echo it back, and settle. This is the
 *                mid-turn-steer case.
 *   quick     — run one turn that echoes the prompt as the done-signal, then settle.
 *   latesteer — settle with the steer still in the queue (the race where a nudge lands in the same
 *                instant a run ends), then drain it on the next prompt.
 *
 * Every command it receives is appended to FAKE_PI_LOG as `<type>:<message>`, so a test can assert
 * exactly what pi saw — the only way to tell "applied once" from "applied twice".
 * FAKE_PI_ORPHAN=1 forks a detached sleeper first, so a cancel that only kills the leader is
 * visibly caught.
 */

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.82.1");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("--mode --session --session-id --no-extensions --no-skills --no-themes --print");
  process.exit(0);
}

const MODE = process.env.FAKE_PI_MODE ?? "quick";
const LOG = process.env.FAKE_PI_LOG ?? "";
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--session") ?? "fake-session";

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const record = (type, message) => {
  if (LOG) appendFileSync(LOG, `${type}:${message ?? ""}\n`);
};

// A detached grandchild in our process group: the thing a leader-only kill would orphan.
if (process.env.FAKE_PI_ORPHAN === "1") {
  const kid = spawn("sleep", ["600"], { stdio: "ignore" });
  record("orphan", String(kid.pid));
}

let steerQueue = [];
let settled = false;

/** Finish the hung turn, inject the steered text as a user turn, echo it, settle. */
function applySteerAndSettle() {
  const msg = steerQueue.shift();
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
  out({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 10, output: 1 } }, toolResults: [] });
  // pi drops the message from its queue as it injects it, and says so.
  out({ type: "message_start", message: { role: "user", content: msg } });
  out({ type: "message_end", message: { role: "user", content: msg } });
  out({ type: "queue_update", steering: [...steerQueue], followUp: [] });
  out({ type: "turn_start" });
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ status: "complete", summary: `APPLIED: ${msg}`, filesChanged: [], checksRun: [], blockedReason: null }) }],
      usage: { input: 20, output: 5 },
    },
  });
  out({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 20, output: 5 } }, toolResults: [] });
  out({ type: "agent_end", messages: [] });
  settled = true;
  out({ type: "agent_settled" });
}

function runQuickTurn(prompt) {
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ status: "complete", summary: `RAN: ${prompt}`, filesChanged: [], checksRun: [], blockedReason: null }) }],
      usage: { input: 10, output: 2 },
    },
  });
  out({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 10, output: 2 } }, toolResults: [] });
  out({ type: "agent_end", messages: [] });
  settled = true;
  out({ type: "agent_settled" });
}

function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      record("get_state");
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: !settled } });
      return;

    case "prompt": {
      record("prompt", cmd.message);
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      if (MODE === "long") {
        settled = false;
        out({ type: "agent_start" });
        out({ type: "turn_start" });
        // Hang here: the turn is genuinely in flight until a steer arrives.
        out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 600" } });
        return;
      }
      if (MODE === "latesteer" && steerQueue.length > 0) {
        // The drain prompt: pi injects its OWN queued text, exactly as the real one does.
        const msg = steerQueue.shift();
        out({ type: "agent_start" });
        out({ type: "turn_start" });
        out({ type: "message_start", message: { role: "user", content: msg } });
        out({ type: "message_end", message: { role: "user", content: msg } });
        out({ type: "queue_update", steering: [], followUp: [] });
        out({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ status: "complete", summary: `DRAINED: ${msg}`, filesChanged: [], checksRun: [], blockedReason: null }) }],
            usage: { input: 10, output: 2 },
          },
        });
        out({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 10, output: 2 } }, toolResults: [] });
        out({ type: "agent_end", messages: [] });
        settled = true;
        out({ type: "agent_settled" });
        return;
      }
      if (MODE === "latesteer") {
        settled = false;
        out({ type: "agent_start" });
        out({ type: "turn_start" });
        out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 600" } });
        return;
      }
      runQuickTurn(cmd.message);
      return;
    }

    case "steer":
      record("steer", cmd.message);
      steerQueue.push(cmd.message);
      out({ type: "queue_update", steering: [...steerQueue], followUp: [] });
      out({ id: cmd.id, type: "response", command: "steer", success: true });
      if (MODE === "long") applySteerAndSettle();
      else if (MODE === "latesteer") {
        // The race: the run ends with the steer still queued and undrained.
        out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
        out({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 10, output: 1 } }, toolResults: [] });
        out({ type: "agent_end", messages: [] });
        settled = true;
        out({ type: "agent_settled" });
      }
      return;

    case "abort":
      record("abort");
      out({ id: cmd.id, type: "response", command: "abort", success: true });
      return;

    default:
      record(String(cmd.type));
      out({ id: cmd.id, type: "response", command: String(cmd.type), success: false, error: `Unknown command: ${cmd.type}` });
  }
}

// Strict JSONL on stdin, LF-delimited (pi's own framing rule).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      out({ type: "response", command: "parse", success: false, error: "bad json" });
    }
  }
});
// Closing stdin is pi's clean-shutdown trigger; mirror it so the driver's teardown path is real.
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1 << 30); // stay alive between commands
