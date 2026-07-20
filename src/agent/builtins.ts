/**
 * Beckett — Built-in agents (`src/agent/builtins.ts`)
 * =======================================================================================
 * Engine-seeded agent definitions that exist on a fresh install. The store seeds these on load
 * unless the user explicitly removed them (tracked in `removedBuiltins`), exactly like built-in
 * routines ({@link ../routine/builtins.ts}).
 *
 * There are no built-in agents today — the registry ships empty and users/the concierge add
 * their own. This factory is the extension seam so #55 can seed default personas later without
 * touching the store or loader.
 */

import type { AgentDefinition } from "./types.ts";

/**
 * The definitions (sans timestamps — the store stamps those on seed). Kept as a factory so the
 * seeder gets fresh objects and can't accidentally share mutable state.
 */
export function builtinAgentDefs(): Array<Omit<AgentDefinition, "createdAt" | "updatedAt">> {
  return [];
}

/** Ids of the built-ins (for `remove` bookkeeping and tests). */
export function builtinAgentIds(): string[] {
  return builtinAgentDefs().map((a) => a.id);
}
