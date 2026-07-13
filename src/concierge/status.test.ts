/**
 * `beckett status` bus command (issue #30): the Concierge merges the daemon-wide half from the
 * wired provider with the halves only it can see (Discord gateway, its session) — and still
 * answers usefully when no provider is wired (e.g. tests, partial boots).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { Config } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1234,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({ sessionId: "s-1", contextTokens: 55_000, rotations: 2, queueDepth: 0 }),
  } as unknown as ConciergeSession;
  return new Concierge({ config, session, gateway });
}

test("status merges the provider's daemon half with the Concierge's own", async () => {
  const concierge = harness();
  concierge.setStatusProvider(() => ({
    version: "3.5.0",
    uptimeSecs: 42,
    workers: [{ state: "live", ticket: "OPS-9" }],
  }));
  const res = await concierge.onBusRequest({ cmd: "status", args: {} });
  expect(res.ok).toBeTrue();
  const data = res.data as Record<string, any>;
  expect(data.version).toBe("3.5.0");
  expect(data.workers).toEqual([{ state: "live", ticket: "OPS-9" }]);
  expect(data.discord).toEqual({ connected: true, lastEventAgeMs: 1234 });
  // The concierge half is now the session POOL's shape (OPS-80 §9.3): per-scope session stats
  // under `perSession`, plus the shared turn-gate readout.
  expect(data.concierge.perSession.global.sessionId).toBe("s-1");
  expect(data.concierge.perSession.global.rotations).toBe(2);
  expect(data.concierge.turnGate.limit).toBeGreaterThanOrEqual(1);
});

test("status without a wired provider still answers with the Concierge-local half", async () => {
  const concierge = harness();
  const res = await concierge.onBusRequest({ cmd: "status", args: {} });
  expect(res.ok).toBeTrue();
  const data = res.data as Record<string, any>;
  expect(data.discord.connected).toBeTrue();
  expect(data.concierge.perSession.global.contextTokens).toBe(55_000);
});

test("a throwing provider is an honest error, not a crash", async () => {
  const concierge = harness();
  concierge.setStatusProvider(() => {
    throw new Error("dispatcher exploded");
  });
  const res = await concierge.onBusRequest({ cmd: "status", args: {} });
  expect(res.ok).toBeFalse();
  expect(res.error).toContain("dispatcher exploded");
});
