/**
 * Discord access control — code-enforced membership gate (pure, testable)
 * =======================================================================================
 * Beckett is invite-only. By default everyone except the owner is in "bouncer mode" —
 * the LLM sees a clear directive telling it not to do work. Granting someone membership
 * adds their Discord user ID (snowflake) to a whitelist file; the code checks that file
 * on every direct mention. The list locks at a hard cap of 10 IDs.
 *
 * access.txt format: one Discord user ID (digits) per line. Lines starting with '#' and
 * blank lines are ignored. The owner ID is NEVER in this file (implicit allow).
 *
 * Lock mechanism: when the 10th ID is added, a `.lock` sentinel file is created and the
 * access.txt file is chmoded to read-only. After locking, all grant/revoke calls refuse.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, chmodSync } from "node:fs";

export type AccessLevel = "owner" | "member" | "outsider";

/** Hard cap on the access list. */
export const ACCESS_CAP = 10;

/** Result of loading the access file. */
export interface AccessList {
  ids: Set<string>;
  locked: boolean;
}

/**
 * Load + parse the access file. Returns { ids, locked }.
 * - Missing file => empty set, unlocked (not an error).
 * - Locked if a sibling `.lock` file exists OR ids.size >= ACCESS_CAP.
 * - Never throws.
 */
export function loadAccess(accessFile: string): AccessList {
  const lockFile = `${accessFile}.lock`;
  let ids = new Set<string>();

  try {
    if (existsSync(accessFile)) {
      const raw = readFileSync(accessFile, "utf8");
      for (let line of raw.split("\n")) {
        line = line.trim();
        if (!line || line.startsWith("#")) continue;
        ids.add(line);
      }
    }
  } catch {
    // ignore read errors; treat as empty
  }

  const locked = existsSync(lockFile) || ids.size >= ACCESS_CAP;
  return { ids, locked };
}

/**
 * Classify a Discord user as owner / member / outsider.
 * - ownerId match => 'owner'
 * - in the access set => 'member'
 * - else => 'outsider'
 * FAIL-SAFE: if ownerId is empty/undefined, unknown users are 'outsider' (default deny),
 * but known members are still allowed.
 */
export function classify(userId: string, ownerId: string | undefined, access: AccessList): AccessLevel {
  if (ownerId && userId === ownerId) return "owner";
  if (access.ids.has(userId)) return "member";
  return "outsider";
}

export type GrantStatus = "granted" | "already-member" | "is-owner" | "locked" | "invalid-id";

/** Result of a grant attempt. */
export interface GrantResult {
  ok: boolean;
  status: GrantStatus;
  count: number;
  locked: boolean;
}

/**
 * Grant access to a Discord user ID.
 * - Validate id is digits-only (snowflake format).
 * - If id === ownerId => 'is-owner' (no-op, ok:true).
 * - If already present => 'already-member' (ok:true).
 * - If locked => 'locked' (ok:false).
 * - Else append the id. If this brings the count to ACCESS_CAP, engage the lock.
 */
export function grantAccess(accessFile: string, id: string, ownerId: string | undefined): GrantResult {
  // Validate: must be digits only (Discord snowflake)
  if (!/^\d+$/.test(id)) {
    return { ok: false, status: "invalid-id", count: 0, locked: false };
  }

  // Owner is implicit; no need to store
  if (id === ownerId) {
    const { ids, locked } = loadAccess(accessFile);
    return { ok: true, status: "is-owner", count: ids.size, locked };
  }

  const access = loadAccess(accessFile);

  // Already locked?
  if (access.locked) {
    return { ok: false, status: "locked", count: access.ids.size, locked: true };
  }

  // Already a member?
  if (access.ids.has(id)) {
    return { ok: true, status: "already-member", count: access.ids.size, locked: false };
  }

  // Append the ID atomically
  appendFileSync(accessFile, `${id}\n`, "utf8");
  access.ids.add(id);

  // Did we just hit the cap? Engage the lock.
  const locked = access.ids.size >= ACCESS_CAP;
  if (locked) {
    const lockFile = `${accessFile}.lock`;
    writeFileSync(lockFile, `locked at ${new Date().toISOString()}\n`, "utf8");
    try {
      chmodSync(accessFile, 0o444); // read-only
    } catch {
      // best-effort; proceed even if chmod fails
    }
  }

  return { ok: true, status: "granted", count: access.ids.size, locked };
}

export type RevokeStatus = "revoked" | "not-member" | "locked";

/** Result of a revoke attempt. */
export interface RevokeResult {
  ok: boolean;
  status: RevokeStatus;
  count: number;
  locked: boolean;
}

/**
 * Revoke access for a Discord user ID.
 * - If locked => refuse (ok:false, 'locked').
 * - If not in the set => 'not-member' (ok:true, no-op).
 * - Else remove the id by rewriting the file (filter out that line).
 */
export function revokeAccess(accessFile: string, id: string): RevokeResult {
  const access = loadAccess(accessFile);

  if (access.locked) {
    return { ok: false, status: "locked", count: access.ids.size, locked: true };
  }

  if (!access.ids.has(id)) {
    return { ok: true, status: "not-member", count: access.ids.size, locked: false };
  }

  // Rewrite the file, filtering out the target ID
  const kept: string[] = [];
  if (existsSync(accessFile)) {
    const raw = readFileSync(accessFile, "utf8");
    for (let line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        kept.push(line); // preserve comments and blank lines
        continue;
      }
      if (trimmed !== id) kept.push(line);
    }
  }

  writeFileSync(accessFile, kept.join("\n") + "\n", "utf8");
  access.ids.delete(id);

  return { ok: true, status: "revoked", count: access.ids.size, locked: false };
}
