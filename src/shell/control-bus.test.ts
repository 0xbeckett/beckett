/**
 * Control-bus timeout semantics (issue #137). A bus timeout means the CLI STOPPED WAITING, never
 * that the daemon's work failed — a verb that kicks off background work (a browser run, a Discord
 * reply) may have been accepted, and may already have finished, by the time the client gives up. So
 * a timeout must render as an INDETERMINATE outcome that forbids a blind retry and names the command
 * that settles the true state — never a bare `error: control bus timeout` that reads as "it did not
 * happen" and invites the caller to double-dispatch.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBus, ControlBusTimeoutError, indeterminateBusTimeout, serveBus } from "./control-bus.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a background-starting verb whose daemon never answers in time rejects with a timeout, not a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-bus-timeout-"));
  dirs.push(dir);
  const socket = join(dir, "control.sock");
  // A daemon that ACCEPTED the dispatch and is still working on it — it just never answers before
  // the client's deadline. This is exactly the browser.run / discord.reply shape the ticket hit.
  const stop = serveBus(socket, () => new Promise(() => {}));
  try {
    const err = await callBus(socket, "browser.run", { task: "post the thing" }, 40).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ControlBusTimeoutError);
    expect((err as ControlBusTimeoutError).code).toBe("CONTROL_BUS_TIMEOUT");
    expect((err as ControlBusTimeoutError).timeoutMs).toBe(40);
  } finally {
    stop();
  }
});

test("the timeout renders as an INDETERMINATE outcome naming the check command, never a bare failure", () => {
  const err = new ControlBusTimeoutError(30_000);
  const message = indeterminateBusTimeout(err, "`beckett browser status`");

  // Reads as unknown-not-failed, and steers away from a retry that would double-dispatch.
  expect(message).toContain("INDETERMINATE");
  expect(message).toContain("NOT a failure");
  expect(message).toMatch(/do NOT retry/i);
  // Names the exact command that settles the real state.
  expect(message).toContain("`beckett browser status`");
  // Must NOT read as "it did not happen" — no bare timeout error string.
  expect(message).not.toMatch(/^control bus timeout/);
  expect(message).not.toContain("error: control bus timeout");
});
