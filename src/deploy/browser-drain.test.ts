import { expect, test } from "bun:test";
import { liveBrowserRuns, waitForBrowserDrain } from "./browser-drain.ts";

const statusWith = (runs: unknown[]) => ({ data: { running: 1, waiting: 0, queued: 0, runs } });

test("deploy shutdown preflight waits visibly, then refuses an in-flight browser run at a bounded deadline", async () => {
  let clock = 1_000;
  const waits: string[] = [];
  const run = { runId: "9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6", state: "running", startedAt: 0 };

  const result = await waitForBrowserDrain({
    // Simulates the daemon still reporting the same browser run while a deploy is about to
    // shut it down. The restart must be refused instead of calling systemctl beneath it.
    status: async () => statusWith([run]),
    waitMs: 20,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onWaiting: (runs, remaining) => waits.push(`${runs[0]!.runId}:${remaining}`),
  });

  expect(result).toEqual({ drained: false, runs: [run] });
  expect(waits).toEqual([
    "9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6:20",
    "9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6:10",
  ]);
  // The deadline is mathematical, not dependent on a process eventually completing.
  expect(clock).toBe(1_020);
});

test("only live leases block a deploy; durable queued work may restart and requeue", async () => {
  const queued = { runId: "queued-run", state: "queued", startedAt: 1 };
  expect(liveBrowserRuns(statusWith([queued]))).toEqual([]);

  const result = await waitForBrowserDrain({
    status: async () => statusWith([queued]),
    waitMs: 60_000,
  });
  expect(result).toEqual({ drained: true, runs: [] });
});
