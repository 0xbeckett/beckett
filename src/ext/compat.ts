/**
 * Beckett v6 — the extension → capability projection (`src/ext/compat.ts`)
 * =======================================================================================
 * The Phase 1–4 migration bridge (docs/v6-architecture.md §6): an organ that has moved onto
 * the {@link Extension} contract still has to serve the surfaces that read from the v5
 * {@link CapabilityRegistry} until those surfaces cut over. This projection maps the carried
 * v5 facets back onto a {@link Capability}, so a half-migrated surface (the CLI in Phase 1)
 * can register an extension-backed organ in its existing spine slot — dispatch order, help
 * composition, and collision checks all stay byte-identical.
 *
 * Deliberately lossy in ONE direction only: the v6-native facets (capabilities, invoke,
 * lifecycle) do not project — they are what the v5 spine never had, and they are reachable
 * only through the {@link ExtensionRegistry}. When Phase 4 retires the standalone
 * CapabilityRegistry, this file goes with it.
 */

import type { Capability } from "../capability/index.ts";
import type { Extension } from "./contract.ts";

/** Project an extension's carried v5 facets onto the capability shape the v5 spine registers. */
export function asCapability(extension: Extension): Capability {
  return {
    id: extension.manifest.id,
    summary: extension.manifest.summary,
    actionClass: extension.manifest.actionClass,
    cliVerbs: extension.cliVerbs ?? [],
    busCommands: extension.busCommands ?? [],
    cliHelp: extension.cliHelp,
    skillDoc: extension.skillDoc,
    promptBlock: extension.promptBlock,
    configSchema: extension.configSchema,
    configKey: extension.configKey,
  };
}
