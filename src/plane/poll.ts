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
 * is preserved and the tick simply yields fewer/no events). It does NOT spawn anything. Hot-path
 * note: comment reads are gated by issue `updatedAt` and run in parallel for changed tickets, so
 * an unchanged active board does not spend one Plane round-trip per ticket on every tick.
 *
 * Two drive modes:
 *   - The shell calls {@link PlanePoller.poll} on a `config.plane.poll_secs` interval (V3 §4).
 *   - Or call {@link PlanePoller.start} to self-schedule (the convenience start/stop surface).
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";
import type { PlaneClient } from "./client.ts";
import { TICKET_TERMINAL } from "./types.ts";
import type { PollEvent, Ticket, TicketState } from "./types.ts";

/** One ticket's last-observed state plus comment cursors. */
interface Snapshot {
  state: TicketState;
  updatedAt: string;
  /** The last hydrated ticket — reused for the comment sweep so unchanged tickets cost zero hydrations (issue #33). */
  ticket: Ticket;
  lastCommentAt: string; // ISO of the newest comment we've already emitted
  lastCommentIds: Set<string>; // ids already emitted at lastCommentAt, for timestamp ties
  lastCommentSweepAt: number; // epoch ms of the last successful comment cursor check
}

type EventSlot = PollEvent | Promise<PollEvent[]>;
interface CommentCursor {
  lastCommentAt: string;
  lastCommentIds: string[];
}

/** Backstop for Plane installs that do not bump issue updated_at on comments. */
const COMMENT_FULL_SWEEP_MS = 60_000;
const COMMENT_CURSOR_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Constructor dependencies for {@link PlanePoller}. */
export interface PlanePollerDeps {
  client: PlaneClient;
  logger?: Logger;
  /** Self-schedule interval for {@link PlanePoller.start} (seconds). Defaults to 5. */
  pollSecs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Durable comment cursor path. When set, startup sees comments posted while the daemon was down. */
  commentCursorPath?: string;
}

/** A non-action handler used by {@link PlanePoller.start}. */
export type PollEventSink = (events: PollEvent[]) => void | Promise<void>;

export class PlanePoller {
  private readonly client: PlaneClient;
  private readonly logger: Logger;
  private readonly pollSecs: number;
  private readonly now: () => number;
  private readonly commentCursorPath?: string;
  private readonly persistedCommentCursors = new Map<string, CommentCursor>();

