/**
 * The v6 `ext.invoke`/`ext.catalog` control-bus seam: the registry is read LAZILY at call time
 * (wired by v4-main AFTER the bus surface is built), refusals are clear when it is not wired,
 * and a wired registry round-trips discovery + validated dispatch as {ok, data|error}.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { Config, Logger, Paths } from "../types.ts";
import {
  ActionClass,
  ExtensionRegistry,
  createPingExtension,
  type ExtensionContext,
  type ExtensionInvocation,
} from "../ext/index.ts";

const savedDir = process.env.BECKETT_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal dispatch context — the test extensions only reach for `logger`. */
function extCtx(): ExtensionContext {
  return {
    config: {} as unknown as Config,
    paths: {} as unknown as Paths,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger,
  };
}

function harness(opts: { currentMeta?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-ext-bus-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const gateway = {
    onMessage() {}, async start() {}, async stop() {}, sendTyping() {},
    async post() { return "message"; }, isConnected: () => true, lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  const session = {
    async start() {}, async stop() {}, ask: async () => "", stats: () => ({}),
    // With a meta, the harness models a live issuing turn — the identity ext.invoke derives.
    ...(opts.currentMeta ? { getCurrentMeta: () => opts.currentMeta } : {}),
  } as unknown as ConciergeSession;
  return { concierge: new Concierge({ config: validateConfig({}), gateway, session }) };
}

test("ext.invoke and ext.catalog refuse clearly when the registry is not wired", async () => {
  const { concierge } = harness();
  expect(await concierge.onBusRequest({ cmd: "ext.invoke", args: { capabilityId: "ping.echo" } })).toEqual({
    ok: false,
    error: "ext.invoke unavailable — the extension registry is not wired (v3 daemon only)",
  });
  expect(await concierge.onBusRequest({ cmd: "ext.catalog", args: {} })).toEqual({
    ok: false,
    error: "ext.catalog unavailable — the extension registry is not wired (v3 daemon only)",
  });
});

test("ext.catalog returns the registry's discovery entries once wired", async () => {
  const { concierge } = harness();
  const ctx = extCtx();
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx));
  // Wired AFTER construction, like v4-main — proves the handler reads the field lazily.
  concierge.setExtensionRegistry(registry, ctx);

  const res = await concierge.onBusRequest({ cmd: "ext.catalog", args: {} });
  expect(res.ok).toBeTrue();
  const entries = (res.data as { entries: Array<{ capabilityId: string }> }).entries;
  expect(entries.map((e) => e.capabilityId)).toEqual(["ping.echo"]);
});

test("ext.invoke round-trips a dispatch and maps ExtensionResult onto the BusResponse", async () => {
  const { concierge } = harness();
  const ctx = extCtx();
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx));
  concierge.setExtensionRegistry(registry, ctx);

  const ok = await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: { capabilityId: "ping.echo", args: { message: "hi" } },
  });
  expect(ok.ok).toBeTrue();
  expect(ok.data).toMatchObject({ echoed: "hi" });

  // Registry-side validation refusals surface as ok:false — never a throw, never an exit.
  const badArgs = await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: { capabilityId: "ping.echo", args: { message: "" } },
  });
  expect(badArgs.ok).toBeFalse();
  expect(badArgs.error).toMatch(/invalid args for "ping.echo"/);

  const unknown = await concierge.onBusRequest({ cmd: "ext.invoke", args: { capabilityId: "ping.nope" } });
  expect(unknown.ok).toBeFalse();
  expect(unknown.error).toMatch(/no capability "ping.nope"/);

  const missing = await concierge.onBusRequest({ cmd: "ext.invoke", args: {} });
  expect(missing).toEqual({ ok: false, error: "ext.invoke needs a capabilityId" });
});

test("ext.invoke keeps origin provenance but strips caller-declared identity (spoof-proof)", async () => {
  const { concierge } = harness();
  const ctx = extCtx();
  const registry = new ExtensionRegistry();
  const seen: Array<ExtensionInvocation["origin"]> = [];
  registry.register({
    manifest: { id: "probe", version: "1.0.0", summary: "origin capture", actionClass: ActionClass.FREE },
    capabilities: [{ id: "probe.capture", description: "captures the invocation origin" }],
    invoke: async (call) => {
      seen.push(call.origin);
      return { ok: true };
    },
  });
  concierge.setExtensionRegistry(registry, ctx);

  // userId/channelId ride the same socket a prompt-injected worker child can reach: with no
  // issuing turn to derive an identity from, they are STRIPPED, never trusted.
  await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: {
      capabilityId: "probe.capture",
      origin: { surface: "discord", userId: "u1", bogus: "dropped", channelId: "42", ticket: "OPS-1" },
    },
  });
  await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: { capabilityId: "probe.capture", origin: "not-an-object" },
  });
  expect(seen).toEqual([{ surface: "discord", ticket: "OPS-1" }, undefined]);
});

test("ext.invoke derives the origin identity from the issuing turn, overriding any spoof", async () => {
  const { concierge } = harness({
    currentMeta: {
      channelId: "chan-live",
      messageId: "msg-1",
      userId: "owner-live",
      isOwner: true,
      repliedViaCli: false,
      ackMessageId: null,
    },
  });
  const ctx = extCtx();
  const registry = new ExtensionRegistry();
  const seen: Array<ExtensionInvocation["origin"]> = [];
  registry.register({
    manifest: { id: "probe", version: "1.0.0", summary: "origin capture", actionClass: ActionClass.ALWAYS_ASK },
    capabilities: [{ id: "probe.act", description: "captures the invocation origin" }],
    invoke: async (call) => {
      seen.push(call.origin);
      return { ok: true };
    },
  });
  concierge.setExtensionRegistry(registry, ctx);

  const res = await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: { capabilityId: "probe.act", origin: { surface: "cli", userId: "attacker", channelId: "elsewhere" } },
  });
  expect(res.ok).toBeTrue();
  expect(seen).toEqual([{ surface: "cli", channelId: "chan-live", userId: "owner-live" }]);
});

test("ext.invoke refuses a non-FREE capability without an authenticated issuing turn", async () => {
  const { concierge } = harness();
  const ctx = extCtx();
  const registry = new ExtensionRegistry();
  let invoked = 0;
  registry.register({
    manifest: { id: "danger", version: "1.0.0", summary: "outward action", actionClass: ActionClass.ALWAYS_ASK },
    capabilities: [{ id: "danger.act", description: "acts outward under stored credentials" }],
    invoke: async () => {
      invoked++;
      return { ok: true };
    },
  });
  concierge.setExtensionRegistry(registry, ctx);

  const refused = await concierge.onBusRequest({
    cmd: "ext.invoke",
    args: { capabilityId: "danger.act", origin: { userId: "attacker", channelId: "anywhere" } },
  });
  expect(refused).toEqual({
    ok: false,
    error: 'ext.invoke: capability "danger.act" needs an authenticated authorized request',
  });
  expect(invoked).toBe(0);

  // An unknown capability still gets the registry's own refusal, not the auth gate's.
  const unknown = await concierge.onBusRequest({ cmd: "ext.invoke", args: { capabilityId: "danger.nope" } });
  expect(unknown.error).toMatch(/no capability "danger.nope"/);
});
