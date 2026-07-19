/**
 * Beckett — harness driver registry (`src/drivers/index.ts`)
 * =======================================================================================
 * The tiny lookup the {@link WorkerManager} uses to pick a concrete {@link HarnessDriver}
 * for a node's chosen harness (Spec 02 §3). Dependency inversion: the control plane and DAG
 * executor never `new` a driver — they ask the registry for one and hold only the typed
 * interface.
 *
 * v3 registers the three supported harnesses: Claude for live steering, Codex for one-shot
 * `codex exec`, and Pi for one-shot `pi -p`. Asking for anything else fails loudly rather than
 * silently degrading.
 */

import type { Config, Harness, HarnessDriver, Logger } from "../types.ts";
import { ClaudeDriver, claudePreflight } from "./claude.ts";
import { CodexDriver, codexPreflight } from "./codex.ts";
import { PiDriver, piPreflight } from "./pi.ts";

export { ClaudeDriver } from "./claude.ts";
export { CodexDriver } from "./codex.ts";
export { PiDriver } from "./pi.ts";

/** Builds a fresh driver instance (one driver == one harness process). */
export type DriverFactory = (config: Config, logger?: Logger) => HarnessDriver;

/** The common shape of the per-driver preflights (binary, version, auth artifact). */
export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

/** A driver's static "is this harness usable RIGHT NOW?" probe (issue #17). */
export type DriverPreflight = (config: Config) => Promise<PreflightResult>;

/**
 * Everything the control plane needs to know about ONE harness — how to build its driver AND how
 * to preflight it — kept in a single entry so the two never drift. Adding a harness (including an
 * out-of-tree one) is one {@link REGISTRY} row; nothing else in the tree hand-enumerates the trio.
 */
export interface DriverRegistration {
  /** Construct a fresh driver process wrapper. */
  create: DriverFactory;
  /** Static health probe consulted before casting (and by `beckett doctor`). */
  preflight: DriverPreflight;
}

/**
 * The harness → registration table — the SINGLE SOURCE OF TRUTH for which harnesses exist.
 * `claude` (live-steerable stream), `codex` (one-shot `codex exec`, steer-via-resume), and `pi`
 * (one-shot `pi -p`, steer-via-resume — the malleable codex replacement) are all registered so the
 * dispatcher can cast any of them per stage (Spec 02 §5; docs/V3.md §7). Both the factory and the
 * preflight live in the same row: no separate hand-synced switch to keep aligned.
 */
const REGISTRY: Record<string, DriverRegistration> = {
  claude: { create: (config, logger) => new ClaudeDriver(config, logger), preflight: claudePreflight },
  codex: { create: (config, logger) => new CodexDriver(config, logger), preflight: codexPreflight },
  pi: { create: (config, logger) => new PiDriver(config, logger), preflight: piPreflight },
};

/**
 * Whether `name` is a registered harness — the registry-driven replacement for a hardcoded
 * `claude|codex|pi` enum. Cast/preset validation calls this so a newly-registered driver becomes
 * castable with no second edit. Uses an own-property check so inherited keys (`constructor`,
 * `toString`, …) are never mistaken for a driver.
 */
export function isRegisteredHarness(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/** Whether a driver is registered for `harness`. */
export function hasDriver(harness: Harness): boolean {
  return isRegisteredHarness(harness);
}

/** The set of harnesses with a usable driver in this build. */
export function availableHarnesses(): Harness[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve the factory for a harness. Throws a clear error for an unregistered harness so the
 * caller escalates instead of silently doing nothing.
 */
export function getDriverFactory(harness: Harness): DriverFactory {
  const registration = isRegisteredHarness(harness) ? REGISTRY[harness] : undefined;
  if (!registration) {
    throw new Error(
      `beckett: no driver registered for harness "${harness}" ` +
        `(available: ${availableHarnesses().join(", ") || "none"})`,
    );
  }
  return registration.create;
}

/** Construct a driver for the given harness. Convenience over {@link getDriverFactory}. */
export function createDriver(
  harness: Harness,
  config: Config,
  logger?: Logger,
): HarnessDriver {
  return getDriverFactory(harness)(config, logger);
}

// =======================================================================================
// Preflight (issue #17) — "is this harness usable RIGHT NOW?"
// =======================================================================================

const PREFLIGHT_TTL_MS = 5 * 60_000;
const preflightCache = new Map<Harness, { at: number; result: PreflightResult }>();

/**
 * Run (or serve from a ~5-min cache) the harness's static preflight: binary resolves, reports a
 * version, and its auth artifact exists. The concrete probe comes straight off the {@link REGISTRY}
 * row for the harness — there is no separate switch to keep in sync. The dispatcher consults this
 * BEFORE casting a worker so a dead harness produces one clear "unavailable: <reason>" substitution
 * instead of a wedged ticket; `beckett doctor` runs the same checks. The cache keeps the per-spawn
 * cost at zero while still noticing a fixed login within minutes.
 */
export async function preflightFor(
  harness: Harness,
  config: Config,
  opts: { force?: boolean } = {},
): Promise<PreflightResult> {
  const cached = preflightCache.get(harness);
  if (!opts.force && cached && Date.now() - cached.at < PREFLIGHT_TTL_MS) return cached.result;

  const registration = isRegisteredHarness(harness) ? REGISTRY[harness] : undefined;
  let result: PreflightResult;
  if (!registration) {
    result = { ok: false, problems: [`no driver registered for harness "${harness}"`] };
  } else {
    try {
      result = await registration.preflight(config);
    } catch (err) {
      result = { ok: false, problems: [`preflight crashed: ${(err as Error).message}`] };
    }
  }
  preflightCache.set(harness, { at: Date.now(), result });
  return result;
}
