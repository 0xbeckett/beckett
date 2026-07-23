/**
 * The v6 extension contract + registry (issue #82). Proves the ONE seam every organ migrates
 * onto: registration with loud collision refusal, LLM-facing discovery (catalog), validated
 * dispatch (invoke), and lifecycle orchestration. Nothing here touches the live daemon — the
 * skeleton is proven in isolation, exactly as the v5 capability spine was.
 */

import { expect, test } from "bun:test";
import { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import {
  ActionClass,
  ExtensionRegistry,
  createPingExtension,
  effectiveActionClass,
  type Extension,
  type ExtensionContext,
} from "./index.ts";

/** A minimal context — the example extension only reaches for `logger`. */
function ctx(): ExtensionContext {
  return {
    config: {} as unknown as Config,
    paths: {} as unknown as Paths,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger,
  };
}

/** A bare extension with just a manifest, for the collision/registration tests. */
function ext(id: string, overrides: Partial<Extension> = {}): Extension {
  return {
    manifest: { id, version: "1.0.0", summary: `the ${id} extension`, actionClass: ActionClass.FREE },
    ...overrides,
  };
}

test("register + get + has + list mirror the v5 registry contract", () => {
  const registry = new ExtensionRegistry();
  const memory = ext("memory");
  registry.register(memory);
  expect(registry.has("memory")).toBeTrue();
  expect(registry.has("browser")).toBeFalse();
  expect(registry.get("memory")).toBe(memory);
  expect(registry.list()).toEqual(["memory"]);
});

test("get throws a loud, listing error for an unknown id", () => {
  const registry = new ExtensionRegistry();
  registry.register(ext("memory"));
  expect(() => registry.get("nope")).toThrow(/no extension registered for "nope".*available: memory/s);
});

test("duplicate extension id is refused", () => {
  const registry = new ExtensionRegistry();
  registry.register(ext("memory"));
  expect(() => registry.register(ext("memory"))).toThrow(/already registered/);
});

test("a capability without an invoke() is refused at registration", () => {
  const registry = new ExtensionRegistry();
  const broken = ext("broken", {
    capabilities: [{ id: "broken.do", description: "does a thing" }],
  });
  expect(() => registry.register(broken)).toThrow(/advertises capabilities but declares no invoke/);
});

test("a capability id collision across extensions is refused, attributing both", () => {
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx()));
  const clash = ext("other", {
    capabilities: [{ id: "ping.echo", description: "steals the id" }],
    invoke: async () => ({ ok: true }),
  });
  expect(() => registry.register(clash)).toThrow(/capability "ping.echo" is already registered by extension "ping"/);
});

test("catalog renders every advertised capability for concierge discovery", () => {
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx()));
  const catalog = registry.catalog();
  expect(catalog).toHaveLength(1);
  const [entry] = catalog;
  expect(entry?.extensionId).toBe("ping");
  expect(entry?.capabilityId).toBe("ping.echo");
  expect(entry?.actionClass).toBe(ActionClass.FREE); // resolved from the extension default
  expect(entry?.examples.length).toBeGreaterThan(0);
});

test("invoke validates args against the capability schema and dispatches", async () => {
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx()));

  const ok = await registry.invoke({ capabilityId: "ping.echo", args: { message: "hi" } }, ctx());
  expect(ok.ok).toBeTrue();
  expect(ok.data).toMatchObject({ echoed: "hi", calls: 1 });

  const badArgs = await registry.invoke({ capabilityId: "ping.echo", args: { message: "" } }, ctx());
  expect(badArgs.ok).toBeFalse();
  expect(badArgs.error).toMatch(/invalid args for "ping.echo"/);

  const unknown = await registry.invoke({ capabilityId: "ping.nope", args: {} }, ctx());
  expect(unknown.ok).toBeFalse();
  expect(unknown.error).toMatch(/no capability "ping.nope"/);
});

test("lifecycle orchestration drives init/start/health/stop across extensions", async () => {
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx()));
  const c = ctx();

  // Before start(), health reports not-started.
  await registry.initAll(c);
  let health = await registry.health();
  expect(health).toEqual([{ extensionId: "ping", ok: false, detail: "not started" }]);

  await registry.startAll(c);
  health = await registry.health();
  expect(health[0]?.ok).toBeTrue();

  await registry.stopAll();
  health = await registry.health();
  expect(health[0]?.ok).toBeFalse();
});

test("config fragments compose under the extension's key", () => {
  const registry = new ExtensionRegistry();
  registry.register(createPingExtension(ctx()));
  const fragments = registry.configFragments();
  expect([...fragments.keys()]).toEqual(["ping"]);
});

test("effectiveActionClass falls back to the extension default, else the override", () => {
  const e = ext("x", { manifest: { id: "x", version: "1.0.0", summary: "x", actionClass: ActionClass.FREE } });
  expect(effectiveActionClass(e, {})).toBe(ActionClass.FREE);
  expect(effectiveActionClass(e, { actionClass: ActionClass.ALWAYS_ASK })).toBe(ActionClass.ALWAYS_ASK);
});
