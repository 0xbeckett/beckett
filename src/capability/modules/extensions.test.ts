/**
 * V6 Phase 1 — image + secret on the extension contract (docs/v6-architecture.md §6).
 * Pins the seam end-to-end on the first two migrated organs: registration + discovery
 * (catalog), schema-validated dispatch (invoke never exits the process — refusals come back
 * as ok:false results), the fail-first env preflight, and the asCapability projection the
 * CLI registers until Phase 4. The organs' CLI surface stays pinned separately by
 * `src/cli/characterization.test.ts`.
 */

import { expect, test } from "bun:test";
import { CapabilityRegistry } from "../index.ts";
import { asCapability, ExtensionRegistry, type ExtensionContext } from "../../ext/index.ts";
import { createImageExtension, createSecretExtension } from "./index.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

function ctx(): ExtensionContext {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

function registryWithBoth(): { registry: ExtensionRegistry; deps: ExtensionContext } {
  const deps = ctx();
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(deps));
  registry.register(createSecretExtension(deps));
  return { registry, deps };
}

/** Run a block with an env key temporarily unset, restoring whatever was there. */
async function withoutEnv<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

// ── registration + discovery ─────────────────────────────────────────────────────────────

test("image + secret register on the extension contract and advertise their capabilities", () => {
  const { registry } = registryWithBoth();
  expect(registry.list()).toEqual(["image", "secret"]);
  const catalog = registry.catalog();
  expect(catalog.map((e) => e.capabilityId)).toEqual(["image.generate", "secret.request"]);
  // The catalog is what the concierge routes over — every entry needs real routing prose.
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
});

test("both organs are stateless: no lifecycle, so the health surface is empty", async () => {
  const { registry } = registryWithBoth();
  expect(await registry.health()).toEqual([]);
});

// ── dispatch: validation refusals come back as results, never exits ──────────────────────

test("invoke refuses an unknown capability with ok:false", async () => {
  const { registry, deps } = registryWithBoth();
  const r = await registry.invoke({ capabilityId: "image.nope", args: {} }, deps);
  expect(r.ok).toBeFalse();
  expect(r.error).toContain('no capability "image.nope"');
});

test("image.generate validates args at the seam: empty prompt and video-without-fal refuse", async () => {
  const { registry, deps } = registryWithBoth();
  const empty = await registry.invoke({ capabilityId: "image.generate", args: {} }, deps);
  expect(empty.ok).toBeFalse();
  expect(empty.error).toContain("invalid args");

  const video = await registry.invoke(
    { capabilityId: "image.generate", args: { prompt: "a cat", video: true } },
    deps,
  );
  expect(video.ok).toBeFalse();
  expect(video.error).toContain("fal video model");
});

test("secret.request refuses name+fields together and neither, via the schema refine", async () => {
  const { registry, deps } = registryWithBoth();
  const both = await registry.invoke(
    { capabilityId: "secret.request", args: { name: "K", fields: "user,pass" } },
    deps,
  );
  expect(both.ok).toBeFalse();
  expect(both.error).toContain("exactly one of");

  const neither = await registry.invoke({ capabilityId: "secret.request", args: {} }, deps);
  expect(neither.ok).toBeFalse();
  expect(neither.error).toContain("exactly one of");
});

test("secret.request keeps the intake validators: bad env name and keychain-without-entry refuse", async () => {
  const { registry, deps } = registryWithBoth();
  const badName = await registry.invoke(
    { capabilityId: "secret.request", args: { name: "not a key" } },
    deps,
  );
  expect(badName.ok).toBeFalse();
  expect(badName.error).toContain("environment key");

  const noEntry = await registry.invoke(
    { capabilityId: "secret.request", args: { fields: "user,pass" } },
    deps,
  );
  expect(noEntry.ok).toBeFalse();
  expect(noEntry.error).toContain("--entry");
});

test("secret.request preflights Cloudflare creds BEFORE touching systemd/tunnels", async () => {
  const { registry, deps } = registryWithBoth();
  const r = await withoutEnv(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_TUNNEL_ID"], () =>
    registry.invoke({ capabilityId: "secret.request", args: { name: "MY_KEY" } }, deps),
  );
  expect(r.ok).toBeFalse();
  expect(r.error).toContain("CLOUDFLARE_API_TOKEN");
});

// ── the Phase 1–4 bridge: the CLI registers the projection ───────────────────────────────

test("asCapability projects the carried v5 facets so the CLI spine slot is unchanged", () => {
  const deps = ctx();
  const image = asCapability(createImageExtension(deps));
  const secret = asCapability(createSecretExtension(deps));

  expect(image.id).toBe("image");
  expect(image.cliHelp).toBe("image");
  expect(image.skillDoc).toBe(".claude/skills/image/SKILL.md");
  expect(image.cliVerbs.map((v) => v.name)).toEqual(["image"]);
  expect(typeof image.cliVerbs[0]!.run).toBe("function");

  expect(secret.id).toBe("secret");
  expect(secret.cliHelp).toBe("secret request");
  expect(secret.cliVerbs.map((v) => v.name)).toEqual(["secret"]);

  // Both projections register cleanly into the v5 spine (the CLI's exact move).
  const spine = new CapabilityRegistry();
  spine.register(image);
  spine.register(secret);
  expect(spine.resolveCliVerb(["image", "a", "cat"])!.capability.id).toBe("image");
  expect(spine.resolveCliVerb(["secret", "request"])!.capability.id).toBe("secret");
});
