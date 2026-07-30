/**
 * Beckett — harness cooldown store tests (`src/drivers/cooldown.ts`, #133)
 * =======================================================================================
 * Locks in the persisted-cooldown lifecycle: set on a rate-limit death, live-then-expired by the
 * clock, cleared explicitly, and tolerant of a missing/corrupt ledger. The BECKETT_DIR override
 * relocates the whole `~/.beckett` layout into a scratch dir so these never touch the real box.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import {
  activeCooldown,
  clearCooldown,
  recordCooldown,
  DEFAULT_COOLDOWN_MS,
} from "./cooldown.ts";

const config = defaultConfig();
let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-cooldown-"));
  prevDir = process.env.BECKETT_DIR;
  process.env.BECKETT_DIR = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("harness cooldown store", () => {
  test("no cooldown recorded → activeCooldown is null", () => {
    expect(activeCooldown("pi", config)).toBeNull();
  });

  test("recordCooldown persists a rate_limit cooldown with a default expiry", () => {
    const now = 1_000_000;
    const rec = recordCooldown("pi", config, { now });
    expect(rec.reason).toBe("rate_limit");
    expect(rec.until).toBe(now + DEFAULT_COOLDOWN_MS);
    expect(rec.at).toBe(now);

    // Persisted to disk under beckettDir, not just in memory.
    const onDisk = JSON.parse(readFileSync(join(dir, "harness-cooldowns.json"), "utf8"));
    expect(onDisk.pi.until).toBe(now + DEFAULT_COOLDOWN_MS);
  });

  test("a live cooldown is returned; an expired one is treated as gone", () => {
    const now = 1_000_000;
    recordCooldown("pi", config, { now, durationMs: 1000 });
    expect(activeCooldown("pi", config, now + 500)?.until).toBe(now + 1000);
    // At/after `until` it is no longer live — the quota window has passed.
    expect(activeCooldown("pi", config, now + 1000)).toBeNull();
    expect(activeCooldown("pi", config, now + 5000)).toBeNull();
  });

  test("a cooldown is scoped to its own harness", () => {
    const now = 1_000_000;
    recordCooldown("pi", config, { now });
    expect(activeCooldown("pi", config, now)).not.toBeNull();
    expect(activeCooldown("codex", config, now)).toBeNull();
  });

  test("clearCooldown removes a live record and reports whether it did anything", () => {
    const now = 1_000_000;
    recordCooldown("pi", config, { now });
    expect(clearCooldown("pi", config)).toBe(true);
    expect(activeCooldown("pi", config, now)).toBeNull();
    // A second clear is a no-op (nothing to remove).
    expect(clearCooldown("pi", config)).toBe(false);
  });

  test("a corrupt ledger reads as empty rather than throwing", () => {
    writeFileSync(join(dir, "harness-cooldowns.json"), "{ not json");
    expect(activeCooldown("pi", config)).toBeNull();
    // And a fresh record overwrites the garbage cleanly.
    const rec = recordCooldown("pi", config, { now: 2_000 });
    expect(activeCooldown("pi", config, 2_500)?.until).toBe(rec.until);
  });
});
