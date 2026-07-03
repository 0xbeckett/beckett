/**
 * Beckett v3 — proactivity runtime override store (`src/concierge/proactivity-store.ts`)
 * =======================================================================================
 * The durable side of the `beckett proactivity …` CLI (§4.6). Runtime ambient-interjection
 * controls live OUTSIDE `config.toml` in `~/.beckett/proactivity.json` — the same pattern as
 * `access.txt` / `progress-threads.json` — so the daemon can obey "chill out in here" (and the
 * global kill switch) without a config edit + restart. `config.ts::mergeProactivityOverride`
 * merges this partial `[proactivity]` object over the TOML at read time; here we WRITE it.
 *
 * These helpers only persist. The live effect (the running coordinator honoring the change
 * immediately) comes from the bus handler mutating the shared in-memory `config.proactivity`
 * object — see `Concierge.onBusRequest`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProactivityMode } from "../types.ts";

/** A partial `[proactivity]` block — only the fields the CLI can flip at runtime. */
export interface ProactivityOverride {
  enabled?: boolean;
  default_mode?: ProactivityMode;
  channels?: Record<string, ProactivityMode>;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the current override object. Lenient by design: a missing file is `{}`, and a malformed
 * one degrades to `{}` rather than throwing — the CLI should never wedge on a corrupt runtime
 * file. (`loadConfig` is the strict reader that refuses to boot on bad JSON.)
 */
export function readProactivityOverride(file: string): ProactivityOverride {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? (parsed as ProactivityOverride) : {};
  } catch {
    return {};
  }
}

function writeProactivityOverride(file: string, override: ProactivityOverride): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(override, null, 2) + "\n", "utf8");
}

/** Persist a per-channel mode override (`off | suggest | auto`). Returns the updated object. */
export function setChannelModeOverride(
  file: string,
  channelId: string,
  mode: ProactivityMode,
): ProactivityOverride {
  const override = readProactivityOverride(file);
  override.channels = { ...(isRecord(override.channels) ? override.channels : {}), [channelId]: mode };
  writeProactivityOverride(file, override);
  return override;
}

/** Persist the global `enabled` flag — the kill switch. Returns the updated object. */
export function setEnabledOverride(file: string, enabled: boolean): ProactivityOverride {
  const override = readProactivityOverride(file);
  override.enabled = enabled;
  writeProactivityOverride(file, override);
  return override;
}
