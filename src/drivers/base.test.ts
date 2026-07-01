import { expect, test } from "bun:test";
import { OneShotDriver, DEFAULT_RESUME_PROMPT } from "./base.ts";
import type { Config, WorkerEvent, WorkerState } from "../types.ts";

const config = {
  harness: {},
  supervise: { worker_hard_cap_s: 3600 },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** Minimal concrete OneShotDriver — just enough to exercise the shared lifecycle. */
class TestDriver extends OneShotDriver {
  constructor() {
    super(config, quietLog, "driver.test");
  }
  protected harnessName(): string {
    return "test";
  }
  protected binName(): string {
    return "test-bin";
  }
  protected usdEstimate(): number | null {
    return null;
  }
  protected handleLine(_line: string): void {}
  protected buildResumeArgs(prompt: string): string[] {
    return ["resume", prompt];
  }
  protected resetParseState(): void {}
}

/** The private surface the tests reach into (same pattern as the per-driver tests). */
interface Guts {
  finished: boolean;
  workerState: WorkerState;
  childGen: number;
  stderrRing: { record(text: string): void };
  sendNudge(msg: string): Promise<{ accepted: string }>;
  takeBufferedPrompt(): string;
  onProcessExit(code: number, gen: number, pid: number, groupKill: boolean): Promise<void>;
  timeOut(capS: number, totalS: number): Promise<void>;
  onEvent(cb: (e: WorkerEvent) => void): () => void;
  getTelemetry(): { diffLines: { added: number; removed: number; files: number } };
}

function makeDriver(): Guts {
  return new TestDriver() as unknown as Guts;
}

// ── OneShotDriver steering (issue #19: honest receipts) ─────────────────────────

test("one-shot nudges buffer with an honest will-restart receipt and drain FIFO", async () => {
  const d = makeDriver();
  expect((await d.sendNudge("do X")).accepted).toBe("will-restart");
  expect((await d.sendNudge("do Y")).accepted).toBe("will-restart");
  expect(d.takeBufferedPrompt()).toBe("do X\n\ndo Y");
  // drained: the next take falls back to the generic continue instruction
  expect(d.takeBufferedPrompt()).toBe(DEFAULT_RESUME_PROMPT);
});

test("a nudge after the terminal finish is dropped, never silently eaten", async () => {
  const d = makeDriver();
  d.finished = true;
  expect((await d.sendNudge("too late")).accepted).toBe("dropped");
  expect(d.takeBufferedPrompt()).toBe(DEFAULT_RESUME_PROMPT); // nothing was buffered
});

// ── BaseDriver exit handling (crash path + gen guard) ───────────────────────────

test("a crash exit synthesizes a classified error finish carrying the stderr tail", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.stderrRing.record("Error: not logged in — please run login");

  await d.onProcessExit(1, d.childGen, 12345, /*groupKill*/ false);

  const finished = events.find((e) => e.kind === "finished");
  expect(finished).toBeDefined();
  if (finished?.kind !== "finished") throw new Error("unreachable");
  expect(finished.status).toBe("error");
  expect(finished.subtype).toBe("error_process_exit");
  expect(finished.errorClass).toBe("auth"); // classified off the stderr tail (issue #17)
  const error = events.find((e) => e.kind === "error");
  if (error?.kind !== "error") throw new Error("no error event");
  expect(error.message).toContain("not logged in");
  expect(d.workerState as WorkerState).toBe("failed");
  expect(d.finished).toBe(true);
});

test("a superseded child's exit is ignored (childGen guard — auto-resume relaunch)", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.childGen = 2;

  await d.onProcessExit(1, /*stale gen*/ 1, 12345, /*groupKill*/ false);

  expect(events).toHaveLength(0);
  expect(d.workerState).toBe("running");
  expect(d.finished).toBe(false);
});

test("an exit after a terminal finish does not double-emit", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.finished = true;
  d.workerState = "failed";

  await d.onProcessExit(0, d.childGen, 12345, false);

  expect(events.filter((e) => e.kind === "finished")).toHaveLength(0);
});

// ── wall-clock backstop ──────────────────────────────────────────────────────────

test("the hard-cap timeout emits a graceful error_wall_clock_cap finish", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));

  await d.timeOut(3600, 3700);

  const finished = events.find((e) => e.kind === "finished");
  if (finished?.kind !== "finished") throw new Error("no finished event");
  expect(finished.subtype).toBe("error_wall_clock_cap");
  expect(finished.errorClass).toBe("timeout");
  expect(d.workerState).toBe("aborted");
});

// ── telemetry ────────────────────────────────────────────────────────────────────

test("telemetry diff sizing is zero-safe with no workspace (never throws)", () => {
  const d = makeDriver();
  expect(d.getTelemetry().diffLines).toEqual({ added: 0, removed: 0, files: 0 });
});
