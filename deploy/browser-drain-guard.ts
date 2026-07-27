#!/usr/bin/env bun
/**
 * Deploy preflight for the daemon's volatile browser lease.
 *
 * This runs against the OLD, still-serving daemon immediately before systemctl restart. A live
 * browser task cannot be resumed safely after its Claude/browser session dies, so wait a finite
 * amount and then fail closed with the run id rather than silently eating routine work.
 */

import { waitForBrowserDrain, type BrowserRunForDrain } from "../src/deploy/browser-drain.ts";

const MAX_WAIT_SECS = 10 * 60;
const DEFAULT_WAIT_SECS = 120;

function waitSeconds(): number {
  const raw = process.env.BECKETT_BROWSER_DRAIN_WAIT_SECS;
  if (!raw) return DEFAULT_WAIT_SECS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("BECKETT_BROWSER_DRAIN_WAIT_SECS must be a non-negative number");
  }
  // An environment typo must not turn a deploy into an unbounded wait.
  return Math.min(Math.floor(value), MAX_WAIT_SECS);
}

function describe(run: BrowserRunForDrain): string {
  const ageSecs = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1_000));
  return `${run.runId} (${run.state}, age ${ageSecs}s)`;
}

async function browserStatus(): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "src/cli/beckett.ts", "browser", "status"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`could not read browser status from the running daemon: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("could not parse browser status from the running daemon");
  }
}

async function main(): Promise<void> {
  const seconds = waitSeconds();
  const result = await waitForBrowserDrain({
    status: browserStatus,
    waitMs: seconds * 1_000,
    onWaiting: (runs, remainingMs) => {
      const remainingSecs = Math.ceil(remainingMs / 1_000);
      console.log(
        `== deploy preflight: waiting for live browser run(s) ${runs.map(describe).join(", ")}; ` +
          `${remainingSecs}s remain before this deploy refuses to restart ==`,
      );
    },
  });
  if (result.drained) {
    console.log("== deploy preflight: browser lease is idle; safe to restart ==");
    return;
  }
  throw new Error(
    `refusing to restart with live browser run(s): ${result.runs.map(describe).join(", ")}. ` +
      "Wait for the run to finish or stop it deliberately, then deploy again.",
  );
}

main().catch((error) => {
  console.error(`FATAL: browser deploy preflight: ${(error as Error).message}`);
  process.exitCode = 1;
});
