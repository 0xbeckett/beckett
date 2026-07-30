/**
 * Beckett — harness rate-limit cooldowns (`src/drivers/cooldown.ts`)
 * =======================================================================================
 * Cross-cast memory of a quota cap (#133). `preflightFor` checks a harness's auth artifact and
 * version minimum but knows nothing about quota, so a quota-capped pi passes preflight and dies
 * on turn one — burning a worker start AND a healthy-harness substitution slot on a failure we
 * already knew was coming. When that first run dies with a rate_limit/usage-limit classed error
 * we persist a harness-level cooldown here; while it is live {@link preflightFor} reports the
 * harness unusable, so staffing routes straight to the substitute in the existing fallback chain
 * without ever spawning it.
 *
 * The record self-heals: it expires on its own (pi's quota windows are hours, not days) and is
 * cleared by the first clean preflight after expiry, so the harness comes back automatically once
 * quota resets — nobody has to remember to turn it back on. Persisted as one small JSON file under
 * `beckettDir` so the memory survives across casts and daemon restarts.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, ErrorClass, Harness } from "../types.ts";
import { buildPaths } from "../paths.ts";

/**
 * Default cooldown window. Codex/pi usage-limit windows reset in hours, so a few hours keeps a
 * capped harness benched for roughly one quota window without stranding it for a day. Over-long is
 * cheap (the harness just stays on the substitute a while longer); the expiry + clean-preflight
 * self-heal means the only cost of guessing high is a marginally later return, never a stuck one.
 */
export const DEFAULT_COOLDOWN_MS = 4 * 60 * 60_000;

/** One harness's persisted cooldown. */
export interface HarnessCooldown {
  /** Epoch ms after which the cooldown is no longer live. */
  until: number;
  /** The classed error that triggered it (always a quota/rate class today). */
  reason: ErrorClass;
  /** Epoch ms the cooldown was recorded — for `beckett doctor` / debugging. */
  at: number;
}

type CooldownFile = Record<string, HarnessCooldown>;

/** The persisted cooldown ledger lives beside the other durable state under `beckettDir`. */
function cooldownPath(config: Config): string {
  return join(buildPaths(config).beckettDir, "harness-cooldowns.json");
}

/** Lenient read: a missing/corrupt file is simply "no cooldowns", never fatal to a preflight. */
function readAll(path: string): CooldownFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // absent → nothing cooled
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CooldownFile = {};
    for (const [harness, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;
      if (typeof rec.until !== "number") continue;
      out[harness] = {
        until: rec.until,
        reason: (typeof rec.reason === "string" ? rec.reason : "rate_limit") as ErrorClass,
        at: typeof rec.at === "number" ? rec.at : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write (temp + rename) so a concurrent read never sees a half-written ledger. */
function writeAll(path: string, data: CooldownFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * The LIVE cooldown for a harness, or null when none is in force. A record whose `until` has passed
 * is expired: it is treated as not-live here (the clean-preflight path in {@link preflightFor}
 * removes the stale row).
 */
export function activeCooldown(
  harness: Harness,
  config: Config,
  now: number = Date.now(),
): HarnessCooldown | null {
  const rec = readAll(cooldownPath(config))[harness];
  return rec && rec.until > now ? rec : null;
}

/**
 * Persist a cooldown for `harness` and return the record. Called when a run dies with a
 * rate_limit/usage-limit classed error so the next branch routes past the capped harness instead of
 * repeating the doomed spawn.
 */
export function recordCooldown(
  harness: Harness,
  config: Config,
  opts: { now?: number; durationMs?: number; reason?: ErrorClass } = {},
): HarnessCooldown {
  const now = opts.now ?? Date.now();
  const record: HarnessCooldown = {
    until: now + (opts.durationMs ?? DEFAULT_COOLDOWN_MS),
    reason: opts.reason ?? "rate_limit",
    at: now,
  };
  const path = cooldownPath(config);
  const all = readAll(path);
  all[harness] = record;
  writeAll(path, all);
  return record;
}

/**
 * Drop any cooldown for `harness`. Returns true if a record was actually removed (so callers avoid a
 * needless write on the common no-op case). Used to self-heal: a clean preflight after the window
 * clears the expired record so the harness is used again automatically.
 */
export function clearCooldown(harness: Harness, config: Config): boolean {
  const path = cooldownPath(config);
  const all = readAll(path);
  if (!(harness in all)) return false;
  delete all[harness];
  writeAll(path, all);
  return true;
}
