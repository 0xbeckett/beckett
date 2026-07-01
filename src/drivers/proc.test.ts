/**
 * Tests for the shared driver process helpers (`src/drivers/proc.ts`): the generous, configurable
 * backstop wall-clock cap and the process-group launch/kill wrapping (OPS-50).
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import { hardCapSeconds, wrapProcessGroup, killGroup } from "./proc.ts";

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
  test("wraps the command so the child leads its own process group (setsid available here)", () => {
    const { cmd, groupKill } = wrapProcessGroup("claude", ["-p", "--verbose"]);
    // setsid is present on the target (Linux); the harness runs under it as a group leader.
    expect(groupKill).toBe(true);
    expect(cmd.at(-3)).toBe("claude");
    expect(cmd.slice(-2)).toEqual(["-p", "--verbose"]);
    expect(cmd[0]).toContain("setsid");
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