  private readonly snapshot = new Map<string, Snapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** The sink handed to {@link start} — kept so {@link poke} can run an immediate tick (issue #33). */
  private sink: PollEventSink | null = null;
  /** A poke arrived while a tick was in flight — run one more as soon as it finishes. */
  private pokePending = false;

  // Health counters for `beckett status` (issue #30): when the last poll landed and how many
  // ticks in a row failed to reach Plane. "Last poll 4s ago, 0 failures" is the healthy answer.
  private lastPollAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(deps: PlanePollerDeps) {
    this.client = deps.client;
    this.logger = deps.logger ?? log.child("plane.poll");
    this.pollSecs = deps.pollSecs ?? 5;
    this.now = deps.now ?? Date.now;
    this.commentCursorPath = deps.commentCursorPath;
    this.loadCommentCursors();
  }

  // ── primary surface (V3 §4) ────────────────────────────────────────────────────────────

  /**
   * One poll cycle. The polling diet (issue #33): sweep the board with the SLIM head list
   * (id + updated_at only — no descriptions, no hydration), then hydrate ONLY the tickets whose
   * `updated_at` actually moved. An unchanged 500-ticket board costs one slim request and zero
   * hydrations — the same tick as a 20-ticket board. Never throws — API failures yield an
   * empty/partial batch.
   */
  async poll(): Promise<PollEvent[]> {
    let heads: Array<{ id: string; updatedAt: string }>;
    try {
      heads = await this.client.listIssueHeads();
      this.consecutiveFailures = 0;
      this.lastPollAt = this.now();
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.warn("poll: listIssueHeads failed — skipping tick", {
        error: (err as Error).message,
        consecutiveFailures: this.consecutiveFailures,
      });
      return [];
    }

    const slots: EventSlot[] = [];
    const seen = new Set<string>();
    const tickStartedAt = this.now();

    // Partition the board: changed/new ids need a hydrate; unchanged non-terminal tickets may
    // still owe the periodic comment backstop (runs off the CACHED ticket — no hydration).
    const changedIds: string[] = [];
    for (const head of heads) {
      seen.add(head.id);
      const prev = this.snapshot.get(head.id);
      if (!prev || prev.updatedAt !== head.updatedAt) {
        changedIds.push(head.id);
        continue;
      }
      const dueForSweep = tickStartedAt - prev.lastCommentSweepAt >= COMMENT_FULL_SWEEP_MS;
      if (!TICKET_TERMINAL.has(prev.state) && dueForSweep) {
        const cached = prev.ticket;
        slots.push(
          this.collectComments(cached, prev).then((result) => {
            if (result.ok) prev.lastCommentSweepAt = tickStartedAt;
            return result.events;
          }),
        );
      }
    }

    const hydrated = await Promise.all(
      changedIds.map(async (id) => {
        try {
          return await this.client.getIssue(id);
        } catch (err) {
          this.logger.warn("poll: getIssue failed for changed ticket — retried next tick", {
            ticketId: id,
            error: (err as Error).message,
          });
          return undefined; // snapshot untouched → updated_at still differs → retried next tick
        }
      }),
    );

    for (let i = 0; i < changedIds.length; i++) {
      const ticket = hydrated[i];
      if (ticket === undefined) continue; // fetch failed — retry next tick
      if (ticket === null) {
        // Deleted between the sweep and the hydrate — same hygiene as vanishing from the board.
        this.snapshot.delete(changedIds[i]!);
        continue;
      }
      const prev = this.snapshot.get(ticket.id);

      if (!prev) {
        // First sight: announce creation; seed comment cursor at "now" so we never replay the
        // ticket's whole comment history. If it appears already in an active state, also emit a
        // state_changed{from:null} so the Dispatcher can pick up in-flight work.
        slots.push({ kind: "created", ticket });
        if (ticket.state === "design" || ticket.state === "in_progress" || ticket.state === "in_review") {
          slots.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
        }
        this.snapshot.set(ticket.id, {
          state: ticket.state,
          updatedAt: ticket.updatedAt,
          ticket,
          ...this.initialCommentCursor(ticket.id),
          lastCommentSweepAt: tickStartedAt,
        });
        continue;
      }

      // State transition.
      if (prev.state !== ticket.state) {
        slots.push({ kind: "state_changed", ticket, from: prev.state, to: ticket.state });
        if (ticket.state === "cancelled") slots.push({ kind: "cancelled", ticket });
        prev.state = ticket.state;
      }
      prev.ticket = ticket;

      // New comments (only worth checking while the ticket can still host a worker). Plane bumps
      // issue updated_at on comment writes, and we only get here when updated_at moved.
      if (!TICKET_TERMINAL.has(ticket.state)) {
        slots.push(
          this.collectComments(ticket, prev).then((result) => {
            if (result.ok) {
              prev.updatedAt = ticket.updatedAt;
              prev.lastCommentSweepAt = tickStartedAt;
            }
            return result.events;
          }),
        );
      } else {
        prev.updatedAt = ticket.updatedAt;
      }
    }

    // Forget tickets that vanished from Plane (deleted) — no event, just snapshot hygiene.
    for (const id of [...this.snapshot.keys()]) {
      if (!seen.has(id)) this.snapshot.delete(id);
    }

    const batches = await Promise.all(
      slots.map(async (slot) => {
        const resolved = await slot;
        return Array.isArray(resolved) ? resolved : [resolved];
      }),
    );
    return batches.flat();
  }

  /**
   * Seed the snapshot from the current Plane state and RETURN recovery events for tickets that
   * are already mid-flight, so a restart re-staffs them (workers don't survive a shell restart).
   * Without this, a ticket sitting in `in_progress` after a crash would be orphaned — its state
   * never changes again, so {@link poll} would emit nothing for it.
   *
   * Returns a `state_changed{from:null}` for every active ticket, so restart recovery re-staffs
   * implementers and reviewers. v3.1 uses persistent project repos, so review can diff the existing
   * checkout even when the daemon lost its in-memory worker handle.
   */
  async prime(): Promise<PollEvent[]> {
    let tickets: Ticket[];
    try {
      tickets = await this.client.listIssues();
      this.consecutiveFailures = 0;
      this.lastPollAt = this.now();
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.warn("prime: listIssues failed — snapshot left empty", {
        error: (err as Error).message,
      });
      return [];
    }
    const nowIso = new Date(this.now()).toISOString();
    const recovery: PollEvent[] = [];
    const commentRecovery: Promise<PollEvent[]>[] = [];
    let inDesign = 0;
    let recoverInProgress = 0;
    let inReview = 0;
    for (const ticket of tickets) {
      const snapshot: Snapshot = {
        state: ticket.state,
        updatedAt: ticket.updatedAt,
        ticket,
        ...this.initialCommentCursor(ticket.id, nowIso),
        lastCommentSweepAt: this.now(),
      };
      this.snapshot.set(ticket.id, snapshot);
      if (ticket.state === "design") {
        // INT's Review (Design) deliberately does NOT appear here: it is a human-only parked gate.
        recovery.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
        inDesign++;
        commentRecovery.push(this.collectComments(ticket, snapshot).then((result) => result.events));
      } else if (ticket.state === "in_progress") {
        recovery.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
        recoverInProgress++;
        commentRecovery.push(this.collectComments(ticket, snapshot).then((result) => result.events));
      } else if (ticket.state === "in_review") {
        recovery.push({ kind: "state_changed", ticket, from: null, to: ticket.state });
        inReview++;
        commentRecovery.push(this.collectComments(ticket, snapshot).then((result) => result.events));
      }
    }
    for (const events of await Promise.all(commentRecovery)) recovery.push(...events);
    this.logger.info("primed snapshot", {
      tickets: this.snapshot.size,
      recover_design: inDesign,
      recover_in_progress: recoverInProgress,
      recover_in_review: inReview,
    });
    return recovery;
  }

  // ── convenience self-scheduling surface (start/stop) ─────────────────────────────────────

  /**
   * Prime the snapshot, then poll every `pollSecs` and hand each batch to `onEvents`. Empty batches
   * are delivered too, so downstream maintenance like durable outbox replay runs on every tick.
   * Ticks never overlap (a slow tick is skipped, not stacked). Idempotent: a second call is a no-op
   * while already running.
   */
  async start(onEvents: PollEventSink): Promise<void> {
    if (this.timer) return;
    this.sink = onEvents;
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

  /**
   * Poll-loop health for `beckett status` (issue #30). `lastPollAgeMs` is null until the first
   * successful poll; `consecutiveFailures` counts back-to-back ticks that never reached Plane.
   */
  stats(): { lastPollAt: number | null; lastPollAgeMs: number | null; consecutiveFailures: number } {
    return {
      lastPollAt: this.lastPollAt,
      lastPollAgeMs: this.lastPollAt === null ? null : this.now() - this.lastPollAt,
      consecutiveFailures: this.consecutiveFailures,
    };
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
      await onEvents(events);
    } catch (err) {
      // poll() is already non-throwing; this guards a throwing onEvents sink.
      this.logger.error("poll tick handler failed", { error: (err as Error).message });
    } finally {
      this.ticking = false;
      if (this.pokePending) {
        this.pokePending = false;
        setTimeout(() => this.poke(), 0);
      }
    }
  }

  /**
   * Run one tick NOW (issue #33): `beckett ticket create --state in_progress` already pings the
   * control bus, so v4-main routes that ping here and the dispatcher staffs the ticket in well
   * under a second instead of waiting out the 0–5s poll gap. A poke during an in-flight tick is
   * remembered and runs one follow-up tick (the freshly-filed ticket must not slip through).
   * No-op before {@link start}.
   */
  poke(): void {
    if (!this.sink || !this.timer) return;
    if (this.ticking) {
      this.pokePending = true;
      return;
    }
    void this.tickOnce(this.sink);
  }

  /**
   * Fold an externally-observed state transition into the snapshot (issue #33): when the
   * DISPATCHER advances a ticket it also notifies the concierge directly, so the next poll must
   * not re-emit the same transition as a duplicate event. The comment cursor is untouched — the
   * advance comment still flows (on non-terminal states) exactly as before.
   */
  observe(event: PollEvent): void {
    if (event.kind !== "state_changed") return;
    const prev = this.snapshot.get(event.ticket.id);
    if (!prev) return;
    prev.state = event.to;
    prev.ticket = { ...prev.ticket, state: event.to };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private async collectComments(
    ticket: Ticket,
    prev: Snapshot,
  ): Promise<{ events: PollEvent[]; ok: boolean }> {
    try {
      const events: PollEvent[] = [];
      const comments = await this.client.listComments(ticket.id, prev.lastCommentAt, {
        inclusive: prev.lastCommentIds.size > 0,
      });
      for (const comment of comments) {
        if (
          comment.createdAt < prev.lastCommentAt ||
          (comment.createdAt === prev.lastCommentAt && prev.lastCommentIds.has(comment.id))
        ) {
          continue;
        }
        events.push({ kind: "comment_added", ticket, comment });
        if (comment.createdAt > prev.lastCommentAt) {
          prev.lastCommentAt = comment.createdAt;
          prev.lastCommentIds = new Set([comment.id]);
        } else {
          prev.lastCommentIds.add(comment.id);
        }
      }
      this.persistCommentCursor(ticket.id, prev);
      return { events, ok: true };
    } catch (err) {
      // Leave lastCommentAt and updatedAt unchanged so the comment is retried next tick.
      this.logger.warn("poll: listComments failed for ticket", {
        ticketId: ticket.id,
        error: (err as Error).message,
      });
      return { events: [], ok: false };
    }
  }

  private initialCommentCursor(
    ticketId: string,
    fallback = new Date(this.now()).toISOString(),
  ): Pick<Snapshot, "lastCommentAt" | "lastCommentIds"> {
    const lowerBound = new Date(this.now() - COMMENT_CURSOR_LOOKBACK_MS).toISOString();
    const cursor = this.persistedCommentCursors.get(ticketId);
    if (!cursor) return { lastCommentAt: fallback, lastCommentIds: new Set() };
    return {
      lastCommentAt: cursor.lastCommentAt > lowerBound ? cursor.lastCommentAt : lowerBound,
      lastCommentIds: new Set(cursor.lastCommentIds),
    };
  }

  private loadCommentCursors(): void {
    if (!this.commentCursorPath || !existsSync(this.commentCursorPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.commentCursorPath, "utf8")) as Record<
        string,
        CommentCursor
      >;
      for (const [ticketId, cursor] of Object.entries(raw)) {
        if (
          typeof cursor?.lastCommentAt === "string" &&
          Array.isArray(cursor.lastCommentIds) &&
          cursor.lastCommentIds.every((id) => typeof id === "string")
        ) {
          this.persistedCommentCursors.set(ticketId, cursor);
        }
      }
    } catch (err) {
      this.logger.warn("comment cursor file unreadable; starting with empty cursors", {
        path: this.commentCursorPath,
        error: (err as Error).message,
      });
    }
  }

  private persistCommentCursor(ticketId: string, snapshot: Snapshot): void {
    if (!this.commentCursorPath) return;
    this.persistedCommentCursors.set(ticketId, {
      lastCommentAt: snapshot.lastCommentAt,
      lastCommentIds: [...snapshot.lastCommentIds].sort(),
    });
    try {
      mkdirSync(dirname(this.commentCursorPath), { recursive: true });
      const body = JSON.stringify(Object.fromEntries(this.persistedCommentCursors), null, 2) + "\n";
      const tmp = `${this.commentCursorPath}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.commentCursorPath);
    } catch (err) {
      this.logger.warn("comment cursor persist failed", {
        path: this.commentCursorPath,
        error: (err as Error).message,
      });
    }
  }
}

/** Factory matching the repo's `createX(deps)` convention. */
export function createPlanePoller(deps: PlanePollerDeps): PlanePoller {
  return new PlanePoller(deps);
}
