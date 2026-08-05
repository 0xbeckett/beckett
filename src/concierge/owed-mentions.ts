/**
 * Beckett — the owed-mention ledger (`src/concierge/owed-mentions.ts`)
 * =======================================================================================
 * A directed @mention/DM is a DEBT: someone asked Beckett something and is waiting. This file
 * is where that debt is written down, durably, for exactly as long as it is unpaid.
 *
 * ── WHY IT HAS TO BE DURABLE ───────────────────────────────────────────────────────────
 * Boot reconciliation (`Concierge.reconcileDowntimeMessages`) already recovers the messages a
 * downed daemon never SAW: it re-fetches everything after the channel store's cursor. But that
 * cursor advances at CAPTURE time, not at ANSWER time — so a mention the daemon received, stored,
 * and then failed to answer (its turn was still generating when the deploy's SIGTERM landed) sits
 * BEHIND the cursor and is invisible to reconciliation forever. That is the whole restart-window
 * bug: the message was seen, so nothing replays it; the turn died, so nothing answered it; and the
 * person is told to ask again.
 *
 * So the cursor cannot be the record of what is owed. This ledger is, and it is keyed on the one
 * thing that matters: has this mention been ANSWERED yet.
 *
 * ── THE ONE INVARIANT: NEVER ANSWER TWICE ──────────────────────────────────────────────
 * A replay that double-posts is worse than a replay that never happens — a missed answer costs
 * one re-ask, a duplicated answer costs trust in every answer. So an entry moves to
 * `delivering` BEFORE the outbound post is attempted, never after. If the daemon dies in that
 * window the entry says "I may already have answered", and the replay path treats that as a
 * question to VERIFY against Discord rather than a message to blindly re-answer.
 *
 * ── STANDING RULES ─────────────────────────────────────────────────────────────────────
 *   - Never throw into a turn. Every fs failure degrades to the in-memory map and logs; a
 *     ledger that can break the reply path is worse than no ledger.
 *   - Lazy on the filesystem: constructing the store touches nothing (the Concierge constructor
 *     is required to be fs-free), the first claim/list reads.
 *   - Bounded on both axes — count and age. A mention nobody answered by tomorrow should stay
 *     unanswered: replying to yesterday's question out of nowhere is its own kind of broken.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, Logger } from "../types.ts";

/**
 * Where an owed mention is in its life.
 *
 * `queued` — claimed, and no outbound post for it has been ATTEMPTED yet. Safe to replay blind:
 * nothing was said to this person, so a replay cannot duplicate anything.
 *
 * `delivering` — a post for this mention was attempted (the auto-post, or a `beckett discord
 * reply` from inside the turn). The reply probably landed; the process may simply have died
 * before the entry could be settled. NOT safe to replay blind — see the double-post rule above.
 */
export type OwedMentionPhase = "queued" | "delivering";

/** One unpaid debt: the message verbatim, plus just enough state to replay it exactly once. */
export interface OwedMention {
  /** Discord message id — the ledger key, and the reply target on replay. */
  messageId: string;
  channelId: string;
  /**
   * The inbound message VERBATIM, so a replay re-enters `Concierge.onMessage` through the ordinary
   * directed path (access gates, shared context, attachments, reply context — all of it) instead
   * of through a second, subtly different code path that would drift from the real one.
   */
  message: IncomingMessage;
  /** Epoch ms of the first claim. Drives the age bound; never reset by a re-claim. */
  claimedAt: number;
  /** Boot replays already SPENT on this mention (incremented before the attempt, not after). */
  replays: number;
  phase: OwedMentionPhase;
}

/**
 * How many boot replays one mention gets before the honest "that turn died" line is the answer.
 * Two, not one: the common failure is a single restart, and a mention unlucky enough to land in a
 * second restart window (a deploy that needed a follow-up deploy — this happened three times in
 * one evening) still deserves its answer. Past that the failure is not a restart, it is something
 * structural about the message itself, and re-running it forever would be a boot-loop of one
 * person's question.
 */
export const OWED_MENTION_MAX_REPLAYS = 2;

/**
 * Age past which an owed mention is dropped unanswered.
 *
 * Twelve hours is chosen from what the reply would MEAN, not from what the machine can store.
 * Answering a two-minute-old question after a deploy reads as recovery; answering last night's
 * question at breakfast, unprompted, with no memory of the conversation that followed it, reads
 * as a malfunction. The failure mode of the bound is a person re-asking, which is exactly the
 * behavior this whole feature replaces — so it is safe to set it where it stops being useful.
 */
export const OWED_MENTION_MAX_AGE_MS = 12 * 60 * 60_000;

/** Hard cap on stored entries; the oldest are dropped first. A bound, not a policy. */
export const OWED_MENTION_MAX_ENTRIES = 200;

