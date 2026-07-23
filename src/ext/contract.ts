/**
 * Beckett v6 — the extension contract (`src/ext/contract.ts`)
 * =======================================================================================
 * The FOUNDATION step of the v6 migration (issue #82). This module defines the ONE standard
 * contract every v6 extension registers through — the "plug n play" interface the whole v6
 * generation migrates onto. It is design + skeleton: nothing here is wired into the live
 * daemon path yet. See {@link ../../docs/v6-architecture.md} for the full boundary + migration.
 *
 * WHY a new contract when v5 already has plug-in tables:
 * v5 grew FOUR parallel registries, each a good local answer, none the same shape:
 *   - `src/drivers/index.ts`     — harness drivers (the original, and the one that always worked)
 *   - `src/capability/index.ts`  — capabilities (CLI verbs, bus commands, prompt blocks, config)
 *   - `src/agent/registry.ts`    — live agent registry (#66/#55: named worker personas)
 *   - `src/dispatch/stages.ts`   — worker stage registry (implement/review/design)
 * Four registration idioms, four discovery mechanisms, no single seam a new organ plugs into.
 * That IS the "shoddily stacked" shape in miniature. v6 unifies them: an {@link Extension} is
 * the v5 {@link Capability} GENERALIZED to also carry lifecycle, a discovery catalog, and a
 * single invocation entrypoint — the two things the @mention flow needs that the capability
 * spine never had. The existing facets (cliVerbs, busCommands, promptBlock, config) are carried
 * through UNCHANGED, so migrating a capability to an extension is additive, not a rewrite.
 *
 * SUBSUMES #55: the live agent registry becomes the backing store for an extension's `agents`
 * facet; its agents.json live-reload semantics are kept as-is (see the doc's reconciliation
 * note). This contract does not fork #55 — it re-homes it.
 */

