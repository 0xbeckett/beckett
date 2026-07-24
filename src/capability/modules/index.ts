/**
 * Beckett v5 — the normalized capability modules (`src/capability/modules/index.ts`)
 * =======================================================================================
 * Phase 2 of the extensibility refactor: the formerly-bespoke capability modules — github,
 * dns+deploy (cloudflare), image, memory, mail, secret — on the ONE common factory shape
 * ({@link CapabilityFactory}), looked up through the same table posture as the harness
 * driver registry (`drivers/index.ts`): add a factory entry, implement the interface, done.
 *
 * Consumers (today: `cli/beckett.ts::buildCliCapabilities`) never import a module file
 * directly — they ask this table by id and register the built {@link Capability} in a
 * {@link CapabilityRegistry}. Asking for anything unregistered fails loudly rather than
 * silently degrading, and a module whose built id disagrees with its table key is a wiring
 * bug caught at build time, not a silently shadowed capability.
 */

import type { Capability, CapabilityDeps, CapabilityFactory } from "../index.ts";
import { createDeployCapability, createDnsCapability } from "./cloudflare.ts";
import { createGithubCapability } from "./github.ts";
import { createImageCapability } from "./image.ts";
import { createMailCapability } from "./mail.ts";
import { createMemoryCapability } from "./memory.ts";
import { createSecretCapability } from "./secret.ts";

export { createDeployCapability, createDnsCapability } from "./cloudflare.ts";
export { createGithubCapability } from "./github.ts";
export { createImageCapability } from "./image.ts";
export { createMailCapability } from "./mail.ts";
export { createMemoryCapability } from "./memory.ts";
export { createSecretCapability } from "./secret.ts";
// V6 Phase 1 (docs/v6-architecture.md §6): the first organs on the extension contract. Their
// table entries above are the asCapability projections; these are the extensions themselves.
export { createImageExtension } from "./image.ts";
export { createSecretExtension } from "./secret.ts";

/** The capability-id → factory table (the analog of `drivers/index.ts::FACTORIES`). */
const FACTORIES: Record<string, CapabilityFactory> = {
  github: createGithubCapability,
  dns: createDnsCapability,
  deploy: createDeployCapability,
  image: createImageCapability,
  mail: createMailCapability,
  memory: createMemoryCapability,
  secret: createSecretCapability,
};

/** Whether a normalized module is registered for `id`. */
export function hasCapabilityModule(id: string): boolean {
  return id in FACTORIES && FACTORIES[id] !== undefined;
}

/** The set of capability ids with a normalized module in this build. */
export function availableCapabilityModules(): string[] {
  return Object.keys(FACTORIES).filter((id) => FACTORIES[id] !== undefined);
}

/**
 * Resolve the factory for a capability module. Throws a clear error for an unregistered id so
 * the caller escalates instead of silently doing nothing.
 */
export function getCapabilityFactory(id: string): CapabilityFactory {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new Error(
      `beckett: no capability module registered for "${id}" ` +
        `(available: ${availableCapabilityModules().join(", ") || "none"})`,
    );
  }
  return factory;
}

/**
 * Build a capability module for the given id. Convenience over {@link getCapabilityFactory},
 * plus the id-match invariant: a module claiming a different id than its table key can never
 * silently shadow another capability.
 */
export function createCapability(id: string, deps: CapabilityDeps): Capability {
  const capability = getCapabilityFactory(id)(deps);
  if (capability.id !== id) {
    throw new Error(
      `beckett: capability module registered as "${id}" built a capability claiming id "${capability.id}"`,
    );
  }
  return capability;
}
