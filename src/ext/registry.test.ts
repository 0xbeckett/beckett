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

test("initAll/startAll isolate a throwing best-effort organ and keep sweeping", async () => {
  const registry = new ExtensionRegistry();
  const calls: string[] = [];
  const warns: string[] = [];
  registry.register(
    ext("broken", {
      lifecycle: {
        init() {
          throw new Error("init exploded");
        },
        start() {
          throw new Error("start exploded");
        },
      },
    }),
  );
  registry.register(
    ext("healthy", {
      lifecycle: { init: () => void calls.push("init"), start: () => void calls.push("start") },
    }),
  );
  const c = ctx();
  (c.logger as { warn: (msg: string) => void }).warn = (msg) => void warns.push(msg);

  await registry.initAll(c); // does not throw — the broken organ is isolated
  await registry.startAll(c);
  expect(calls).toEqual(["init", "start"]);
  expect(warns).toEqual(["extension init failed", "extension start failed"]);
});

test("a fail-fast organ's init/start throw aborts the sweep", async () => {
  const registry = new ExtensionRegistry();
  const calls: string[] = [];
  registry.register(
    ext("concierge-grade", {
      lifecycle: {
        failPolicy: "fail-fast",
        start() {
          throw new Error("bad claude launch");
        },
      },
    }),
  );
  registry.register(ext("later", { lifecycle: { start: () => void calls.push("start") } }));

  await expect(registry.startAll(ctx())).rejects.toThrow("bad claude launch");
  expect(calls).toEqual([]); // the sweep aborted before later organs started
});

test("stopAll swallows and logs a throwing stop, still stopping the rest", async () => {
  const registry = new ExtensionRegistry();
  const stopped: string[] = [];
  const warns: Array<Record<string, unknown> | undefined> = [];
  registry.register(ext("first", { lifecycle: { stop: () => void stopped.push("first") } }));
  registry.register(
    ext("broken", {
      lifecycle: {
        stop() {
          throw new Error("stop exploded");
        },
      },
    }),
  );
  registry.register(ext("last", { lifecycle: { stop: () => void stopped.push("last") } }));

  const logger = ctx().logger;
  (logger as unknown as { warn: (msg: string, meta?: Record<string, unknown>) => void }).warn =
    (_msg, meta) => void warns.push(meta);
  await registry.stopAll(logger); // best-effort: never throws
  expect(stopped).toEqual(["last", "first"]); // reverse registration order, broken organ skipped over
  expect(warns).toEqual([{ extension: "broken", error: "stop exploded" }]);
});

test("health keeps collecting past a throwing probe (thrown → ok:false with the error)", async () => {
  const registry = new ExtensionRegistry();
  registry.register(
    ext("broken", {
      lifecycle: {
        health() {
          throw new Error("probe exploded");
        },
      },
    }),
  );
  registry.register(ext("healthy", { lifecycle: { health: () => ({ ok: true, detail: "fine" }) } }));

  expect(await registry.health()).toEqual([
    { extensionId: "broken", ok: false, detail: "probe exploded" },
    { extensionId: "healthy", ok: true, detail: "fine" },
  ]);
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