export interface OwedMentionStoreOptions {
  /**
   * `<beckettDir>/concierge-owed-mentions.json`, created lazily on the first write. Undefined when
   * the config cannot resolve a beckett dir at all (partial test configs): the store then runs
   * purely in memory — this process still refuses to double-answer, it just has nothing to hand
   * the next boot, which is exactly the pre-ledger behavior.
   */
  file?: string;
  logger: Logger;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
}

export interface OwedMentionStore {
  /** Record a directed mention as owed. Idempotent: a re-claim never resets age or replay count. */
  claim(message: IncomingMessage): void;
  /** Stamp "a post for this mention has been ATTEMPTED" — call BEFORE the post, never after. */
  markDelivering(messageId: string): void;
  /** The debt is paid (answered, deliberately passed, superseded, or given up on). Forget it. */
  settle(messageId: string): void;
  /** Spend one replay on this mention and return how many have now been spent (1 = the first). */
  noteReplay(messageId: string): number;
  /** Everything still owed, oldest first — replay order is conversation order. */
  list(): OwedMention[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accept only rows we could actually replay. A row missing a live channel/message id, the message
 * body, or the author it must reply TO is unusable — dropping it silently is better than carrying
 * a shape that would throw (or post to nobody) halfway through a boot replay.
 */
function parseEntry(raw: unknown): OwedMention | null {
  if (!isRecord(raw)) return null;
  const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
  const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
  const message = raw.message;
  if (!messageId || !channelId || !isRecord(message)) return null;
  if (typeof message.userId !== "string" || !message.userId) return null;
  return {
    messageId,
    channelId,
    message: message as unknown as IncomingMessage,
    claimedAt: typeof raw.claimedAt === "number" ? raw.claimedAt : 0,
    replays: typeof raw.replays === "number" && raw.replays > 0 ? Math.floor(raw.replays) : 0,
    phase: raw.phase === "delivering" ? "delivering" : "queued",
  };
}

export function createOwedMentionStore(opts: OwedMentionStoreOptions): OwedMentionStore {
  const now = opts.now ?? Date.now;
  const maxEntries = Math.max(1, opts.maxEntries ?? OWED_MENTION_MAX_ENTRIES);
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? OWED_MENTION_MAX_AGE_MS);
  const log = opts.logger;
  /** Insertion-ordered by claim, which is arrival order, which is conversation order. */
  let entries: Map<string, OwedMention> | null = null;

  function load(): Map<string, OwedMention> {
    if (entries) return entries;
    const loaded = new Map<string, OwedMention>();
    try {
      if (opts.file && existsSync(opts.file)) {
        const parsed: unknown = JSON.parse(readFileSync(opts.file, "utf8"));
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            const entry = parseEntry(row);
            if (entry) loaded.set(entry.messageId, entry);
          }
        }
      }
    } catch (error) {
      // A corrupt ledger loses the queue; it must never lose the daemon.
      log.warn("owed-mention ledger unreadable — starting empty", { error: String(error) });
    }
    entries = loaded;
    prune();
    return entries;
  }

  /** Age first, then count: an old entry is dropped on its own merits, not because of pressure. */
  function prune(): void {
    const map = entries;
    if (!map) return;
    const cutoff = now() - maxAgeMs;
    for (const [id, entry] of map) {
      if (entry.claimedAt < cutoff) map.delete(id);
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function persist(): void {
    const map = entries;
    if (!map) return;
    prune();
    const file = opts.file;
    if (!file) return; // memory-only (see OwedMentionStoreOptions.file)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify([...map.values()], null, 2) + "\n", { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          /* absent */
        }
        throw error;
      }
    } catch (error) {
      // Degrade to the in-memory map: this run still won't double-answer, and the next boot
      // simply has nothing to replay — the pre-ledger behavior, never worse than it.
      log.warn("owed-mention ledger write failed — queue is in-memory only for this run", {
        error: String(error),
      });
    }
  }

  return {
    claim(message: IncomingMessage): void {
      const map = load();
      if (map.has(message.messageId)) return; // idempotent: age and replay budget survive a re-claim
      map.set(message.messageId, {
        messageId: message.messageId,
        channelId: message.channelId,
        message,
        claimedAt: now(),
        replays: 0,
        phase: "queued",
      });
      persist();
    },

    markDelivering(messageId: string): void {
      const map = load();
      const entry = map.get(messageId);
      if (!entry || entry.phase === "delivering") return;
      entry.phase = "delivering";
      persist();
    },

    settle(messageId: string): void {
      const map = load();
      if (!map.delete(messageId)) return;
      persist();
    },

    noteReplay(messageId: string): number {
      const map = load();
      const entry = map.get(messageId);
      if (!entry) return 0;
      entry.replays += 1;
      // Persisted BEFORE the replay runs, so a replay that itself dies mid-turn still spends its
      // budget. Otherwise a message that reliably kills the daemon replays on every single boot.
      persist();
      return entry.replays;
    },

    list(): OwedMention[] {
      return [...load().values()];
    },
  };
}
