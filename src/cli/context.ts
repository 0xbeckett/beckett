/**
 * Beckett — the CLI's shared runtime context (`src/cli/context.ts`)
 * =======================================================================================
 * The one place the `beckett` CLI resolves config + paths, so the lazily-loaded verb modules
 * (`src/cli/core.ts` and the capability extensions) share a SINGLE `loadConfig()` rather than
 * re-reading it per module. Deliberately light: it reaches only `config.ts`/`paths.ts`/`io.ts`,
 * never the heavy runtimes (playwright, discord.js, agentmail). The entry (`beckett.ts`) does
 * NOT import this — it is pulled in only inside a verb's lazy `import()`, so the cold-start
 * router never pays for a config read on an unknown command.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { quietLogger } from "./io.ts";

export const config = loadConfig();
export const paths = buildPaths(config);
export const SOCK = join(paths.beckettDir, "control.sock");

/** What the normalized capability modules get to build themselves (V5 Phase 2). */
export const capabilityDeps = { config, paths, logger: quietLogger };
