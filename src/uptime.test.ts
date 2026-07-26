import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLifecycleLedger, readUptime, recordBoot, recordCleanShutdown, uptimeLedgerPath } from "./uptime.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-uptime-"));
  dirs.push(dir);
  return uptimeLedgerPath(dir);
}

test("boot and clean shutdown append a durable lifecycle ledger and derive downtime", () => {
  const path = ledger();
  recordBoot(path, 1_000);
  recordCleanShutdown(path, 5_000);
  recordBoot(path, 8_000);
  expect(readLifecycleLedger(path).map((event) => event.kind)).toEqual(["boot", "clean_shutdown", "boot"]);
  expect(readUptime(path, 10_000)).toMatchObject({
    currentUptimeMs: 2_000,
    downtimeHistory: "recorded",
    totalDowntimeMs: 3_000,
    downtimeWindows: [{ durationMs: 3_000 }],
  });
});

test("first boot has no downtime history, while a paired zero interval is distinct", () => {
  const path = ledger();
  recordBoot(path, 1_000);
  expect(readUptime(path, 2_000)).toMatchObject({
    downtimeHistory: "no-history",
    downtimeMessage: "no downtime history recorded yet",
    totalDowntimeMs: null,
  });
  recordCleanShutdown(path, 3_000);
  recordBoot(path, 3_000);
  expect(readUptime(path, 4_000)).toMatchObject({
    downtimeHistory: "zero",
    downtimeMessage: "zero downtime",
    totalDowntimeMs: 0,
  });
});

test("a boot without a preceding clean shutdown is recorded as an unclean restart", () => {
  const path = ledger();
  recordBoot(path, 1_000);
  recordBoot(path, 9_000);
  expect(readLifecycleLedger(path).map((event) => event.kind)).toEqual(["boot", "unclean_restart", "boot"]);
  expect(readUptime(path, 10_000)).toMatchObject({
    downtimeHistory: "no-history",
    uncleanRestarts: 1,
    currentUptimeMs: 1_000,
  });
});
