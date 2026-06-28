/**
 * Beckett — id scheme (`src/ids.ts`)
 * =======================================================================================
 * Stable, URL-safe, collision-safe ids (Spec 09 §2: beckett-minted opaque TEXT, NOT
 * autoincrement). Two families:
 *
 *   1. **Prefixed short ids** — `task_…`, `node_…`, `wk_…`, etc. Derived from
 *      `crypto.randomUUID()` hex (entropy-dense; ~48 bits in the default slice is ample for
 *      a single-box daemon, and a full-uuid escape hatch exists). Used for rows the human
 *      and the JSONL log reference.
 *   2. **ULID** — `ev_…` for the event log (Spec 09 §3.2): monotonic, lexicographically
 *      time-sortable, collision-free across restarts.
 *
 * The CLI's *display* ids (bare integer task, `42.1` node, `w-7f3a` worker — Spec 10 §2) are
 * a presentation concern layered over these canonical ids by the CLI/Store, not minted here.
 */

import { randomUUID } from "node:crypto";

/** Default entropy slice length (hex chars) for prefixed ids. */
const SHORT_LEN = 8;

/** Hex entropy from a v4 UUID, dashes stripped. */
function hex(): string {
  return randomUUID().replace(/-/g, "");
}

/** A prefixed short id, e.g. `prefixedId("task")` → "task_1a2b3c4d". */
export function prefixedId(prefix: string, len = SHORT_LEN): string {
  return `${prefix}_${hex().slice(0, len)}`;
}

export const taskId = (): string => prefixedId("task");
export const nodeId = (): string => prefixedId("node");
export const workerId = (): string => prefixedId("wk");
export const criteriaId = (): string => prefixedId("crit");
export const gateOutcomeId = (): string => prefixedId("gate");
export const checkInId = (): string => prefixedId("ci");
export const nudgeId = (): string => prefixedId("nudge");
export const escalationId = (): string => prefixedId("esc");
export const pendingActionId = (): string => prefixedId("pa");
export const outcomeId = (): string => prefixedId("out");

/** A uuid for IPC request correlation (Spec 10 §8.2). */
export const requestId = (): string => randomUUID();

// =======================================================================================
// ULID — monotonic, time-sortable (for the event log; Spec 09 §3.2)
// =======================================================================================

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const TIME_LEN = 10; // 48-bit timestamp → 10 chars
const RAND_LEN = 16; // 80-bit randomness → 16 chars

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = CROCKFORD[mod] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(): number[] {
  const a = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b % 32);
}

/** Increment the random part in place for same-millisecond monotonicity. */
function incrementRand(r: number[]): number[] {
  const out = r.slice();
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    const cur = out[i] ?? 0;
    if (cur < 31) {
      out[i] = cur + 1;
      return out;
    }
    out[i] = 0;
  }
  // overflow (astronomically unlikely) — reseed
  return randomChars();
}

/**
 * Generate a monotonic ULID. Within the same millisecond the random component is
 * incremented so ids remain strictly increasing (Spec 09: monotonic, sortable).
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRand = incrementRand(lastRand);
  } else {
    lastTime = now;
    lastRand = randomChars();
  }
  const rand = lastRand.map((n) => CROCKFORD[n]).join("");
  return encodeTime(now) + rand;
}

/** An event-log id: `ev_<ULID>` (Spec 09 §3.2). */
export const eventId = (): string => `ev_${ulid()}`;

/** A generic ULID-backed id with a prefix (e.g. AwaitingReply ULIDs, Spec 05 §4.1). */
export const ulidId = (prefix: string): string => `${prefix}_${ulid()}`;
