/**
 * Beckett — driver registry tests (`src/drivers/index.test.ts`)
 * =======================================================================================
 * Locks in the single-source-of-truth property (issue #145): the factory AND the preflight for a
 * harness live in ONE registry row, and harness validity is decided by that registry rather than a
 * hand-synced enum. If someone re-splits preflight into a separate switch, or hardcodes the trio
 * again, these break.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableHarnesses,
  createDriver,
  getDriverFactory,
  hasDriver,
  isRegisteredHarness,
  preflightFor,
} from "./index.ts";
import { activeCooldown, recordCooldown } from "./cooldown.ts";
import { defaultConfig } from "../config.ts";

describe("driver registry — single source of truth", () => {
  test("the three in-tree drivers are registered", () => {
    expect(availableHarnesses().sort()).toEqual(["claude", "codex", "pi"]);
    for (const h of ["claude", "codex", "pi"]) {
      expect(hasDriver(h)).toBe(true);
      expect(isRegisteredHarness(h)).toBe(true);
      expect(typeof getDriverFactory(h)).toBe("function");
    }
  });

  test("registry membership is an own-property check, not an enum or prototype key", () => {
    expect(isRegisteredHarness("gpt")).toBe(false);
    expect(isRegisteredHarness("constructor")).toBe(false);
    expect(isRegisteredHarness("toString")).toBe(false);
    expect(hasDriver("gpt")).toBe(false);
  });

  test("an unregistered harness fails loudly, listing the registered set", () => {
    expect(() => getDriverFactory("gpt")).toThrow(/no driver registered for harness "gpt"/);
    expect(() => createDriver("gpt", defaultConfig())).toThrow(/available: claude, codex, pi/);
  });

  test("preflight is served off the registry row (no separate switch)", async () => {
    // An unregistered harness has no preflight and reports exactly that — proving preflightFor
    // reads the same table getDriverFactory does, not a parallel hand-maintained switch.
    const pf = await preflightFor("gpt", defaultConfig());
    expect(pf.ok).toBe(false);
    expect(pf.problems.join(" ")).toMatch(/no driver registered for harness "gpt"/);
  });
});

// #133: a live rate-limit cooldown gates preflight BEFORE the binary/auth checks, so a
// quota-capped harness reports unusable (with its expiry) instead of passing preflight and dying
// on turn one. The BECKETT_DIR override relocates the state layout into a scratch dir.
describe("preflight — rate-limit cooldown gate (#133)", () => {
  const config = defaultConfig();
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beckett-preflight-cooldown-"));
    prevDir = process.env.BECKETT_DIR;
    process.env.BECKETT_DIR = dir;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.BECKETT_DIR;
    else process.env.BECKETT_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a live cooldown makes preflight report unusable with the expiry, no driver probe", async () => {
    const rec = recordCooldown("pi", config);
    // force:true skips the cache — the cooldown still fires because it gates ahead of the cache.
    const pf = await preflightFor("pi", config, { force: true });
    expect(pf.ok).toBe(false);
    expect(pf.cooledUntil).toBe(rec.until);
    expect(pf.problems.join(" ")).toMatch(/rate-limit cooldown until/);
  });

  test("an expired cooldown no longer gates preflight — pi is usable again", async () => {
    // Record a cooldown already in the past: the gate must NOT fire, so the result carries no
    // cooldown marker and the store no longer reports it live (self-heal on quota reset).
    recordCooldown("pi", config, { now: 1_000, durationMs: 1 });
    const pf = await preflightFor("pi", config, { force: true });
    expect(pf.cooledUntil).toBeUndefined();
    expect(activeCooldown("pi", config)).toBeNull();
  });
});
