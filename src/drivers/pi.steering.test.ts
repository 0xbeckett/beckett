/**
 * Beckett — PiDriver live-steering / cancel coverage (`src/drivers/pi.steering.test.ts`)
 * =======================================================================================
 * The issue-#122 tests. `pi.test.ts` drives the parser with synthetic lines; these drive the
 * WHOLE driver through a REAL spawn of a scripted fake pi (`fixtures/fake-pi.mjs`) — real process,
 * real stdin command channel, real setsid process group — because the claims being made here are
 * about process behaviour, and a parser test cannot falsify any of them:
 *
 *   1. MID-TURN STEER — a nudge delivered while a turn is in flight reaches the model in the SAME
 *      process, at the next turn boundary, with no relaunch and no lost work. The old one-shot
 *      driver answered `will-restart` and made the human wait out the whole run.
 *   2. CANCEL MID-TURN — an abort kills the worker promptly AND sweeps the descendants pi forked.
 *      We have a history of workers leaving strays, so the test forks one on purpose and checks.
 *   3. NO DUPLICATE NUDGE — steering is drained by exactly one consumer. A nudge carried into a
 *      resume prompt is never replayed by a later resume, and a nudge delivered live is never
 *      also buffered.
 *   4. THE SETTLE RACE — a steer that lands in the same instant a run settles is still applied,
 *      exactly once, by re-prompting so pi drains its OWN queue (we never re-send the words).
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDriver } from "./pi.ts";
import type { Config, SpawnSpec, WorkerEvent } from "../types.ts";

const FAKE_PI = join(import.meta.dir, "fixtures/fake-pi.mjs");

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** Everything the fixture needs torn down after each test (temp HOME, workspace, live driver). */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0, cleanups.length)) await c();
});

/**
 * A driver wired to the fake pi. The temp HOME carries the `~/.pi/agent/auth.json` the REAL
 * preflight demands, so `spawn()` runs its production path end to end rather than a shortcut.
 */
function fixture(mode: "quick" | "long" | "latesteer", opts: { orphan?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-pi-steer-"));
  const workspace = join(dir, "work");
  mkdirSync(workspace, { recursive: true });
  const authDir = join(dir, ".pi/agent");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), '{"openai-codex":{}}\n', "utf8");
  const cmdLog = join(dir, "commands.log");
  writeFileSync(cmdLog, "", "utf8");
  chmodSync(FAKE_PI, 0o755);

  const oldHome = process.env.HOME;
  const oldMode = process.env.FAKE_PI_MODE;
  const oldLog = process.env.FAKE_PI_LOG;
  const oldOrphan = process.env.FAKE_PI_ORPHAN;
  process.env.HOME = dir;
  process.env.FAKE_PI_MODE = mode;
  process.env.FAKE_PI_LOG = cmdLog;
  if (opts.orphan) process.env.FAKE_PI_ORPHAN = "1";
  else delete process.env.FAKE_PI_ORPHAN;

  const config = {
    harness: {
      pi: { enabled: true, bin: FAKE_PI, default_provider: "openai-codex", default_model: "fake-model", thinking: "high" },
    },
    supervise: { worker_hard_cap_s: 3600 },
  } as unknown as Config;

  const events: WorkerEvent[] = [];
  const driver = new PiDriver(config, quietLog);
  driver.onEvent((e) => events.push(e));

  const restoreEnv = () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldMode === undefined) delete process.env.FAKE_PI_MODE;
    else process.env.FAKE_PI_MODE = oldMode;
    if (oldLog === undefined) delete process.env.FAKE_PI_LOG;
    else process.env.FAKE_PI_LOG = oldLog;
    if (oldOrphan === undefined) delete process.env.FAKE_PI_ORPHAN;
    else process.env.FAKE_PI_ORPHAN = oldOrphan;
  };
  cleanups.push(async () => {
    await driver.abort("test cleanup").catch(() => {});
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  });

  const spec: SpawnSpec = {
    workerId: "w-1",
    prompt: "THE TASK",
    systemAppend: "SCOPE",
    workspace,
    scope: { allow: [], deny: [] },
    envelope: { effort: "high" },
    model: "fake-model",
  } as unknown as SpawnSpec;

  /** What pi actually received, in order — `<command>:<message>`. */
  const commands = () => readFileSync(cmdLog, "utf8").split("\n").filter(Boolean);

  return { driver, events, spec, commands, workspace };
}

