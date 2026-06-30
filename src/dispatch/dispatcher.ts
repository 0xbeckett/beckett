/**
 * Beckett v3 — Dispatcher (`src/dispatch/dispatcher.ts`)
 * =======================================================================================
 * The single consumer of {@link PollEvent}s (emitted by the Plane poller, `docs/V3.md` §4).
 * It is the v3 state machine: it spawns workers when tickets enter `in_progress`/`in_review`,
 * steers live workers from new ticket comments, aborts on `cancelled`, and — when a worker
 * finishes — advances the ticket's Plane state and posts a summary comment. It NEVER does the
 * work itself and NEVER routes through the retired v2 `WorkerManager`/`Store` — it composes
 * the focused {@link spawnWorker} helper (`./spawn.ts`) directly (`docs/V3.md` §5/§6).
 *
 * State-machine table (docs/V3.md §5):
 *
 *   | PollEvent                     | Condition            | Action                                  |
 *   |-------------------------------|----------------------|-----------------------------------------|
 *   | state_changed → in_progress   | no live worker       | spawn casting.implement (default claude)|
 *   | state_changed → in_review     | no live reviewer     | spawn casting.review (default claude)   |
 *   | comment_added                 | live worker, not bot | worker.nudge(comment.body)  (STEERING)  |
 *   | comment_added                 | no live worker       | ignore                                  |
 *   | cancelled                     | live worker          | worker.abort + reap, drop handle        |
 *   | state_changed → done/other    | —                    | reap any live worker; no spawn          |
 *   | created                       | —                    | no spawn (log)                          |
 *
 *   on worker finish:
 *     implement success → setState(in_review) + summary comment (work committed to its branch)
 *     implement error   → comment + LEAVE in in_progress for a human
 *     review   pass     → setState(done) + verdict comment
 *     review   fail     → setState(in_progress) + verdict comment (re-work)
 *
 * Concurrency is bounded by `config.concurrency.max_workers`; over-cap spawns are queued FIFO
 * and pumped as workers free their slots (mirrors the v2 manager's cap behavior).
 */

import type { Config, Logger } from "../types.ts";
import type {
  Ticket,
  TicketState,
  PlaneComment,
  PollEvent,
  HarnessSpec,
} from "../plane/types.ts";
import { log } from "../log.ts";
import { commitWorktree } from "../worker/worktree.ts";
import { spawnWorker, type TicketWorkerHandle } from "./spawn.ts";

// =======================================================================================
// Collaborators
// =======================================================================================

/**
 * The subset of the Plane REST client (`docs/V3.md` §3, `src/plane/client.ts`) the dispatcher
 * uses. Declared structurally so this module does not hard-depend on the parallel-built client
 * — the concrete `PlaneClient` satisfies it.
 */
export interface PlaneClientLike {
  /** Move a ticket to a new lifecycle state (resolves state_map name → Plane state UUID). */
  setState(id: string, state: TicketState): Promise<void>;
  /** Post a comment on a ticket; returns the created comment. */
  addComment(ticketId: string, body: string): Promise<PlaneComment>;
}

/** Construction dependencies for the {@link Dispatcher} (docs/V3.md §5). */
export interface DispatcherDeps {
  client: PlaneClientLike;
  config: Config;
  /** Resolve the absolute git repo root a ticket's worktrees are allocated under. */
  resolveRepoRoot: (ticket: Ticket) => string;
  logger?: Logger;
}

/**
 * Marker prepended to every dispatcher-authored Plane comment so STEERING never treats one of
 * its own summaries as a human nudge (avoids a self-nudge loop, docs/V3.md §5). Rendered as an
 * invisible HTML comment in Plane's markdown.
 */
export const BECKETT_COMMENT_MARKER = "<!-- beckett:dispatcher -->";

/** A spawn deferred because the concurrency cap was reached. */
interface PendingSpawn {
  ticket: Ticket;
  stage: string;
}

// =======================================================================================
// Dispatcher
// =======================================================================================

export class Dispatcher {
  private readonly client: PlaneClientLike;
  private readonly config: Config;
  private readonly resolveRepoRoot: (ticket: Ticket) => string;
  private readonly logger: Logger;

  /** At most one live worker per ticket (implement OR review). */
  private readonly workers = new Map<string, TicketWorkerHandle>();
  /** The branch carrying the latest committed work for a ticket (review/rework base). */
  private readonly branchForTicket = new Map<string, string>();
  /** FIFO queue of spawns waiting for a free concurrency slot. */
  private readonly pending: PendingSpawn[] = [];

  constructor(deps: DispatcherDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.resolveRepoRoot = deps.resolveRepoRoot;
    this.logger = deps.logger ?? log.child("dispatch.dispatcher");
  }

  // ── public surface ─────────────────────────────────────────────────────────────────────

  /**
   * Route one or a batch of poll events through the state machine. Accepts a single
   * {@link PollEvent} (docs/V3.md §5) or an array (task spec); events are handled in order.
   */
  async handle(event: PollEvent | PollEvent[]): Promise<void> {
    if (Array.isArray(event)) {
      for (const e of event) await this.handleOne(e);
    } else {
      await this.handleOne(event);
    }
  }

