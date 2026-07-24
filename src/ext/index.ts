/**
 * Beckett v6 — the extension boundary (`src/ext/`)
 * =======================================================================================
 * Public barrel for the v6 extension contract + registry (issue #82). This is the ONE seam
 * every v6 organ registers through — the "plug n play" interface described in
 * {@link ../../docs/v6-architecture.md}. Skeleton only: the types, the registry, and one
 * example extension prove the contract compiles and dispatches. Nothing here is wired into
 * the live daemon path; the real organ migration is a separate plan.
 */

export * from "./contract.ts";
export { ExtensionRegistry } from "./registry.ts";
export type {
  CatalogEntry,
  ExtensionHealthReport,
  ResolvedCapability,
} from "./registry.ts";
export { asCapability } from "./compat.ts";
export { createPingExtension } from "./example.ts";
