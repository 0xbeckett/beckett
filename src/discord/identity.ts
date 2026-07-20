/**
 * Discord identity map — per-user known/preferred names keyed on Discord user ID
 * =======================================================================================
 * Every inbound Discord turn carries a user ID (a snowflake). This module is the durable
 * place to hang *who that ID is* and *how they want to be addressed* — so Beckett stops
 * treating everyone in a channel as "the user" and calls each person by their own name.
 *
 * Storage is a single JSON file (`~/.beckett/identities.json`), matching how the rest of
 * Beckett persists small state (access.txt, persona.md) — file-based, no DB. Shape:
 *
 *   { "<discord_id>": { display_name?, known_name?, preferred_address?, notes?,
 *                       is_owner?, created_at, updated_at }, ... }
 *
 * - `display_name`      — the live Discord display name last seen (guild nick / global name).
 *                         Refreshed each turn; a convenience label, not authoritative.
 * - `known_name`        — a stable name we know this person by (seeded for the owner).
 * - `preferred_address` — what THEY told us to call them ("call me X"). Wins over everything.
 * - `is_owner`          — true only for the env-provided owner ID, so the session-context
 *                         owner identity is tied to ONE id, not applied to whoever is typing.
 *
 * PRIVACY: this maps names/handles for ADDRESSING only. It never stores — and Beckett never
 * surfaces in channel — personal contact info (email, phone, etc.). That's a standing rule.
 *
 * Everything here is pure + file-scoped so it's unit-testable: pass a path, get a result,
 * never throw on a missing/corrupt file (degrade to empty), atomic writes via temp+rename.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One person's addressing record, keyed in the map by their Discord user ID. */
export interface UserIdentity {
  /** Live Discord display name last seen (guild nick → global name → username). */
  display_name?: string;
  /** A stable name we know them by (may be seeded, e.g. the owner). */
  known_name?: string;
  /** What they asked to be called ("call me X"). Highest-priority address. */
  preferred_address?: string;
  /** Free-form notes about addressing/context (never contact info). */
  notes?: string;
  /** True for the single env-provided owner id — session owner identity binds here only. */
  is_owner?: boolean;
  /** Epoch ms first recorded. */
  created_at: number;
  /** Epoch ms last touched. */
  updated_at: number;
}

/** The whole map: discord_id → identity. */
export type IdentityMap = Record<string, UserIdentity>;

/** A Discord snowflake is 17–20 digits; validate so a garbage key never poisons the store. */
function isSnowflake(id: string): boolean {
  return /^\d{1,20}$/.test(id);
}

/**
 * Load + parse the identity file. Missing file → empty map (not an error). A corrupt file or
 * a non-object payload also degrades to empty rather than throwing — a bad file must never
 * take down a turn. Malformed keys/values are dropped, mirroring access.ts's fail-safe parse.
 */
export function loadIdentities(file: string): IdentityMap {
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: IdentityMap = {};
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isSnowflake(id)) continue;
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      const v = val as Record<string, unknown>;
      const rec: UserIdentity = {
        created_at: typeof v.created_at === "number" ? v.created_at : 0,
        updated_at: typeof v.updated_at === "number" ? v.updated_at : 0,
      };
      if (typeof v.display_name === "string") rec.display_name = v.display_name;
      if (typeof v.known_name === "string") rec.known_name = v.known_name;
      if (typeof v.preferred_address === "string") rec.preferred_address = v.preferred_address;
      if (typeof v.notes === "string") rec.notes = v.notes;
      if (v.is_owner === true) rec.is_owner = true;
      map[id] = rec;
    }
    return map;
  } catch {
    return {};
  }
}

/** Atomically write the map (temp file + rename), creating the parent dir if needed. */
export function saveIdentities(file: string, map: IdentityMap): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Read one identity, or undefined if we've never seen this id. */
export function getIdentity(file: string, id: string): UserIdentity | undefined {
  return loadIdentities(file)[id];
}

/** Fields a caller may set on upsert (timestamps + owner flag are managed here). */
export type IdentityPatch = Partial<
  Pick<UserIdentity, "display_name" | "known_name" | "preferred_address" | "notes" | "is_owner">
>;

/**
 * Merge `patch` into the record for `id` (creating it if new) and persist. Only keys present
 * in `patch` are touched, so refreshing a live `display_name` never clobbers a `known_name`.
 * An empty-string value clears that field. `now` is injectable for deterministic tests.
 * Returns the resulting record. No-ops (and does not bump `updated_at`) if nothing changed.
 */
export function upsertIdentity(
  file: string,
  id: string,
  patch: IdentityPatch,
  now: number = Date.now(),
): UserIdentity {
  if (!isSnowflake(id)) throw new Error(`invalid discord id: ${id}`);
  const map = loadIdentities(file);
  const prev = map[id];
  const next: UserIdentity = prev
    ? { ...prev }
    : { created_at: now, updated_at: now };

  let changed = !prev;
  for (const [k, v] of Object.entries(patch) as [keyof IdentityPatch, unknown][]) {
    if (k === "is_owner") {
      const flag = v === true;
      if (flag !== (next.is_owner ?? false)) {
        if (flag) next.is_owner = true;
        else delete next.is_owner;
        changed = true;
      }
      continue;
    }
    // String fields: empty string clears; otherwise set when different.
    const str = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
    if (str === "") {
      if (next[k] !== undefined) {
        delete next[k];
        changed = true;
      }
    } else if (next[k] !== str) {
      (next[k] as string) = str;
      changed = true;
    }
  }

  if (!changed) return prev!;
  next.updated_at = now;
  map[id] = next;
  saveIdentities(file, map);
  return next;
}

/**
 * The DELIBERATE name to address this person by: what they asked to be called →
 * a name we know them by. Deliberately does NOT fall back to the live Discord display name — a
 * display name isn't a chosen/known name, and the caller surfaces it separately so the model can
 * use it as its own fallback. Undefined when we have no deliberate name on file.
 */
export function resolveAddress(identity: UserIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  return identity.preferred_address || identity.known_name || undefined;
}

/** A neutral address used only when DISCORD_OWNER_NAME is not configured. */
const DEFAULT_OWNER_NAME = "owner";

/**
 * Ensure the configured owner has an identity entry WITHOUT clobbering anything already
 * recorded. Fresh installs intentionally ship with no identity-map seed: the first entry is
 * derived only from DISCORD_OWNER_ID and DISCORD_OWNER_NAME. The owner is flagged `is_owner`
 * and given a `known_name`, binding session-context ownership to that ONE id rather than to
 * every speaker.
 *
 * Idempotent and additive: an entry that already exists is left as-is (respecting later edits
 * like a "call me X"), we only fill in what's missing. Returns whether the file was written.
 */
export function ensureSeeded(
  file: string,
  ownerId: string | undefined = process.env.DISCORD_OWNER_ID?.trim(),
  ownerName: string = process.env.DISCORD_OWNER_NAME?.trim() || DEFAULT_OWNER_NAME,
  now: number = Date.now(),
): boolean {
  const map = loadIdentities(file);
  let changed = false;

  if (ownerId && isSnowflake(ownerId)) {
    const existing = map[ownerId];
    if (!existing) {
      map[ownerId] = { known_name: ownerName, is_owner: true, created_at: now, updated_at: now };
      changed = true;
    } else if (!existing.is_owner) {
      // Bind ownership to this id if it wasn't already (don't overwrite a chosen name).
      existing.is_owner = true;
      if (!existing.known_name) existing.known_name = ownerName;
      existing.updated_at = now;
      changed = true;
    }
  }

  if (changed) saveIdentities(file, map);
  return changed;
}