  /** The live workers, one entry per ticket with an active worker. */
  live(): { ticketId: string; workerId: string }[] {
    return [...this.workers.entries()].map(([ticketId, h]) => ({ ticketId, workerId: h.id }));
  }

  // ── event routing ────────────────────────────────────────────────────────────────────

  private async handleOne(event: PollEvent): Promise<void> {
    switch (event.kind) {
      case "created":
        this.logger.info("ticket created", {
          ticket: event.ticket.identifier,
          state: event.ticket.state,
        });
        return;
      case "state_changed":
        await this.onStateChanged(event.ticket, event.from, event.to);
        return;
      case "comment_added":
        await this.onComment(event.ticket, event.comment);
        return;
      case "cancelled":
        await this.onCancelled(event.ticket);
        return;
    }
  }

  private async onStateChanged(
    ticket: Ticket,
    from: TicketState | null,
    to: TicketState,
  ): Promise<void> {
    this.logger.info("ticket state changed", { ticket: ticket.identifier, from, to });
    switch (to) {
      case "in_progress":
        if (this.workers.has(ticket.id)) return; // already staffed
        this.spawnGuarded(ticket, "implement");
        return;
      case "in_review":
        if (this.workers.has(ticket.id)) return; // already has a reviewer
        this.spawnGuarded(ticket, "review");
        return;
      case "done":
        await this.reapTicket(ticket.id, "ticket done");
        return;
      case "cancelled":
        await this.onCancelled(ticket);
        return;
      case "todo":
      case "backlog":
        // No worker runs in these states; nothing to spawn. A live worker (if any) is left as-is.
        return;
    }
  }

  private async onComment(ticket: Ticket, comment: PlaneComment): Promise<void> {
    const handle = this.workers.get(ticket.id);
    if (!handle) {
      this.logger.debug("comment on ticket with no live worker — ignored", {
        ticket: ticket.identifier,
      });
      return;
    }
    if (this.isBeckettComment(comment)) {
      return; // our own summary/status comment — never self-nudge
    }
    this.logger.info("steering live worker from comment", {
      ticket: ticket.identifier,
      workerId: handle.id,
      author: comment.author,
    });
    await handle.nudge(comment.body);
  }

  private async onCancelled(ticket: Ticket): Promise<void> {
    const handle = this.workers.get(ticket.id);
    this.branchForTicket.delete(ticket.id);
    if (!handle) {
      this.logger.info("ticket cancelled (no live worker)", { ticket: ticket.identifier });
      return;
    }
    this.logger.warn("ticket cancelled — aborting worker", {
      ticket: ticket.identifier,
      workerId: handle.id,
    });
    this.workers.delete(ticket.id);
    await handle.abort("ticket cancelled");
    await handle.reap();
    this.pump();
  }

  // ── spawning + concurrency ─────────────────────────────────────────────────────────────

  /** Spawn immediately if a slot is free, else enqueue for {@link pump}. */
  private spawnGuarded(ticket: Ticket, stage: string): void {
    if (this.workers.size >= this.config.concurrency.max_workers) {
      this.pending.push({ ticket, stage });
      this.logger.info("spawn queued (concurrency cap reached)", {
        ticket: ticket.identifier,
        stage,
        inUse: this.workers.size,
        cap: this.config.concurrency.max_workers,
        queueDepth: this.pending.length,
      });
      return;
    }
    void this.doSpawn(ticket, stage);
  }

  /** Admit queued spawns while slots are free. */
  private pump(): void {
    while (this.pending.length > 0 && this.workers.size < this.config.concurrency.max_workers) {
      const next = this.pending.shift()!;
      if (this.workers.has(next.ticket.id)) continue; // staffed since it was queued
      void this.doSpawn(next.ticket, next.stage);
    }
  }