/** Poll until `cond` holds or the budget runs out (the driver is event-driven, not awaitable). */
async function until(cond: () => boolean, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// =======================================================================================
// 1 — MID-TURN STEER
// =======================================================================================

test("#122: a nudge sent mid-turn reaches the SAME running pi and is applied without a relaunch", async () => {
  const { driver, events, spec, commands } = fixture("long");
  const { pid } = await driver.spawn(spec);

  // The worker is genuinely mid-turn: pi is sitting inside a tool call it has not ended.
  expect(await until(() => events.some((e) => e.kind === "tool_call"))).toBe(true);
  expect(events.some((e) => e.kind === "finished")).toBe(false);

  const receipt = await driver.sendNudge("STOP — do the other thing instead");

  // `delivered`, not `will-restart`: it rode the live channel into the running process.
  expect(receipt.accepted).toBe("delivered");
  // pi received it as a `steer` on the SAME process — no second spawn, no lost turn.
  expect(commands()).toContain("steer:STOP — do the other thing instead");
  expect(commands().filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:THE TASK"]);
  expect(pid).toBeGreaterThan(0);

  // And the model saw it: the run's own result echoes the steered text back.
  expect(await until(() => events.some((e) => e.kind === "finished"))).toBe(true);
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    structuredOutput: { summary: string } | null;
  };
  expect(fin.status).toBe("success");
  expect(fin.structuredOutput?.summary).toBe("APPLIED: STOP — do the other thing instead");

  // Nothing was left buffered — a delivered nudge must not ALSO sit in the resume buffer.
  expect(driver.drainUnappliedNudges()).toEqual([]);
});

test("#122: the mid-turn nudge is applied exactly once even when two arrive back to back", async () => {
  const { driver, events, spec, commands } = fixture("long");
  await driver.spawn(spec);
  expect(await until(() => events.some((e) => e.kind === "tool_call"))).toBe(true);

  await driver.sendNudge("first correction");
  expect(await until(() => events.some((e) => e.kind === "finished"))).toBe(true);

  // Exactly one `steer` for one nudge — the driver must not re-send on the settle path.
  expect(commands().filter((c) => c === "steer:first correction")).toHaveLength(1);
  expect(driver.drainUnappliedNudges()).toEqual([]);
});

// =======================================================================================
// 2 — CANCEL MID-TURN
// =======================================================================================

test("#122: cancelling mid-turn kills pi promptly and leaves NO orphan process behind", async () => {
  const { driver, events, spec, commands } = fixture("long", { orphan: true });
  const { pid } = await driver.spawn(spec);

  expect(await until(() => events.some((e) => e.kind === "tool_call"))).toBe(true);
  // The descendant pi forked — exactly the thing a leader-only kill would strand.
  const orphanLine = commands().find((c) => c.startsWith("orphan:"));
  expect(orphanLine).toBeDefined();
  const orphanPid = Number(orphanLine!.slice("orphan:".length));
  expect(alive(orphanPid)).toBe(true);
  expect(alive(pid)).toBe(true);

  const startedAt = Date.now();
  await driver.abort("cancelled by test");
  const elapsed = Date.now() - startedAt;

  // Prompt: the abort resolves well inside the SIGTERM→SIGKILL grace, not after a long wait.
  expect(elapsed).toBeLessThan(6000);
  // pi was ASKED to abort the in-flight turn before the signal, not just shot.
  expect(commands()).toContain("abort:");
  // Both the leader AND its descendant are gone.
  expect(await until(() => !alive(pid))).toBe(true);
  expect(await until(() => !alive(orphanPid))).toBe(true);
  expect(driver.state).toBe("aborted");
});

test("#122: a nudge after cancel is reported dropped, never silently swallowed", async () => {
  const { driver, events, spec } = fixture("long");
  await driver.spawn(spec);
  expect(await until(() => events.some((e) => e.kind === "tool_call"))).toBe(true);

  await driver.abort("cancelled by test");
  const receipt = await driver.sendNudge("too late");
  expect(receipt.accepted).toBe("dropped");
});

// =======================================================================================
// 3 — NO DUPLICATE NUDGE
// =======================================================================================

test("#122: a nudge buffered while pi is down rides exactly ONE resume, never a second", async () => {
  const { driver, events, spec, commands } = fixture("quick");
  await driver.spawn(spec);
  // Let the run settle so the process is genuinely gone — the state a nudge gets buffered in.
  expect(await until(() => events.some((e) => e.kind === "finished"))).toBe(true);

  const priv = driver as unknown as { bufferedNudges: string[]; finished: boolean };
  const receipt = await driver.sendNudge("apply this correction");
  // Nothing is live to take it, so it buffers rather than claiming a delivery that cannot happen.
  expect(receipt.accepted).toBe("dropped"); // after a terminal finish, honestly dropped

  // The crash-recovery path: the worker is re-attached and the buffered steering must ride along.
  priv.bufferedNudges.push("apply this correction");
  priv.finished = false;
  await driver.resume();

  // resume() resolves on the handshake; the prompt write reaches the child a beat later.
  expect(await until(() => commands().includes("prompt:apply this correction"))).toBe(true);
  const afterFirst = commands().filter((c) => c.startsWith("prompt:"));
  expect(afterFirst).toContain("prompt:apply this correction");
  expect(afterFirst.filter((c) => c === "prompt:apply this correction")).toHaveLength(1);
  // The buffer is drained, not read — nothing is left to replay.
  expect(priv.bufferedNudges).toEqual([]);

  // A SECOND resume must fall back to the generic continue, not repeat the human's words.
  expect(await until(() => events.filter((e) => e.kind === "finished").length >= 2)).toBe(true);
  priv.finished = false;
  await driver.resume();
  expect(await until(() => commands().some((c) => c.startsWith("prompt:Please continue")))).toBe(true);

  const afterSecond = commands().filter((c) => c.startsWith("prompt:"));
  expect(afterSecond.filter((c) => c === "prompt:apply this correction")).toHaveLength(1);
  expect(afterSecond[afterSecond.length - 1]).toBe("prompt:Please continue from where you left off.");
});

test("#122: drainUnappliedNudges hands a buffered nudge over exactly once", () => {
  const driver = new PiDriver({ harness: { pi: { bin: "pi" } } } as unknown as Config, quietLog);
  const priv = driver as unknown as { bufferedNudges: string[] };
  priv.bufferedNudges.push("never applied");
  expect(driver.drainUnappliedNudges()).toEqual(["never applied"]);
  expect(driver.drainUnappliedNudges()).toEqual([]);
});

// =======================================================================================
// 4 — THE SETTLE RACE
// =======================================================================================

test("#122: a steer that lands as the run settles is drained, not finished on top of", async () => {
  const { driver, events, spec, commands } = fixture("latesteer");
  await driver.spawn(spec);
  expect(await until(() => events.some((e) => e.kind === "tool_call"))).toBe(true);

  // This fake settles the run WITH the steer still queued — the exact race the guard exists for.
  const receipt = await driver.sendNudge("late correction");
  expect(receipt.accepted).toBe("delivered");

  expect(await until(() => events.some((e) => e.kind === "finished"))).toBe(true);
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    structuredOutput: { summary: string } | null;
  };
  // The nudge was applied, in-process, rather than lost to a premature success finish.
  expect(fin.status).toBe("success");
  expect(fin.structuredOutput?.summary).toBe("DRAINED: late correction");

  // Critically: the driver re-prompted to WAKE pi's own queue, it did not re-send the human's
  // words. Exactly one `steer` carries the text; the drain prompt carries the generic continue.
  const cmds = commands();
  expect(cmds.filter((c) => c === "steer:late correction")).toHaveLength(1);
  expect(cmds.filter((c) => c === "prompt:late correction")).toHaveLength(0);
  expect(cmds.filter((c) => c === "prompt:Please continue from where you left off.")).toHaveLength(1);
});
