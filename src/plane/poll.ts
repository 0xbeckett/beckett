/**
 * Beckett v3 — Plane poller (`src/plane/poll.ts`)
 * =======================================================================================
 * Turns "what changed in Plane" into the normalized {@link PollEvent} stream the Dispatcher
 * consumes. Holds an in-memory snapshot (`ticketId → {state, updatedAt, lastCommentAt}`); each
 * tick re-reads the project, diffs against the snapshot, and emits:
 *
 *   - unseen ticket                         → `created` (+ a `state_changed{from:null}` if it
 *                                              first appears already in an active state, so the
 *                                              Dispatcher can start work on it).
 *   - `state` differs                       → `state_changed{from,to}` (and `cancelled` too when
 *                                              `to === "cancelled"`, the abort signal).
 *   - new comments on a non-terminal ticket → one `comment_added` per new comment.
 *
 * The poller is read-only and robust: any Plane API error is logged and swallowed (the snapshot
 * is preserved and the tick simply yields fewer/no events). It does NOT spawn anything.
 *
 * Two drive modes:
 *   - The shell calls {@link PlanePoller.poll} on a `config.plane.poll_secs` interval (V3 §4).
 *   - Or call {@link PlanePoller.start} to self-schedule (the convenience start/stop surface).
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

import { log } from "../log.ts";
import type { Logger } from "../types.ts";
import type { PlaneClient } from "./client.ts";
import { TICKET_TERMINAL } from "./types.ts";
import type { PollEvent, Ticket, TicketState } from "./types.ts";

/** One ticket's last-observed signal triplet. */
interface Snapshot {
  state: TicketState;
  updatedAt: string;
  lastCommentAt: string; // ISO of the newest comment we've already emitted
}

/** Constructor dependencies for {@link PlanePoller}. */
export interface PlanePollerDeps {
  client: PlaneClient;
  logger?: Logger;
  /** Self-schedule interval for {@link PlanePoller.start} (seconds). Defaults to 15. */
  pollSecs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** A non-action handler used by {@link PlanePoller.start}. */
export type PollEventSink = (events: PollEvent[]) => void | Promise<void>;

export class PlanePoller {
  private readonly client: PlaneClient;
  private readonly logger: Logger;
  private readonly pollSecs: number;
  private readonly now: () => number;

  private readonly snapshot = new Map<string, Snapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: PlanePollerDeps) {
    this.client = deps.client;
    this.logger = deps.logger ?? log.child("plane.poll");
    this.pollSecs = deps.pollSecs ?? 15;
    this.now = deps.now ?? Date.now;
  }

  // ── primary surface (V3 §4) ────────────────────────────────────────────────────────────

  /**
   * One poll cycle: fetch the project's issues, diff against the snapshot, advance the snapshot,
   * and return the new events in order. Never throws — API failures yield an empty/partial batch.
   */
  async poll(): Promise<PollEvent[]> {
    let tickets: Ticket[];
    try {
      tickets = await this.client.listIssues();
    } catch (err) {
      this.logger.warn("poll: listIssues failed — skipping tick", {
        error: (err as Error).message,
      });
      return [];
    }

    const events: PollEvent[] = [];
    const seen = new Set<string>();

    for (const ticket of tickets) {
      seen.add(ticket.id);
      const prev = this.snapshot.get(ticket.id);

      if (!prev) {
        // First sight: announce creation; seed comment cursor at "now" so we never replay the
        // ticket's whole comment history. If it appears already in an active state, also emit a
        // state_changed{from:null} so the Dispatcher can pick up in-flight work.
        events.push({ kind: "created", ticket });
        if (ticket.state === "in_progress" || ticket.state === "in_review") {
          events.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
        }
        this.snapshot.set(ticket.id, {
          state: ticket.state,
          updatedAt: ticket.updatedAt,
          lastCommentAt: new Date(this.now()).toISOString(),
        });
        continue;
      }

      // State transition.
      if (prev.state !== ticket.state) {
        events.push({ kind: "state_changed", ticket, from: prev.state, to: ticket.state });
        if (ticket.state === "cancelled") events.push({ kind: "cancelled", ticket });
        prev.state = ticket.state;
      }
      prev.updatedAt = ticket.updatedAt;

      // New comments (only worth checking while the ticket can still host a worker).
      if (!TICKET_TERMINAL.has(ticket.state)) {
        await this.collectComments(ticket, prev, events);
      }
    }

    // Forget tickets that vanished from Plane (deleted) — no event, just snapshot hygiene.
    for (const id of [...this.snapshot.keys()]) {
      if (!seen.has(id)) this.snapshot.delete(id);
    }

    return events;
  }

