import { expect, test } from "bun:test";
import { createSystemMetricsReader, type NetdataFetch } from "./system-metrics.ts";

function response(value: unknown) {
  return { ok: true, json: async () => value };
}

const cpu = { labels: ["time", "user", "system", "iowait"], data: [[1, 10, 5, 2]] };
const ram = { labels: ["time", "free", "used", "cached", "buffers"], data: [[1, 100, 200, 300, 400]] };
const disk = { labels: ["time", "avail", "used", "reserved_for_root"], data: [[1, 2, 3, 1]] };

test("reads CPU, memory and disk from injected Netdata and caches one cycle", async () => {
  let clock = 10_000;
  let calls = 0;
  const fetch: NetdataFetch = async (url) => {
    calls++;
    if (url.includes("system.cpu")) return response(cpu);
    if (url.includes("system.ram")) return response(ram);
    if (url.includes("disk_space._")) return response(disk);
    throw new Error(`unexpected URL ${url}`);
  };
  const reader = createSystemMetricsReader({ fetch, now: () => clock, ttlMs: 60_000 });
  const first = await reader.read();
  const second = await reader.read();
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    source: "netdata",
    cpu: { loadPercent: 17 },
    memory: { usedBytes: 200 * 1024 * 1024, totalBytes: 1000 * 1024 * 1024 },
    disk: { usedBytes: 3 * 1024 * 1024 * 1024, totalBytes: 6 * 1024 * 1024 * 1024 },
  });
  expect(calls).toBe(3);
  clock += 59_999;
  await reader.read();
  expect(calls).toBe(3);
  clock += 1;
  await reader.read();
  expect(calls).toBe(6);
});

test("a timeout-bounded Netdata request also falls back to injected /proc reads", async () => {
  const reader = createSystemMetricsReader({
    fetch: () => new Promise(() => {}),
    timeoutMs: 5,
    now: () => 5_000,
    readFile: async (path) => path === "/proc/stat"
      ? "cpu  100 0 50 200 50 0 0 0 0 0\n"
      : "MemTotal:       1000 kB\nMemAvailable:    250 kB\n",
    statfs: async () => ({ bsize: 1024, blocks: 100, bfree: 25 }),
  });
  await expect(reader.read()).resolves.toMatchObject({
    source: "proc",
    cpu: { loadPercent: 37.5 },
    memory: { usedBytes: 750 * 1024, totalBytes: 1000 * 1024 },
    disk: { usedBytes: 75 * 1024, totalBytes: 100 * 1024 },
  });
});
