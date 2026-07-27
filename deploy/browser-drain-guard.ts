#!/usr/bin/env bun
/**
 * Deploy preflight for the daemon's browser queue/lease.
 *
 * Run against the old daemon immediately before systemctl restart. It waits only a finite amount
 * of time and otherwise refuses, naming every run that would be cancelled by the restart.
 */

import { waitForBrowserDrain, type BrowserRunForDrain } from "../src/deploy/browser-drain.ts";

const DEFAULT_WAIT_SECS = 120;
const MAX_WAIT_SECS = 10 * 60;
const STATUS_TIMEOUT_MS = 35_000;

function waitSeconds(): number {
  const raw = process.env.BECKETT_BROWSER_DRAIN_WAIT_SECS;
  if (!raw) return DEFAULT_WAIT_SECS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("BECKETT_BROWSER_DRAIN_WAIT_SECS must be a non-negative number");
  }
  // An environment typo must never make deploy wait indefinitely.
  return Math.min(Math.floor(value), MAX_WAIT_SECS);
}

function describe(run: BrowserRunForDrain): string {
  const ageSecs = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1_000));
  return `${run.runId} (${run.state}, age ${ageSecs}s)`;
}

/** Read the old daemon's status with its own deadline so an unavailable bus fails closed. */
async function browserStatus(): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "src/cli/beckett.ts", "browser", "status"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((resolve) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        void child.exited.then(resolve);
      }, STATUS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (timedOut) {
    throw new Error(`browser status exceeded its ${Math.ceil(STATUS_TIMEOUT_MS / 1_000)}s deadline`);
  }
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
      console.log(
        `== deploy preflight: waiting for browser run(s) ${runs.map(describe).join(", ")}; ` +
          `${Math.ceil(remainingMs / 1_000)}s remain before restart is refused ==`,
      );
    },
  });
  if (result.drained) {
    console.log("== deploy preflight: browser runs are drained; safe to restart ==");
    return;
  }
  throw new Error(
    `refusing to restart with browser run(s): ${result.runs.map(describe).join(", ")}. ` +
      "Wait for them to finish or stop them deliberately, then deploy again.",
  );
}

main().catch((error) => {
  console.error(`FATAL: browser deploy preflight: ${(error as Error).message}`);
  process.exitCode = 1;
});
