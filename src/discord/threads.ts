/**
 * Beckett v3 — Discord work-thread registry (`src/discord/threads.ts`)
 * =======================================================================================
 * The durable record of which Discord threads BECKETT ITSELF created for a ticket, so the
 * Concierge can treat messages inside them as addressed to the worker WITHOUT an @mention
 * (OPS-59). This is the single source of truth for the load-bearing gate in `onMessage`:
 *
 *   - Only threads registered here bypass the mention requirement. A thread created by anyone
 *     else — or the parent channel — is NOT in this map, so it stays mention-gated. That's how
 *     "ONLY threads Beckett created" is enforced: membership in this registry, nothing looser.
 *   - Each entry maps a Discord thread id → the ticket it hosts. When the ticket reaches a
 *     terminal state (done/cancelled) the entry is marked `terminal` and {@link isActive} goes
 *     false — the thread stops auto-triggering (goes cold), but the record is kept for audit.
 *
 * File-backed (JSON at `<beckettDir>/threads.json`), mirroring the `access.txt` / `identities.json`
 * convention: small, human-inspectable state, no DB. Every method is best-effort and NEVER throws —
 * a corrupt/unreadable file degrades to an empty registry (fail-safe: unknown thread ⇒ mention-gated,
 * never an accidental widening).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.ts";

/** One Beckett-created work thread, bound to the ticket it hosts. */
export interface ThreadEntry {
  /** The Discord thread's channel id (what inbound messages in it carry as `channelId`). */
  threadId: string;
  /** The Plane issue id (UUID) this thread is the work thread for. */
  ticketId: string;
  /** Human ticket ref (e.g. `OPS-59`) — for logs + the steering framing. */
  ticketIdentifier: string;
  /** The parent channel the thread was spun off from (the ticket's origin channel). */
  parentChannelId: string;
  /** True once the ticket is done/cancelled — the thread goes cold (stops auto-triggering). */
  terminal: boolean;
  /** ISO-8601 creation stamp (audit only). */
  createdAt: string;
}

/** On-disk shape. Versioned so the format can evolve without a silent mis-parse. */
interface ThreadFile {
  version: 1;
  threads: ThreadEntry[];
}

/**
 * Persistent thread↔ticket map. Keyed both ways: by thread id (the hot path — every inbound
 * message checks {@link isActive}) and by ticket id (so a terminal state transition can cool the
 * right thread). Held in memory and flushed to disk on every mutation.
 */
export class ThreadRegistry {
  private readonly byThread = new Map<string, ThreadEntry>();
  private readonly byTicket = new Map<string, ThreadEntry>();
  private readonly file: string;
  private readonly log?: Logger;

  constructor(file: string, logger?: Logger) {
    this.file = file;
    this.log = logger?.child?.("threads");
    this.load();
  }

  /**
   * Record a newly-created Beckett thread for a ticket. Idempotent per thread id (a repeat
   * registration overwrites the entry, e.g. re-registering after a restart). Persists immediately.
   */
  register(entry: Omit<ThreadEntry, "terminal" | "createdAt"> & Partial<Pick<ThreadEntry, "terminal" | "createdAt">>): ThreadEntry {
    const full: ThreadEntry = {
      threadId: entry.threadId,
      ticketId: entry.ticketId,
      ticketIdentifier: entry.ticketIdentifier,
      parentChannelId: entry.parentChannelId,
      terminal: entry.terminal ?? false,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    };
    this.byThread.set(full.threadId, full);
    this.byTicket.set(full.ticketId, full);
    this.save();
    return full;
  }

  /** The entry for a thread id, or undefined if we never created a thread there. */
  get(threadId: string): ThreadEntry | undefined {
    return this.byThread.get(threadId);
  }

  /** The thread entry for a ticket id, if Beckett created one. */
  getByTicket(ticketId: string): ThreadEntry | undefined {
    return this.byTicket.get(ticketId);
  }

  /** True iff we have a NON-terminal thread at this id — i.e. it should auto-trigger the worker. */
  isActive(threadId: string): boolean {
    const e = this.byThread.get(threadId);
    return !!e && !e.terminal;
  }

  /** True iff a (non-terminal) thread already exists for this ticket (dedup thread creation). */
  hasActiveTicketThread(ticketId: string): boolean {
    const e = this.byTicket.get(ticketId);
    return !!e && !e.terminal;
  }

  /**
   * Cool the thread for a ticket that reached a terminal state (done/cancelled): mark it terminal
   * so {@link isActive} goes false and the thread stops auto-triggering. No-op if no thread exists.
   * Returns the (now-terminal) entry so the caller can post a final note in it.
   */
  markTerminalByTicket(ticketId: string): ThreadEntry | undefined {
    const e = this.byTicket.get(ticketId);
    if (!e || e.terminal) return undefined;
    e.terminal = true;
    this.save();
    return e;
  }

  // ── persistence (best-effort; never throws) ────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as ThreadFile;
      const list = Array.isArray(raw?.threads) ? raw.threads : [];
      for (const e of list) {
        // FAIL-SAFE PARSE: a malformed row is skipped, never trusted as an active thread.
        if (!e || typeof e.threadId !== "string" || typeof e.ticketId !== "string") continue;
        const entry: ThreadEntry = {
          threadId: e.threadId,
          ticketId: e.ticketId,
          ticketIdentifier: typeof e.ticketIdentifier === "string" ? e.ticketIdentifier : e.ticketId,
          parentChannelId: typeof e.parentChannelId === "string" ? e.parentChannelId : "",
          terminal: e.terminal === true,
          createdAt: typeof e.createdAt === "string" ? e.createdAt : new Date(0).toISOString(),
        };
        this.byThread.set(entry.threadId, entry);
        this.byTicket.set(entry.ticketId, entry);
      }
    } catch (err) {
      // Corrupt file ⇒ empty registry ⇒ everything stays mention-gated (safe default).
      this.log?.warn?.("thread registry load failed (treating as empty)", { file: this.file, err: String(err) });
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const data: ThreadFile = { version: 1, threads: [...this.byThread.values()] };
      writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch (err) {
      this.log?.warn?.("thread registry save failed (in-memory only)", { file: this.file, err: String(err) });
    }
  }
}
