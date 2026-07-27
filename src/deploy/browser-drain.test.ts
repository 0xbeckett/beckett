import { expect, test } from "bun:test";
import { restartBlockingBrowserRuns, waitForBrowserDrain } from "./browser-drain.ts";

const statusWith = (runs: unknown[]) => ({ running: 1, waiting: 0, queued: 0, runs });

test("deploy shutdown preflight visibly waits, then refuses a mid-run browser task at its bounded deadline", async () => {
  let clock = 1_000;
  const waits: string[] = [];
  const run = { runId: "9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6", state: "running", startedAt: 0 };

  // This is the deploy-time shutdown case: status keeps reporting the task that would otherwise
  // be killed by systemctl restart. A finite deadline returns that exact run to the caller.
  const result = await waitForBrowserDrain({
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
  // The wait cannot depend on a task eventually completing.
  expect(clock).toBe(1_020);
});

test("the preflight accepts CLI status data directly and blocks every state shutdown would cancel", () => {
  const queued = { runId: "queued-run", state: "queued", startedAt: 1 };
  const waiting = { runId: "waiting-run", state: "waiting", startedAt: 2 };
  const finished = { runId: "finished-run", state: "done", startedAt: 3 };

  // `beckett browser status` prints its bus data directly, not a `{ data }` envelope.
  expect(restartBlockingBrowserRuns(statusWith([queued, waiting, finished]))).toEqual([queued, waiting]);
  // Keep direct bus consumers compatible too.
  expect(restartBlockingBrowserRuns({ data: statusWith([queued]) })).toEqual([queued]);
});

test("a deploy proceeds immediately once status says browser work is drained", async () => {
  const result = await waitForBrowserDrain({
    status: async () => statusWith([{ runId: "done", state: "done", startedAt: 1 }]),
    waitMs: 60_000,
  });
  expect(result).toEqual({ drained: true, runs: [] });
});
