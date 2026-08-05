import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchEventBus, formatDispatchEvent, formatDispatchTrace, readDispatchEvents } from "./events.ts";

describe("DispatchEventBus", () => {
  test("persists before asynchronously invoking a failed live sink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-events-"));
    const path = join(dir, "dispatch.jsonl");
    let persistedWhenSinkRan = false;
    const bus = new DispatchEventBus({
      path,
      liveSink: () => {
        persistedWhenSinkRan = readFileSync(path, "utf8").includes('"ticketId":"ticket-1"');
        throw new Error("Discord unavailable");
      },
      onSinkError: () => {},
    });
    try {
      const event = bus.emit({ ticketId: "ticket-1", ticketRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement", outcome: "started" });
      expect(event.elapsedMs).toBe(0);
      expect(readDispatchEvents(path, "OPS-1")).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(persistedWhenSinkRan).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trace is ordered and failures render as an unmistakable alert", () => {
    const events = [
      { ts: "2026-01-01T00:00:00.000Z", ticketId: "ticket-1", ticketRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement", outcome: "started" as const, elapsedMs: 0 },
      { ts: "2026-01-01T00:10:00.000Z", ticketId: "ticket-1", ticketRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement:timeout", outcome: "failed" as const, elapsedMs: 600000, error: "worker hard-cap timeout" },
    ];
    expect(formatDispatchEvent(events[1]!)).toContain("🚨 ALERT");
    expect(formatDispatchTrace(events, "OPS-1")).toContain("implement:timeout");
  });

  // #4: the channel gets the digest; `beckett ticket trace` keeps the whole forensic row —
  // including what a restart-killed worker was saying when the daemon took it down.
  test("an interrupted run keeps its full detail in the trace without an alert", () => {
    const event = {
      ts: "2026-01-01T00:22:04.000Z",
      ticketId: "ticket-1",
      ticketRef: "#2.1",
      branchRef: "beckett/task-2-1",
      stage: "implement",
      outcome: "interrupted" as const,
      elapsedMs: 1_324_000,
      message: "worker exited with error (stopped by a daemon restart)",
      error: "I'll start by getting oriented in the repo.",
    };
    const line = formatDispatchEvent(event);
    expect(line).not.toContain("ALERT");
    expect(line).toContain("INTERRUPTED");
    expect(line).toContain("getting oriented");
  });
});
