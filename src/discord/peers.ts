/**
 * Beckett — Federation peer list, the living file (`src/discord/peers.ts`)
 * =======================================================================================
 * The owner-managed half of federation. `config.federation.peers` is a *baseline* set by
 * whoever provisions the box (permanent, deploy-managed). THIS file — `~/.beckett/peers.txt`,
 * modeled exactly on `access.txt` — is the **living** list the owner grows on the fly from
 * Discord: "@beckett add @ABot to my peers" appends here and takes effect immediately, no
 * restart. The gateway reads the union of the two.
 *
 * The design mirror is deliberate: like the access whitelist, a peer id is just a line in a
 * newline-delimited file, edits are pure functions on a path, and a missing/corrupt file
 * degrades to empty (never throws). Each owner governs only their OWN Beckett's list — two
 * Becketts actually converse only once BOTH owners have added the other, so mutual consent
 * is structural, not a handshake we have to enforce.
 *
 * Scope note: being on this list only gets a peer PAST the bot-ignore filter (it can talk).
 * It does NOT authorize a peer to spawn work on your fleet — that stays owner-gated elsewhere.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A Discord bot user id is a snowflake: 17–20 digits. Reject anything else at the door. */
export const PEER_ID_RE = /^\d{17,20}$/;

/** Is `id` a syntactically valid Discord user id? (Shape only — not "does this bot exist".) */
export function isValidPeerId(id: string): boolean {
  return PEER_ID_RE.test(id.trim());
}

/**
 * Load the living peer set from `peersFile`. Newline-delimited ids; blank lines and `#`
 * comments ignored; malformed lines skipped (so a hand-edit typo can't poison the set).
 * Never throws — a missing or unreadable file is an empty set (federation simply off).
 */
export function loadPeers(peersFile: string): Set<string> {
  const out = new Set<string>();
  try {
    if (!existsSync(peersFile)) return out;
    for (const raw of readFileSync(peersFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (isValidPeerId(line)) out.add(line);
    }
  } catch {
    // degrade to empty — a broken peer file must never take the gateway down
  }
  return out;
}

/** Atomic full-file write (temp + rename) so a crash mid-write can't truncate the list. */
function writePeers(peersFile: string, ids: Iterable<string>): void {
  mkdirSync(dirname(peersFile), { recursive: true });
  const body =
    "# Beckett federation peers — trusted peer Beckett bot ids (one per line).\n" +
    "# Owner-managed live from Discord (@beckett add/remove); no restart needed.\n" +
    [...ids].join("\n") +
    "\n";
  const tmp = `${peersFile}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, peersFile);
}

export interface PeerMutation {
  ok: boolean;
  /** 'added' | 'already' | 'removed' | 'absent' | 'invalid' — the precise outcome. */
  status: "added" | "already" | "removed" | "absent" | "invalid";
  id: string;
  /** The full peer set AFTER the mutation (for read-back / confirmation). */
  ids: string[];
}

/**
 * Add a peer bot id to the living file. Idempotent (a re-add is `already`, still ok). Rejects a
 * malformed id as `invalid` (ok:false) rather than writing garbage the gateway would ignore.
 */
export function addPeer(peersFile: string, id: string): PeerMutation {
  const clean = id.trim();
  if (!isValidPeerId(clean)) {
    return { ok: false, status: "invalid", id: clean, ids: [...loadPeers(peersFile)] };
  }
  const ids = loadPeers(peersFile);
  if (ids.has(clean)) return { ok: true, status: "already", id: clean, ids: [...ids] };
  ids.add(clean);
  writePeers(peersFile, ids);
  return { ok: true, status: "added", id: clean, ids: [...ids] };
}

/** Remove a peer bot id. Removing one that isn't present is `absent` (still ok:true — no-op). */
export function removePeer(peersFile: string, id: string): PeerMutation {
  const clean = id.trim();
  const ids = loadPeers(peersFile);
  if (!ids.has(clean)) return { ok: true, status: "absent", id: clean, ids: [...ids] };
  ids.delete(clean);
  writePeers(peersFile, ids);
  return { ok: true, status: "removed", id: clean, ids: [...ids] };
}