  /**
   * Seed the snapshot from the current Plane state and RETURN recovery events for tickets that
   * are already mid-flight, so a restart re-staffs them (workers don't survive a shell restart).
   * Without this, a ticket sitting in `in_progress` after a crash would be orphaned — its state
   * never changes again, so {@link poll} would emit nothing for it.
   *
   * Returns a `state_changed{from:null}` for every `in_progress` ticket (the Dispatcher re-spawns
   * an implementer). `in_review` tickets are surfaced via a warning rather than auto-re-reviewed:
   * the reviewer needs the prior implementation branch, which is not recoverable from Plane alone.
   */
  async prime(): Promise<PollEvent[]> {
    let tickets: Ticket[];
    try {
      tickets = await this.client.listIssues();
    } catch (err) {
      this.logger.warn("prime: listIssues failed — snapshot left empty", {
        error: (err as Error).message,
      });
      return [];
    }
    const nowIso = new Date(this.now()).toISOString();
    const recovery: PollEvent[] = [];
    let inReview = 0;
    for (const ticket of tickets) {
      this.snapshot.set(ticket.id, {
        state: ticket.state,
        updatedAt: ticket.updatedAt,
        lastCommentAt: nowIso,
      });
      if (ticket.state === "in_progress") {
        recovery.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
      } else if (ticket.state === "in_review") {
        inReview++;
      }
    }
    this.logger.info("primed snapshot", {
      tickets: this.snapshot.size,
      recover_in_progress: recovery.length,
      in_review_awaiting_human: inReview,
    });
    if (inReview > 0) {
      this.logger.warn("tickets in in_review at startup are not auto-re-reviewed (no branch)", {
        count: inReview,
      });
    }
    return recovery;
  }

  // ── convenience self-scheduling surface (start/stop) ─────────────────────────────────────

  /**
   * Prime the snapshot, then poll every `pollSecs` and hand each non-empty batch to `onEvents`.
   * Ticks never overlap (a slow tick is skipped, not stacked). Idempotent: a second call is a
   * no-op while already running.
   */
  async start(onEvents: PollEventSink): Promise<void> {
    if (this.timer) return;
    const recovery = await this.prime();
    if (recovery.length > 0) {
      this.logger.info("re-dispatching in-flight tickets after restart", { count: recovery.length });
      await onEvents(recovery);
    }
    this.timer = setInterval(() => {
      void this.tickOnce(onEvents);
    }, this.pollSecs * 1000);
    this.logger.info("poller started", { pollSecs: this.pollSecs });
  }

  /** Stop the self-scheduled interval (no-op if not running). The snapshot is retained. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("poller stopped");
    }
  }

  private async tickOnce(onEvents: PollEventSink): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const events = await this.poll();
      if (events.length > 0) await onEvents(events);
    } catch (err) {
      // poll() is already non-throwing; this guards a throwing onEvents sink.
      this.logger.error("poll tick handler failed", { error: (err as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private async collectComments(
    ticket: Ticket,
    prev: Snapshot,
    events: PollEvent[],
  ): Promise<void> {
    try {
      const comments = await this.client.listComments(ticket.id, prev.lastCommentAt);
      for (const comment of comments) {
        events.push({ kind: "comment_added", ticket, comment });
        if (comment.createdAt > prev.lastCommentAt) prev.lastCommentAt = comment.createdAt;
      }
    } catch (err) {
      // Leave lastCommentAt unchanged so the comment is retried next tick.
      this.logger.warn("poll: listComments failed for ticket", {
        ticketId: ticket.id,
        error: (err as Error).message,
      });
    }
  }
}

/** Factory matching the repo's `createX(deps)` convention. */
export function createPlanePoller(deps: PlanePollerDeps): PlanePoller {
  return new PlanePoller(deps);
}
