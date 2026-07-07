/**
 * `beckett proactivity …` control-bus commands (OPS-67, §4.6): status readout, per-channel
 * `set`, the global kill switch, and the CODE-side owner gate on `auto` (proceed-on-silence).
 * The gate is enforced here, at the bus handler, never by the model.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { Config } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(): { concierge: Concierge; dir: string; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-proactivity-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const config = validateConfig({
    proactivity: { default_mode: "suggest", channels: { "111": "auto" } },
  });
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
  } as unknown as ConciergeSession;
  return { concierge: new Concierge({ config, session, gateway }), dir, config };
}

/** Fake a live owner (or non-owner) turn so the code-side gate has a speaker to check. */
function setActiveTurn(concierge: Concierge, isOwner: boolean): void {
  (concierge as unknown as { activeMention: unknown }).activeMention = {
    channelId: "999",
    messageId: "m-1",
    isOwner,
    repliedViaCli: false,
    ackMessageId: null,
    pendingTickets: [],
  };
}

test("status reports enabled=false by default, the default mode, caps, and configured channels", async () => {
  const { concierge } = harness();
  const res = await concierge.onBusRequest({ cmd: "proactivity.status", args: {} });
  expect(res.ok).toBeTrue();
  const data = res.data as Record<string, any>;
  expect(data.enabled).toBeFalse(); // ships OFF
  expect(data.defaultMode).toBe("suggest");
  expect(data.caps.triageThreshold).toBe(0.45);
  expect(data.caps.maxInterjectionsPerHour).toBe(4);
  // enabled=false → every channel resolves to "off" regardless of its override.
  expect(data.channels).toEqual([{ channelId: "111", mode: "auto", effective: "off" }]);
  expect(data.liveOffers).toEqual([]);
});

test("set writes the runtime override file and mutates the live config in place", async () => {
  const { concierge, dir, config } = harness();
  const res = await concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "222", mode: "suggest" },
  });
  expect(res.ok).toBeTrue();
  // Live in-memory config (the object the coordinator shares) reflects it immediately.
  expect(config.proactivity.channels["222"]).toBe("suggest");
  // Persisted to ~/.beckett/proactivity.json for restart durability.
  const override = JSON.parse(readFileSync(join(dir, "proactivity.json"), "utf8"));
  expect(override.channels["222"]).toBe("suggest");
});

test("the global kill switch flips runtime enabled=false and persists it", async () => {
  const { concierge, dir, config } = harness();
  config.proactivity.enabled = true; // pretend it was on
  const res = await concierge.onBusRequest({ cmd: "proactivity.off", args: {} });
  expect(res.ok).toBeTrue();
  expect(config.proactivity.enabled).toBeFalse();
  const override = JSON.parse(readFileSync(join(dir, "proactivity.json"), "utf8"));
  expect(override.enabled).toBeFalse();
});

test("set … auto is refused when the requesting turn's speaker is not the owner", async () => {
  const { concierge, dir, config } = harness();
  setActiveTurn(concierge, false); // a non-owner turn
  const res = await concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "333", mode: "auto" },
  });
  expect(res.ok).toBeFalse();
  expect(res.error).toContain("owner-only");
  // Refused → neither the live config nor the file changed.
  expect(config.proactivity.channels["333"]).toBeUndefined();
  expect(existsSync(join(dir, "proactivity.json"))).toBeFalse();
});

test("set … auto is allowed on an owner turn", async () => {
  const { concierge, config } = harness();
  setActiveTurn(concierge, true); // owner turn
  const res = await concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "333", mode: "auto" },
  });
  expect(res.ok).toBeTrue();
  expect(config.proactivity.channels["333"]).toBe("auto");
});

test("set … off and set … suggest need no owner turn", async () => {
  const { concierge } = harness();
  for (const mode of ["off", "suggest"] as const) {
    const res = await concierge.onBusRequest({
      cmd: "proactivity.set",
      args: { channelId: "444", mode },
    });
    expect(res.ok).toBeTrue();
  }
});

test("set rejects an unknown mode", async () => {
  const { concierge } = harness();
  const res = await concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "555", mode: "loud" },
  });
  expect(res.ok).toBeFalse();
  expect(res.error).toContain("off|suggest|auto");
});

test("status surfaces live offers from the persisted ledger, dropping expired ones", async () => {
  const { concierge, dir } = harness();
  const future = Date.now() + 5 * 60 * 1000;
  const past = Date.now() - 1000;
  writeFileSync(
    join(dir, "pending-offers.json"),
    JSON.stringify({
      offers: [
        { channelId: "aaa", offerMessageId: "o1", offerText: "want CSV export?", sourceUserId: "u1", summary: "CSV export", mode: "suggest", expiresAt: future },
        { channelId: "bbb", offerMessageId: "o2", offerText: "stale", sourceUserId: "u2", summary: "stale", mode: "auto", expiresAt: past },
      ],
    }),
  );
  const res = await concierge.onBusRequest({ cmd: "proactivity.status", args: {} });
  const data = res.data as Record<string, any>;
  expect(data.liveOffers).toHaveLength(1);
  expect(data.liveOffers[0].channelId).toBe("aaa");
  expect(data.liveOffers[0].summary).toBe("CSV export");
  expect(data.liveOffers[0].expiresInSecs).toBeGreaterThan(0);
});
