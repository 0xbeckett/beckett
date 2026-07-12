/**
 * Discord maintainers — the owner-managed elevated role (OPS-144)
 * =======================================================================================
 * A MAINTAINER is a person the owner trusts with Beckett's privileged repo/daemon actions:
 * push, merge, deploy, restart — on request, with the same authority the owner has for
 * those specific actions. Nothing else: maintainers cannot manage access.txt, cannot add
 * or remove maintainers, and cannot do anything owner-only beyond those four verbs.
 *
 * The list is the union of TWO files, both in access.txt's format (one snowflake per
 * line, '#'/blank ignored, malformed lines dropped fail-safe):
 *
 *   1. The BUNDLED seed — `maintainers.txt` at the repo root, shipped with the source.
 *      Changing it is a code change that goes through review; it cannot be edited by a
 *      runtime grant and `revoke` refuses to touch it.
 *   2. The RUNTIME file — `~/.beckett/maintainers.txt`, grown only by the two-phase
 *      grant flow below.
 *
 * Adding a maintainer is OWNER-ONLY, enforced in code via the exact machinery access.txt
 * uses (src/discord/access.ts): `requestMaintainerGrant` files a pending request with a
 * one-time code; `resolveMaintainerPending` applies it only when the approver's Discord
 * author id — taken from the gateway, never from chat content — matches the owner id.
 * A maintainer echoing the code is refused just like any other non-owner, so there is no
 * self-elevation or peer-elevation path: replacing PR #103's hardcoded-user-id bypass
 * with a mechanism where ids live in maintainers.txt and authority stays with the owner.
 */

import { join } from "node:path";
import {
  loadAccess,
  requestGrant,
  resolvePending,
  revokeAccess,
  type RequestResult,
  type ResolveResult,
  type RevokeResult,
} from "./access.ts";

/** The bundled seed list shipped at the repo root (two levels up from `src/discord/`). */
export function bundledMaintainersFile(): string {
  return join(import.meta.dir, "..", "..", "maintainers.txt");
}

/**
 * Load the effective maintainer set: bundled seed ∪ runtime additions. Both files parse
 * with access.txt's fail-safe rules (via {@link loadAccess}); a missing or corrupt file
 * contributes nothing. Never throws.
 */
export function loadMaintainers(runtimeFile: string, bundledFile: string = bundledMaintainersFile()): Set<string> {
  const ids = new Set<string>(loadAccess(bundledFile).ids);
  for (const id of loadAccess(runtimeFile).ids) ids.add(id);
  return ids;
}

/** Is this Discord user id a maintainer? (The owner is a maintainer implicitly.) */
export function isMaintainer(
  userId: string,
  ownerId: string | undefined,
  runtimeFile: string,
  bundledFile: string = bundledMaintainersFile(),
): boolean {
  if (ownerId && userId === ownerId) return true;
  return loadMaintainers(runtimeFile, bundledFile).has(userId);
}

/**
 * File a maintainer-grant REQUEST (phase 1 — grants nothing). Same semantics as
 * {@link requestGrant}, with one addition: an id already in the bundled seed reports
 * 'already-member' instead of parking a useless request.
 */
export function requestMaintainerGrant(
  pendingFile: string,
  runtimeFile: string,
  id: string,
  ownerId: string | undefined,
  bundledFile: string = bundledMaintainersFile(),
  now: number = Date.now(),
): RequestResult {
  if (/^\d{1,20}$/.test(id) && loadAccess(bundledFile).ids.has(id) && id !== ownerId) {
    return { ok: true, status: "already-member", pendingCount: 0 };
  }
  return requestGrant(pendingFile, runtimeFile, id, ownerId, now);
}

/**
 * Approve or deny a pending maintainer grant (phase 2 — THE owner-only gate). Delegates
 * to {@link resolvePending}, so the approver check, single-use codes, and TTL behave
 * byte-for-byte like access.txt approvals: anything short of the owner's authenticated
 * author id is 'not-owner' and the code survives for the real owner.
 */
export function resolveMaintainerPending(
  pendingFile: string,
  runtimeFile: string,
  code: string,
  approverId: string,
  ownerId: string | undefined,
  action: "approve" | "deny",
  now: number = Date.now(),
): ResolveResult {
  return resolvePending(pendingFile, runtimeFile, code, approverId, ownerId, action, now);
}

/**
 * Revoke a runtime-granted maintainer. Bundled seed ids are refused ('bundled') — they
 * ship with the source and only a reviewed code change removes them.
 */
export function revokeMaintainer(
  runtimeFile: string,
  id: string,
  bundledFile: string = bundledMaintainersFile(),
): RevokeResult | { ok: false; status: "bundled"; count: number; locked: boolean } {
  const bundled = loadAccess(bundledFile).ids;
  if (bundled.has(id)) {
    return { ok: false, status: "bundled", count: loadMaintainers(runtimeFile, bundledFile).size, locked: false };
  }
  return revokeAccess(runtimeFile, id);
}
