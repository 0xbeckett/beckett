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

test("result handling closes stdin so a finished claude process can exit", () => {
  const events: WorkerEvent[] = [];
  let ended = 0;
  let closed = 0;
  const driver = new ClaudeDriver(config, quietLog) as unknown as {
    child: unknown;
    handleResult(obj: Record<string, unknown>): void;
    onEvent(cb: (e: WorkerEvent) => void): () => void;
  };
  driver.onEvent((e) => events.push(e));
  driver.child = {
    stdin: {
      end() {
        ended += 1;
      },
      close() {
        closed += 1;
      },
    },
  };

  driver.handleResult({ subtype: "success", structured_output: { status: "complete" } });

  expect(ended).toBe(1);
  expect(closed).toBe(1);
  expect(events.find((e) => e.kind === "finished")).toMatchObject({
    kind: "finished",
    status: "success",
    subtype: "success",
    structuredOutput: { status: "complete" },
  });
});