import type { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import { ActionClass } from "../types.ts";
// The v5 facet vocabulary is carried through verbatim — an extension SUBSUMES a capability,
// it does not reinvent the surfaces a capability already lights up.
import type { BusCommand, CliVerb, PromptBlock } from "../capability/index.ts";

export { ActionClass };
export type { BusCommand, CliVerb, PromptBlock };

// =======================================================================================
// Manifest — who the extension is
// =======================================================================================

/**
 * Whether a module is part of the invariant v6 core or a pluggable extension. Core organs
 * register through the SAME contract (that is the point — one seam), but are tagged so the
 * boundary is machine-checkable and the doctor/catalog can present them distinctly.
 */
export type ExtensionKind = "core" | "extension";

/** The self-describing header every extension declares. */
export interface ExtensionManifest {
  /** Unique kebab-case id ("memory", "browser", "social"). The registry key. */
  id: string;
  /**
   * Semver-ish version string. Carried from day one because the v6 improve/rollback loop
   * (docs/v6.md § Improve) versions and reverts extensions the way it versions the daemon.
   */
  version: string;
  /** Human one-liner: what this extension is for. Surfaced to humans and the concierge. */
  summary: string;
  /** Default license posture for every capability that does not override it (Spec 07 §2.2). */
  actionClass: ActionClass;
  /** core organ vs bolted-on feature. Defaults to "extension" when omitted by the registry. */
  kind?: ExtensionKind;
}

// =======================================================================================
// Discovery — what the concierge routes over
// =======================================================================================

/**
 * One machine-readable capability an extension advertises. This is the heart of v6 "plug n
 * play": the Concierge does not match a command prefix (slash commands are dead) — it reads
 * the `description` of every advertised capability and routes an @mention to the right one.
 * The registry renders these into the concierge's system prompt ({@link ExtensionRegistry.catalog}),
 * which is exactly #55's "modular concierge prompting" generalized past agents to every organ.
 */
export interface ExtensionCapability {
  /** Namespaced id ("memory.recall", "browser.exec"). Globally unique across all extensions. */
  id: string;
  /**
   * Natural-language description — what this can do and WHEN to reach for it. This is the text
   * the concierge's router reads, so it is prose for an LLM, not a usage string for a parser.
   */
  description: string;
  /** Per-capability override of the extension's default action-class. */
  actionClass?: ActionClass;
  /**
   * Optional zod schema for the invocation args. The registry validates a call against this
   * BEFORE it reaches {@link Extension.invoke}, so an extension body never re-parses raw input.
   */
  input?: z.ZodTypeAny;
  /** Optional example phrasings ("remember that…", "what do you know about…") to sharpen routing. */
  examples?: string[];
}

// =======================================================================================
// Invocation — the ONE dispatch entrypoint
// =======================================================================================

/**
 * Provenance an extension may need to do its job, kept STRUCTURAL so the contract has zero
 * dependency on discord/tracker types (the same discipline as `Capability`'s `BusRequestLike`).
 */
export interface InvocationOrigin {
  /** Which surface the call came from ("discord", "cli", "routine", "goal-ledger", …). */
  surface?: string;
  channelId?: string;
  userId?: string;
  /** The ticket identifier when the call rides a worker/dispatch context. */
  ticket?: string;
}

/** A single dispatch from the concierge (or another core caller) to an extension. */
export interface ExtensionInvocation {
  /** The advertised capability being invoked. Must exist in the extension's catalog. */
  capabilityId: string;
  /** The call arguments — validated against the capability's `input` schema by the registry. */
  args: Record<string, unknown>;
  /** Where the call came from, for extensions that scope behavior by surface/audience. */
  origin?: InvocationOrigin;
}

/**
 * The result of an invocation. Deliberately minimal for the skeleton: `ok` + a data payload,
 * or `ok:false` + an error the concierge can surface. Richer shapes (streaming, follow-up
 * intents, staged pending-actions for the gate) layer on in later phases without changing the
 * seam.
 */
export interface ExtensionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// =======================================================================================
// Lifecycle — for stateful extensions (memory retrieval, the browser subprocess)
// =======================================================================================

/** What an extension factory/lifecycle gets — the same runtime context as {@link CapabilityDeps}. */
export interface ExtensionContext {
  config: Config;
  paths: Paths;
  logger: Logger;
}

/** A single health verdict, consumed by `beckett doctor` and the v6 observation window. */
export interface ExtensionHealth {
  ok: boolean;
  /** One-line detail when not ok (or a status note when ok). */
  detail?: string;
}

/**
 * Optional lifecycle hooks. Stateless extensions (github, image) declare none. Stateful ones
 * (memory holds retrieval indices, browser owns a subprocess) implement what they need:
 *   - `init`  — build state, open connections; may run before the daemon accepts traffic.
 *   - `start` — begin any background loops (a poller, a nightly maintain pass).
 *   - `stop`  — tear down cleanly on daemon shutdown / hot-reload.
 *   - `health`— the doctor/observation-window probe.
 * The registry orchestrates these across all extensions in registration order.
 */
export interface ExtensionLifecycle {
  init?: (ctx: ExtensionContext) => Promise<void> | void;
  start?: (ctx: ExtensionContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  health?: () => Promise<ExtensionHealth> | ExtensionHealth;
}

// =======================================================================================
// The Extension — the one contract everything registers through
// =======================================================================================

/**
 * A self-describing v6 extension. `manifest` is the only required field; everything else is a
 * facet the extension opts into. The NEW-in-v6 facets are `capabilities` + `invoke` (discovery
 * and dispatch — the @mention flow) and `lifecycle` (stateful organs). The rest are the v5
 * capability facets, carried unchanged so migration is additive.
 */
export interface Extension {
  manifest: ExtensionManifest;

  // --- v6: discovery + dispatch (the plug-n-play core) ---
  /** Machine-readable capabilities the concierge discovers and routes over. */
  capabilities?: ExtensionCapability[];
  /**
   * The single dispatch entrypoint. The registry validates the call (capability exists, args
   * match the schema) before invoking this, so the body handles only already-validated input.
   * Required whenever `capabilities` is non-empty; an extension advertising capabilities it
   * cannot service is a wiring bug the registry refuses at registration.
   */
  invoke?: (call: ExtensionInvocation, ctx: ExtensionContext) => Promise<ExtensionResult>;

  // --- v6: lifecycle (stateful extensions) ---
  lifecycle?: ExtensionLifecycle;

  // --- v5 facets, subsumed unchanged ---
  cliVerbs?: CliVerb[];
  busCommands?: BusCommand[];
  promptBlock?: PromptBlock;
  configSchema?: z.ZodTypeAny;
  /** Where the config fragment mounts in config.toml; defaults to `manifest.id`. */
  configKey?: string;
}

/**
 * The common factory shape (mirrors {@link CapabilityFactory} and {@link DriverFactory}): the
 * caller threads the resolved runtime context in; the module never loads config or resolves
 * paths itself.
 */
export type ExtensionFactory = (ctx: ExtensionContext) => Extension;

/** The effective action-class of a capability: its own override, else the extension default. */
export function effectiveActionClass(
  extension: Extension,
  capability: { actionClass?: ActionClass },
): ActionClass {
  return capability.actionClass ?? extension.manifest.actionClass;
}