  /** The real spawn path (cap already checked). Registers the finish handler. */
  private async doSpawn(ticket: Ticket, stage: string): Promise<void> {
    const spec = this.castFor(ticket, stage);
    const repoRoot = this.resolveRepoRoot(ticket);
    const baseRef = this.branchForTicket.get(ticket.id) ?? "HEAD";

    let handle: TicketWorkerHandle;
    try {
      handle = await spawnWorker({
        ticket,
        stage,
        harness: spec,
        config: this.config,
        repoRoot,
        baseRef,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error("spawn failed", {
        ticket: ticket.identifier,
        stage,
        error: (err as Error).message,
      });
      await this.postComment(
        ticket.id,
        `Could not start the ${stage} worker: ${(err as Error).message}. Leaving for a human.`,
      );
      this.pump(); // the slot was never taken
      return;
    }

    this.workers.set(ticket.id, handle);
    handle.onDone((status, summary) => {
      void this.onWorkerDone(ticket, stage, handle, status, summary);
    });
    this.logger.info("worker spawned for ticket", {
      ticket: ticket.identifier,
      stage,
      workerId: handle.id,
      harness: spec.harness,
    });
  }

  /** Resolve the casting entry for a stage, applying defaults (docs/V3.md §5). */
  private castFor(ticket: Ticket, stage: string): HarnessSpec {
    const explicit = ticket.casting[stage];
    if (explicit) return explicit;
    if (stage === "review") {
      return { harness: "claude", model: this.config.models.reviewer };
    }
    return { harness: "claude" };
  }

  // ── finish handling — advance the ticket + post a summary ────────────────────────────────

  private async onWorkerDone(
    ticket: Ticket,
    stage: string,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    // Free the slot first so a queued spawn can take it.
    if (this.workers.get(ticket.id) === handle) this.workers.delete(ticket.id);

    try {
      if (stage === "implement") {
        await this.onImplementDone(ticket, handle, status, summary);
      } else if (stage === "review") {
        await this.onReviewDone(ticket, handle, status, summary);
      } else {
        await this.postComment(ticket.id, `${stage} ${status}.\n\n${summary}`);
      }
    } catch (err) {
      this.logger.error("post-finish handling failed", {
        ticket: ticket.identifier,
        stage,
        error: (err as Error).message,
      });
    } finally {
      await handle.reap();
      this.pump();
    }
  }

  private async onImplementDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    if (status !== "success") {
      this.logger.warn("implement failed — leaving for human", { ticket: ticket.identifier });
      await this.postComment(
        ticket.id,
        `Implementation did not complete — leaving this ticket in **in_progress** for a human.\n\n${summary}`,
      );
      return;
    }

    // Persist the work to the worker's branch so the reviewer (and any re-work) can see it after
    // the worktree is reaped (the branch ref lives in the shared .git).
    try {
      const commit = await commitWorktree(
        handle.workspace,
        `beckett: ${ticket.identifier} implement (${handle.workerId})`,
      );
      this.branchForTicket.set(ticket.id, handle.branch);
      if (commit.committed) {
        this.logger.info("committed implementation", {
          ticket: ticket.identifier,
          branch: handle.branch,
          sha: commit.sha,
        });
      }
    } catch (err) {
      this.logger.warn("commit of implementation failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
    }

    await this.client.setState(ticket.id, "in_review");
    await this.postComment(ticket.id, `Implementation complete → **in_review**.\n\n${summary}`);
    this.logger.info("ticket advanced to in_review", { ticket: ticket.identifier });
  }

  private async onReviewDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    const passed = this.reviewPassed(handle, status);
    if (passed) {
      await this.client.setState(ticket.id, "done");
      await this.postComment(ticket.id, `Review passed → **done**.\n\n${summary}`);
      this.branchForTicket.delete(ticket.id);
      this.logger.info("ticket advanced to done", { ticket: ticket.identifier });
    } else {
      await this.client.setState(ticket.id, "in_progress");
      await this.postComment(
        ticket.id,
        `Review found issues → back to **in_progress** for re-work.\n\n${summary}`,
      );
      this.logger.info("ticket sent back to in_progress (review fail)", {
        ticket: ticket.identifier,
      });
    }
  }

  /**
   * Verdict from a finished reviewer. A clean finish whose structured done-signal says
   * `blocked`/`partial` is a FAIL; an errored reviewer process is also a FAIL (re-work). A clean
   * `complete` (or a clean finish with no structured verdict) is a PASS.
   */
  private reviewPassed(handle: TicketWorkerHandle, status: "success" | "error"): boolean {
    if (status !== "success") return false;
    const structured = handle.result?.structured;
    if (structured && typeof structured === "object") {
      const s = (structured as Record<string, unknown>).status;
      if (s === "blocked" || s === "partial") return false;
      if (s === "complete") return true;
    }
    return true; // clean finish, no explicit blocking verdict
  }

  // ── reaping + comments ───────────────────────────────────────────────────────────────

  /** Reap any live worker for a ticket (terminal-state cleanup). */
  private async reapTicket(ticketId: string, reason: string): Promise<void> {
    const handle = this.workers.get(ticketId);
    this.branchForTicket.delete(ticketId);
    if (!handle) return;
    this.workers.delete(ticketId);
    this.logger.info("reaping worker", { ticketId, workerId: handle.id, reason });
    await handle.abort(reason);
    await handle.reap();
    this.pump();
  }

  /** Post a dispatcher comment, tagged with the bot marker so it is never read back as steering. */
  private async postComment(ticketId: string, body: string): Promise<void> {
    try {
      await this.client.addComment(ticketId, `${BECKETT_COMMENT_MARKER}\n${body}`);
    } catch (err) {
      this.logger.warn("addComment failed", { ticketId, error: (err as Error).message });
    }
  }

  /** True if a comment was authored by Beckett itself (carries the dispatcher marker). */
  private isBeckettComment(comment: PlaneComment): boolean {
    return comment.body.trimStart().startsWith("<!-- beckett");
  }
}

/** Convenience factory matching the repo's `createX` style. */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return new Dispatcher(deps);
}
