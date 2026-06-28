/**
 * Beckett — harness driver registry (`src/drivers/index.ts`)
 * =======================================================================================
 * The tiny lookup the {@link WorkerManager} uses to pick a concrete {@link HarnessDriver}
 * for a node's chosen harness (Spec 02 §3). Dependency inversion: the control plane and DAG
 * executor never `new` a driver — they ask the registry for one and hold only the typed
 * interface.
 *
 * v0 scope (Spec 12 §3): Claude only, single node. The `codex` slot is intentionally left
 * **unregistered** — the seam is here (add a `codex:` factory when `CodexDriver` lands), but
 * `codex-exec-oneshot` is NOT implemented in v0 (Spec 02 §5 / §11). Asking for it fails loudly
 * rather than silently degrading.
 */

import type { Config, Harness, HarnessDriver, Logger } from "../types.ts";
import { ClaudeDriver } from "./claude.ts";

export { ClaudeDriver } from "./claude.ts";
export type { RateLimitSignal } from "./claude.ts";

/** Builds a fresh driver instance (one driver == one harness process). */
export type DriverFactory = (config: Config, logger?: Logger) => HarnessDriver;

/**
 * The harness → driver-factory table. Add `codex` here when CodexDriver is implemented
 * (Spec 02 §5); until then it is deliberately absent so v0 cannot half-run a codex node.
 */
const FACTORIES: Partial<Record<Harness, DriverFactory>> = {
  claude: (config, logger) => new ClaudeDriver(config, logger),
  // codex: (config, logger) => new CodexDriver(config, logger),  // v1 — not in v0 scope
};

/** Whether a driver is registered for `harness`. */
export function hasDriver(harness: Harness): boolean {
  return harness in FACTORIES && FACTORIES[harness] !== undefined;
}

/** The set of harnesses with a usable driver in this build (v0: `["claude"]`). */
export function availableHarnesses(): Harness[] {
  return (Object.keys(FACTORIES) as Harness[]).filter((h) => FACTORIES[h] !== undefined);
}

/**
 * Resolve the factory for a harness. Throws a clear error for an unregistered harness
 * (e.g. `codex` in v0) so the caller escalates instead of silently doing nothing.
 */
export function getDriverFactory(harness: Harness): DriverFactory {
  const factory = FACTORIES[harness];
  if (!factory) {
    throw new Error(
      `beckett: no driver registered for harness "${harness}" ` +
        `(available: ${availableHarnesses().join(", ") || "none"})`,
    );
  }
  return factory;
}

/** Construct a driver for the given harness. Convenience over {@link getDriverFactory}. */
export function createDriver(
  harness: Harness,
  config: Config,
  logger?: Logger,
): HarnessDriver {
  return getDriverFactory(harness)(config, logger);
}
