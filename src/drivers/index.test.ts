/**
 * Beckett — driver registry tests (`src/drivers/index.test.ts`)
 * =======================================================================================
 * Locks in the single-source-of-truth property (issue #145): the factory AND the preflight for a
 * harness live in ONE registry row, and harness validity is decided by that registry rather than a
 * hand-synced enum. If someone re-splits preflight into a separate switch, or hardcodes the trio
 * again, these break.
 */

import { describe, expect, test } from "bun:test";
import {
  availableHarnesses,
  createDriver,
  getDriverFactory,
  hasDriver,
  isRegisteredHarness,
  preflightFor,
} from "./index.ts";
import { defaultConfig } from "../capability/index.ts";

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
