/**
 * Beckett — ticket workspaces (`src/discord/workspaces.ts`)
 * =======================================================================================
 * The Coworker-as-a-Service thread model: a workspace is a Discord thread a PERSON opened,
 * registered here so that every authorized message inside it is a directed Concierge turn with no
 * @mention required. Beckett does not create threads — the human decides when a piece of work
 * deserves a dedicated space, opens the thread, and Beckett moves in.
 *
 * The registry is deliberately dumb state, no gateway handle at all:
 *  - **Registration** comes from the gateway's thread-create event ({@link registerThread}),
 *    filtered upstream to user-created threads only.
 *  - **Ticket grounding** is additive. A thread whose name carries ticket identifiers
 *    ("OPS-120 auth rework") binds to them at registration; a ticket filed FROM inside a
 *    workspace binds to it when the Concierge acks it ({@link bindTicket}). A workspace with no
 *    tickets yet is still a workspace — the conversation is directed, just not ticket-grounded.
 *  - **Persistence**: the thread → tickets map is saved to `<beckettDir>/workspaces.json` so
 *    unmentioned routing survives a daemon restart. Best-effort: a corrupt/missing file starts
 *    fresh and new thread-create events rebuild it.
 *
 * The verbose worker play-by-play that used to stream into bot-created progress threads now goes
 * to the private per-ticket journal (`src/progress/journal.ts`) — a workspace only ever carries
 * the human conversation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger, ThreadCreated } from "../types.ts";
import { log as rootLog } from "../log.ts";

/** Ticket context attached to an inbound message from a workspace thread. */
export interface TicketWorkspaceContext {
  parentChannelId: string;
  /** The thread name the person chose — the workspace's human label. */
  name: string;
  /** Ticket identifiers grounded in this workspace (possibly empty for a fresh thread). */
  ticketIdents: string[];
}

export interface WorkspaceRegistryOptions {
  /** JSON file remembering thread → tickets across daemon restarts. Omit to disable persistence. */
  stateFile?: string;
  logger?: Logger;
}

/** Matches ticket identifiers like "OPS-120" inside a thread name. */
const TICKET_IDENT_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

interface StoredWorkspace {
  parentChannelId: string;
  name: string;
  ticketIdents: string[];
}

/**
 * Owns the user-opened-thread → ticket routing map. Constructed by the Concierge, fed by the
 * gateway's thread-create events, and consulted on every inbound message.
 */
export class WorkspaceRegistry {
  private readonly log: Logger;
  private readonly stateFile?: string;
  private readonly byThread = new Map<string, StoredWorkspace>();

  constructor(opts: WorkspaceRegistryOptions = {}) {
    this.log = (opts.logger ?? rootLog).child("workspaces");
    this.stateFile = opts.stateFile;
    this.loadState();
  }

  /**
   * Register a user-created thread as a workspace. Idempotent per thread id; ticket identifiers
   * found in the thread name are bound immediately so "OPS-120 auth rework" is grounded from its
   * first message.
   */
  registerThread(t: ThreadCreated): void {
    const existing = this.byThread.get(t.threadId);
    if (existing) return; // already a workspace — a re-emitted create event changes nothing
    const ticketIdents = [...new Set(t.name.match(TICKET_IDENT_RE) ?? [])];
    this.byThread.set(t.threadId, { parentChannelId: t.parentChannelId, name: t.name, ticketIdents });
    this.log.info("workspace registered from user thread", {
      threadId: t.threadId,
      name: t.name,
      creatorId: t.creatorId,
      tickets: ticketIdents,
    });
    this.saveState();
  }

  /**
   * Ground a filed ticket in the workspace it was filed from. No-op when `channelId` is not a
   * registered workspace (a ticket filed from a plain channel has no workspace to bind to).
   */
  bindTicket(channelId: string, ticketIdent: string): void {
    const ws = this.byThread.get(channelId);
    if (!ws || ws.ticketIdents.includes(ticketIdent)) return;
    ws.ticketIdents.push(ticketIdent);
    this.log.info("ticket bound to workspace", { threadId: channelId, ticket: ticketIdent });
    this.saveState();
  }

  /** Resolve an inbound Discord channel to its workspace context, if it is one. */
  contextFor(channelId: string): TicketWorkspaceContext | null {
    const ws = this.byThread.get(channelId);
    if (!ws) return null;
    return {
      parentChannelId: ws.parentChannelId,
      name: ws.name,
      ticketIdents: [...ws.ticketIdents].sort(),
    };
  }

  private loadState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [threadId, rec] of Object.entries(raw)) {
        if (typeof rec?.parentChannelId !== "string") continue;
        this.byThread.set(threadId, {
          parentChannelId: rec.parentChannelId,
          name: typeof rec.name === "string" ? rec.name : "",
          ticketIdents: Array.isArray(rec.ticketIdents)
            ? rec.ticketIdents.filter((x): x is string => typeof x === "string")
            : [],
        });
      }
    } catch (err) {
      this.log.warn("workspace state load failed; starting fresh", { err: String(err) });
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(
        this.stateFile,
        JSON.stringify(Object.fromEntries(this.byThread.entries()), null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      this.log.warn("workspace state save failed", { err: String(err) });
    }
  }
}

/** Factory matching the repo's `createX` convention. */
export function createWorkspaceRegistry(opts: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  return new WorkspaceRegistry(opts);
}
