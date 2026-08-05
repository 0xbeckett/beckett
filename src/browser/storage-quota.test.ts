import { expect, test } from "bun:test";
import {
  HOST_FREE_SPACE_RESERVE_BYTES,
  LANE_STORAGE_BYTES,
  MIN_LANE_STORAGE_BYTES,
  laneStorageQuotaMib,
  resolveLaneStorageBytes,
} from "./storage-quota.ts";

const GiB = 1024 * 1024 * 1024;

/** statfs stub reporting `freeBytes` available in 4 KiB blocks, as Linux does. */
function statfsWith(freeBytes: number) {
  return () => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096) });
}

test("a roomy host gets the full lane budget, not the whole disk", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(400 * GiB) });
  expect(bytes).toBe(LANE_STORAGE_BYTES);
  // The ticket's bar: at least 20 GB reported on a host with >100 GB free.
  expect(bytes).toBeGreaterThanOrEqual(20 * 1000 * 1000 * 1000);
});

test("a tight host is told the truth, less the host reserve", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(20 * GiB) });
  expect(bytes).toBe(20 * GiB - HOST_FREE_SPACE_RESERVE_BYTES);
  expect(bytes).toBeLessThan(LANE_STORAGE_BYTES);
});

test("a nearly full host still leaves the lane a working floor", () => {
  const bytes = resolveLaneStorageBytes({ profileDir: "/anything", statfs: statfsWith(1024) });
  // A zero-byte budget becomes a zero-byte RLIMIT_FSIZE, which stops Chromium writing
  // its own profile. The filesystem reports ENOSPC on its own terms instead.
  expect(bytes).toBe(MIN_LANE_STORAGE_BYTES);
});

test("an unprobeable filesystem falls back to the floor, never the ceiling", () => {
  const bytes = resolveLaneStorageBytes({
    profileDir: "/anything",
    statfs: () => { throw new Error("ENOENT"); },
  });
  expect(bytes).toBe(MIN_LANE_STORAGE_BYTES);
});

test("an explicit budget below the floor still binds", () => {
  const bytes = resolveLaneStorageBytes({
    profileDir: "/anything",
    budgetBytes: 4 * 1024 * 1024,
    statfs: statfsWith(400 * GiB),
  });
  expect(bytes).toBe(4 * 1024 * 1024);
});

test("the switch value is whole mebibytes and never zero", () => {
  expect(laneStorageQuotaMib(LANE_STORAGE_BYTES)).toBe(32 * 1024);
  expect(laneStorageQuotaMib(3 * 1024 * 1024 + 700)).toBe(3);
  expect(laneStorageQuotaMib(0)).toBe(1);
});
