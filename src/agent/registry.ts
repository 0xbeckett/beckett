/**
 * Beckett — Live agent registry (`src/agent/registry.ts`)
 * =======================================================================================
 * The daemon-facing read side of the agent store (issue #66). This is the API the
 * concierge/dispatcher call to enumerate known agents at runtime (the surface #55.3's discovery
 * prompting builds on), and the thing that makes agents.json a LIVE store: every `list()`/`get()`
 * re-reads the file from disk, so a `beckett agent add/rm` is picked up with no redeploy or
 * restart — exactly like the routine scheduler re-reading routines.json each tick.
 *
 * Because this runs INSIDE the daemon, it is deliberately defensive and NEVER throws:
 *
 *   - A missing file → empty list (a fresh install has no agents).
 *   - Unparseable JSON or a bad envelope → log once and fall back to the last good snapshot
 *     (or empty), so a half-written / hand-corrupted file can't blank out or crash the daemon.
 *   - A single malformed agent entry → log and SKIP just that entry; the valid agents still load.
 *
 * The strict, fail-loud parse lives in the CLI mutate path ({@link ./store.ts}); this reader is
 * the forgiving counterpart the running daemon depends on.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Logger } from "../types.ts";
import { AgentDefinitionSchema, type AgentDefinition } from "./types.ts";

/**
 * Lenient envelope: validate the outer shape but keep each agent as `unknown` so one bad entry
 * doesn't reject the whole file. Entries are validated individually below (log-and-skip).
 */
const LenientEnvelopeSchema = z.object({
  agents: z.array(z.unknown()).default([]),
});

export interface LiveAgentRegistryOptions {
  logger?: Logger;
}

export class LiveAgentRegistry {
  private readonly path: string;
  private readonly logger?: Logger;
  /** Last successfully-parsed snapshot, returned if a later read is unparseable. */
  private lastGood: AgentDefinition[] = [];

  constructor(path: string, opts: LiveAgentRegistryOptions = {}) {
    this.path = path;
    this.logger = opts.logger;
  }

  /** All valid agents on disk right now, sorted by id. Never throws; bad entries are skipped. */
  list(): AgentDefinition[] {
    return this.load();
  }

  /** One agent by id, or null. Never throws. */
  get(id: string): AgentDefinition | null {
    return this.load().find((a) => a.id === id) ?? null;
  }

  private load(): AgentDefinition[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Fresh install / not created yet — an empty registry is the correct answer, not an error.
        this.lastGood = [];
        return [];
      }
      this.logger?.warn("agent registry could not be read; using last good snapshot", {
        path: this.path,
        error: (err as Error).message,
      });
      return this.lastGood;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger?.warn("agent registry is not valid JSON; using last good snapshot", {
        path: this.path,
        error: (err as Error).message,
      });
      return this.lastGood;
    }

    const envelope = LenientEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      this.logger?.warn("agent registry envelope is malformed; using last good snapshot", {
        path: this.path,
        error: envelope.error.message,
      });
      return this.lastGood;
    }

    const agents: AgentDefinition[] = [];
    for (const entry of envelope.data.agents) {
      const result = AgentDefinitionSchema.safeParse(entry);
      if (result.success) {
        agents.push(result.data);
      } else {
        const id = (entry as { id?: unknown } | null)?.id;
        this.logger?.warn("skipping malformed agent definition in registry", {
          path: this.path,
          id: typeof id === "string" ? id : "(unknown)",
          error: result.error.message,
        });
      }
    }

    agents.sort((a, b) => a.id.localeCompare(b.id));
    this.lastGood = agents;
    return agents;
  }
}
