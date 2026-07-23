/**
 * Tests for the shared driver process helpers (`src/drivers/proc.ts`): the generous, configurable
 * backstop wall-clock cap and the process-group launch/kill wrapping (OPS-50).
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import { hardCapSeconds, wrapProcessGroup, killGroup, killProcessTree } from "./proc.ts";

const cfgWith = (worker_hard_cap_s?: number): Config =>
  ({ supervise: worker_hard_cap_s === undefined ? {} : { worker_hard_cap_s } }) as unknown as Config;

describe("hardCapSeconds", () => {
  test("returns the configured value when generous (>= 30min)", () => {
    expect(hardCapSeconds(cfgWith(3600))).toBe(3600);
    expect(hardCapSeconds(cfgWith(1800))).toBe(1800);
    expect(hardCapSeconds(cfgWith(5400))).toBe(5400);
  });

  test("defaults to 3600s (60min) when unset", () => {
    expect(hardCapSeconds(cfgWith(undefined))).toBe(3600);
    expect(hardCapSeconds({} as unknown as Config)).toBe(3600);
  });

  test("floors a too-tight value so it can never be the old 600s guillotine", () => {
    expect(hardCapSeconds(cfgWith(600))).toBe(3600);
    expect(hardCapSeconds(cfgWith(60))).toBe(3600);
    expect(hardCapSeconds(cfgWith(1799))).toBe(3600);
  });
});

describe("wrapProcessGroup", () => {
  test.if(Bun.which("setsid") !== null)("wraps the command so the child leads its own process group", () => {
    const { cmd, groupKill } = wrapProcessGroup("claude", ["-p", "--verbose"]);
    // setsid is present on the target (Linux); the harness runs under it as a group leader.
    expect(groupKill).toBe(true);
    expect(cmd.at(-3)).toBe("claude");
    expect(cmd.slice(-2)).toEqual(["-p", "--verbose"]);
    expect(cmd[0]).toContain("setsid");
  });

  test.if(Bun.which("setsid") === null)("falls back to single-pid kill when setsid is unavailable", () => {
    const { cmd, groupKill } = wrapProcessGroup("claude", ["-p", "--verbose"]);
    expect(groupKill).toBe(false);
    expect(cmd).toEqual(["claude", "-p", "--verbose"]);
  });
});

describe("killGroup", () => {
  test("is a no-op for a non-group-leader child (never signals a shared group)", () => {
    // groupKill=false must NOT call process.kill(-pid) — that would hit the daemon's own group.
    expect(() => killGroup(999999, false)).not.toThrow();
  });

  test("swallows ESRCH for an already-gone group", () => {
    // A pid that owns no live group → process.kill throws ESRCH, which killGroup absorbs.
    expect(() => killGroup(2147480000, true)).not.toThrow();
  });

  test("ignores invalid pids (never signals pid 0/1 or negatives)", () => {
    expect(() => killGroup(0, true)).not.toThrow();
    expect(() => killGroup(1, true)).not.toThrow();
    expect(() => killGroup(-5, true)).not.toThrow();
  });
});

/**
 * The OPS-50 orphan bug, end-to-end: a wall-clock reap must kill the harness AND every descendant
 * it forked (bash-tool runs, MCP servers, sub-agents), not just the harness pid. This spawns a REAL
 * process tree the way {@link wrapProcessGroup} does at launch — a `setsid` group leader that forks a
 * long-lived `sleep` descendant — then reaps it via {@link killProcessTree} and proves, via live
 * `process.kill(pid, 0)` liveness probes, that the descendant does NOT survive as an orphan. Gated on
 * `setsid` (Linux target); on an image without it the group-kill path is unreachable so the test is a
 * no-op the runner reports as skipped.
 */
describe("killProcessTree (live process tree)", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };

  test.if(Bun.which("setsid") !== null)(
    "reaps the harness AND its forked descendant — no orphan survives the group kill",
    async () => {
      // A "harness" that forks a descendant (the long sleep) and then blocks — exactly the shape a
      // real worker leaves behind (harness + bash-tool/MCP child) when the wall-clock cap trips.
      const { cmd, groupKill } = wrapProcessGroup("bash", ["-c", "echo READY=$$; sleep 300 & echo CHILD=$!; wait"]);
      expect(groupKill).toBe(true);

      const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
      // Read stdout until the descendant announces its pid (or bail after a bounded window).
      const reader = child.stdout.getReader();
      const dec = new TextDecoder();
      let out = "";
      const deadline = Date.now() + 3000;
      while (!out.includes("CHILD=") && Date.now() < deadline) {
        const race = (await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 100)),
        ])) as { value: Uint8Array | undefined; done: boolean };
        if (race.value) out += dec.decode(race.value);
        if (race.done) break;
      }
      const harnessPid = child.pid;
      const descendantPid = Number((out.match(/CHILD=(\d+)/) ?? [])[1]);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(descendantPid).toBeGreaterThan(1);
      // Both are live before the reap, and the descendant shares the leader's process group.
      expect(alive(harnessPid)).toBe(true);
      expect(alive(descendantPid)).toBe(true);

      try {
        await killProcessTree(
          { pid: harnessPid, kill: (s) => child.kill(s as never), exited: child.exited },
          { groupKill, graceMs: 500 },
        );
        // SIGKILL delivery to the group is asynchronous — poll briefly for both to die.
        await waitDead(harnessPid, 2000);
        await waitDead(descendantPid, 2000);

        expect(alive(harnessPid)).toBe(false);
        // The crux of OPS-50: the descendant is gone too, NOT reparented to init still running.
        expect(alive(descendantPid)).toBe(false);
      } finally {
        // Belt-and-braces so a failed assertion never leaks a 5-minute sleep into the test host.
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
    },
  );
});
