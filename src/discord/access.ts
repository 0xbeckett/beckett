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
 *
 * Two-phase grants (hardened bouncer): `grantAccess` is no longer reachable from the CLI.
 * A grant starts as a PENDING REQUEST (`requestGrant` → one-time approval code, short TTL)
 * and only becomes membership when `resolvePending` is called with the owner's Discord user
 * id — which the daemon takes from Discord's own authenticated message author, never from
 * chat content. "An authorised person said it's ok" therefore cannot mint members: the LLM
 * can at most file a request; the approval is code-checked against who actually pressed send.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type AccessLevel = "owner" | "maintainer" | "member" | "outsider";

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
        // FAIL-SAFE PARSE: only accept well-formed snowflake ids (digits, ≤20). A malformed or
        // hand-corrupted line is ignored — never trusted as a member and never inflates the cap
        // count. Keeps loadAccess consistent with grantAccess's own validation.
        if (!/^\d{1,20}$/.test(line)) continue;
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
 * Classify a Discord user as owner / maintainer / member / outsider.
 * - ownerId match => 'owner'
 * - in the maintainer set (OPS-144) => 'maintainer' — a member with push/merge/deploy/restart
 *   authority; strictly below the owner (no access.txt or maintainer-list management)
 * - in the access set => 'member'
 * - else => 'outsider'
 * FAIL-SAFE: if ownerId is empty/undefined, unknown users are 'outsider' (default deny),
 * but known maintainers/members are still allowed.
 */
export function classify(
  userId: string,
  ownerId: string | undefined,
  access: AccessList,
  maintainers?: Set<string>,
): AccessLevel {
  if (ownerId && userId === ownerId) return "owner";
  if (maintainers?.has(userId)) return "maintainer";
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
  // Validate: must be a digits-only Discord snowflake, bounded length (real ids are 17-19
  // digits; cap at 20 so an absurd all-digit string can't be stored).
  if (!/^\d{1,20}$/.test(id)) {
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

// =======================================================================================
// Pending grants — two-phase membership. Request (LLM-reachable) ≠ approve (owner-only).
// =======================================================================================

/** How long a pending grant stays approvable. Short on purpose: a code is a live secret. */
export const PENDING_GRANT_TTL_MS = 10 * 60_000;

/** Code alphabet: uppercase, no 0/O/1/I/L so it survives being read aloud or retyped. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

/** A parked grant request awaiting the owner's approval. */
export interface PendingGrant {
  id: string; // Discord snowflake to be granted
  code: string; // one-time approval code the owner must echo back
  requestedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return code;
}

/**
 * Load pending grants, dropping expired/malformed entries. Never throws — a corrupt or
 * missing file is an empty queue, and a hand-edited entry that fails validation is ignored
 * (fail-safe: nothing malformed is ever approvable).
 */
export function loadPending(pendingFile: string, now: number = Date.now()): PendingGrant[] {
  try {
    if (!existsSync(pendingFile)) return [];
    const raw = JSON.parse(readFileSync(pendingFile, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p: unknown): p is PendingGrant =>
        typeof p === "object" &&
        p !== null &&
        /^\d{1,20}$/.test((p as PendingGrant).id ?? "") &&
        typeof (p as PendingGrant).code === "string" &&
        new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test((p as PendingGrant).code) &&
        typeof (p as PendingGrant).expiresAt === "number" &&
        (p as PendingGrant).expiresAt > now,
    );
  } catch {
    return [];
  }
}

function savePending(pendingFile: string, pending: PendingGrant[]): void {
  writeFileSync(pendingFile, JSON.stringify(pending, null, 2) + "\n", "utf8");
}

export type RequestStatus = "pending" | "invalid-id" | "is-owner" | "already-member" | "locked";

/** Result of filing a grant request. */
export interface RequestResult {
  ok: boolean;
  status: RequestStatus;
  code?: string;
  expiresAt?: number;
  pendingCount: number;
}

/**
 * File a grant REQUEST. Writes nothing to the access file — it parks {id, code, ttl} in the
 * pending queue for the owner to approve. Re-requesting an id replaces its pending entry
 * (fresh code, fresh TTL; the old code dies). All grantAccess preconditions are pre-checked
 * here so the requester gets an honest answer, but they are re-checked at approval time —
 * the queue is advisory, the access file is the truth.
 */
export function requestGrant(
  pendingFile: string,
  accessFile: string,
  id: string,
  ownerId: string | undefined,
  now: number = Date.now(),
): RequestResult {
  const pending = loadPending(pendingFile, now);

  if (!/^\d{1,20}$/.test(id)) return { ok: false, status: "invalid-id", pendingCount: pending.length };
  if (ownerId && id === ownerId) return { ok: true, status: "is-owner", pendingCount: pending.length };

  const access = loadAccess(accessFile);
  if (access.ids.has(id)) return { ok: true, status: "already-member", pendingCount: pending.length };
  if (access.locked) return { ok: false, status: "locked", pendingCount: pending.length };

  const kept = pending.filter((p) => p.id !== id);
  const entry: PendingGrant = {
    id,
    code: generateCode(),
    requestedAt: now,
    expiresAt: now + PENDING_GRANT_TTL_MS,
  };
  kept.push(entry);
  savePending(pendingFile, kept);

  return { ok: true, status: "pending", code: entry.code, expiresAt: entry.expiresAt, pendingCount: kept.length };
}

export type ResolveStatus =
  | "approved"
  | "denied"
  | "not-owner"
  | "unknown-code"
  | "locked"
  | "already-member";

/** Result of an approve/deny attempt. */
export interface ResolveResult {
  ok: boolean;
  status: ResolveStatus;
  id?: string;
  count?: number;
  locked?: boolean;
}

/**
 * Approve or deny a pending grant — THE code-enforced gate.
 *
 * The caller passes `approverId` taken from Discord's authenticated message author (the
 * gateway's `IncomingMessage.userId`), never from message text. Anything short of an exact
 * owner-id match refuses, including when the owner id is unconfigured (fail-safe deny —
 * with no owner there is no approver). Codes are single-use: the pending entry is consumed
 * on approve AND on deny, so a replayed code lands on 'unknown-code'.
 */
export function resolvePending(
  pendingFile: string,
  accessFile: string,
  code: string,
  approverId: string,
  ownerId: string | undefined,
  action: "approve" | "deny",
  now: number = Date.now(),
): ResolveResult {
  if (!ownerId || approverId !== ownerId) return { ok: false, status: "not-owner" };

  const pending = loadPending(pendingFile, now);
  const normalized = code.trim().toUpperCase();
  const entry = pending.find((p) => p.code === normalized);
  if (!entry) return { ok: false, status: "unknown-code" };

  // Consume the code first — approve or deny, it is spent (single-use, no replay).
  savePending(
    pendingFile,
    pending.filter((p) => p.code !== normalized),
  );

  if (action === "deny") return { ok: true, status: "denied", id: entry.id };

  const r = grantAccess(accessFile, entry.id, ownerId);
  if (r.status === "granted") return { ok: true, status: "approved", id: entry.id, count: r.count, locked: r.locked };
  if (r.status === "already-member" || r.status === "is-owner")
    return { ok: true, status: "already-member", id: entry.id, count: r.count, locked: r.locked };
  if (r.status === "locked") return { ok: false, status: "locked", id: entry.id, count: r.count, locked: true };
  // invalid-id can't happen (validated at request time + loadPending), but fail safe anyway.
  return { ok: false, status: "unknown-code" };
}
