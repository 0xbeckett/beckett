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
 *   on worker finish (work is committed in the ticket's own project repo, `~/Projects/<slug>`):
 *     implement success, self + real diff    → setState(done)       (ONE pass — worker self-reviewed)
 *     implement success, fresh/no self-pass   → setState(in_review)  + summary comment
 *     implement incomplete/error             → retry or return to todo with WIP
 *     review   complete verdict              → setState(done) + verdict comment
 *     review   blocked/partial verdict       → setState(in_progress) + verdict comment (re-work)
 *     review   infra/schema failure          → retry review, then hold for a human
 *
 * Review tier (see {@link reviewTierFor}) derives from the cast `effort` (low/medium → self;
 * high/xhigh/unset → fresh) or an explicit `reviewTier` on the implement cast.
 *
 * Concurrency is bounded by `config.concurrency.max_workers` (default 2 — each ticket has its own
 * project repo, so independent tickets/DAG nodes run in parallel); over-cap spawns are queued FIFO
 * and pumped as workers free their slots.
 */

import { randomUUID } from "node:crypto";
import type { Config, Logger, WorkerEvent, DoneSignal } from "../types.ts";
import type {
  Ticket,
  TicketState,
  PlaneComment,
  PollEvent,
  HarnessSpec,
} from "../plane/types.ts";
import type { ProgressSink } from "../discord/progress.ts";
import { log } from "../log.ts";
import { commitWorktree, headSha, hasDiffSince, ensureProjectRepo } from "../worker/worktree.ts";
import { projectSlug } from "../plane/cast.ts";
import { hardCapSeconds } from "../drivers/proc.ts";
import { spawnWorker, type TicketWorkerHandle } from "./spawn.ts";
import { AdvanceOutbox, type AdvanceOperation } from "./advance-outbox.ts";

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
  /** Fetch a ticket before dispatcher-initiated state changes, so human terminal moves win. */
  getIssue?(id: string): Promise<Ticket | null>;
  /** Post a comment on a ticket; returns the created comment. */
  addComment(ticketId: string, body: string): Promise<PlaneComment>;
  /** List every ticket in the project — used to find dependents to promote when one finishes. */
  listIssues(): Promise<Ticket[]>;
}

/** Construction dependencies for the {@link Dispatcher} (docs/V3.md §5). */
export interface DispatcherDeps {
  client: PlaneClientLike;
  config: Config;
  /** Resolve the absolute path of a ticket's own project repo (`~/Projects/<slug>`). */
  resolveRepoRoot: (ticket: Ticket) => string;
  /**
   * Publish a done ticket's project repo to GitHub (`0xbeckett/<slug>`, public) and return its web
   * URL. Injected so the dispatcher stays decoupled from the GitHub client + identity loading (and
   * stays unit-testable). Omitted in tests / when no PAT is configured → publishing is skipped.
   */
  publishRepo?: (args: {
    slug: string;
    repoRoot: string;
    description: string;
    ticket?: string;
  }) => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>;
  /**
   * Optional progress feed: the dispatcher forwards each worker's granular {@link WorkerEvent}
   * stream here, keyed by ticket identifier, so it lands in the ticket's Discord thread (see
   * `src/discord/progress.ts`). Injected from the Concierge's hub in `v3-main.ts`; omitted in
   * tests / when Discord isn't wired.
   */
  progress?: ProgressSink;
  /** JSONL path for durable post-finish Plane advances. Omitted in tests unless needed. */
  advanceOutboxPath?: string;
  logger?: Logger;
}

/**
 * Marker prepended to every dispatcher-authored Plane comment so STEERING never treats one of
 * its own summaries as a human nudge (avoids a self-nudge loop, docs/V3.md §5). Rendered as an
 * invisible HTML comment in Plane's markdown.
 */
export const BECKETT_COMMENT_MARKER = "<!-- beckett:dispatcher -->";

/** Max implement↔review round-trips before the dispatcher stops auto-reworking and waits for a human. */
const MAX_REWORK_CYCLES = 3;

/**
 * Max times an implement worker that ended WITHOUT a clean finish (hit the backstop wall-clock cap,
 * crashed, or errored) is auto-respawned to continue from its committed WIP before the dispatcher
 * stops retrying and returns the ticket to a ready state (OPS-50).
 */
const MAX_IMPLEMENT_RETRIES = 3;

/** Max review infra/schema retries before the dispatcher stops and waits for a human verdict. */
const MAX_REVIEW_INFRA_RETRIES = 1;

/** A spawn deferred because the concurrency cap was reached. */
interface PendingSpawn {
  ticket: Ticket;
  stage: string;
  repoRoot: string;
  waitingFor?: string;
}

interface RepoOwner {
  ticketId: string;
  identifier: string;
}

type DispatcherLiveEntry =
  | { state: "live"; ticketId: string; workerId: string; repoRoot: string | null }
  | {
      state: "queued";
      ticketId: string;
      workerId: null;
      stage: string;
      repoRoot: string;
      waitingFor?: string;
    };

export interface DispatcherShutdownResult {
  liveWorkers: number;
  queuedSpawns: number;
  completed: number;
  timedOut: boolean;
}

/** Outcome of {@link Dispatcher.publishProject} — gates whether a ticket may be marked done. */
type PublishOutcome =
  | { status: "skipped" } // no publisher wired (tests / no PAT) — nothing to gate on
  | { status: "published"; url: string; kind: "pushed" | "pr"; prUrl?: string }
  | { status: "failed"; error: string };

function parseDoneSignal(structured: unknown): DoneSignal | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const o = structured as Record<string, unknown>;
  const allowed = new Set(["status", "summary", "filesChanged", "checksRun", "blockedReason"]);
  if (Object.keys(o).some((key) => !allowed.has(key))) return null;
  const status = o.status;
  if (status !== "complete" && status !== "blocked" && status !== "partial") return null;
  if (typeof o.summary !== "string") return null;
  if (!Array.isArray(o.filesChanged) || !o.filesChanged.every((f) => typeof f === "string")) return null;
  if (
    o.checksRun !== null &&
    (!Array.isArray(o.checksRun) || !o.checksRun.every((c) => typeof c === "string"))
  ) {
    return null;
  }
  if (o.blockedReason !== null && typeof o.blockedReason !== "string") return null;

  return {
    status,
    summary: o.summary,
    filesChanged: o.filesChanged,
    ...(Array.isArray(o.checksRun) ? { checksRun: o.checksRun } : {}),
    ...(typeof o.blockedReason === "string" ? { blockedReason: o.blockedReason } : {}),
  };
}

function doneSignalSummary(signal: DoneSignal, fallback: string): string {
  const blockedReason = signal.blockedReason ? `\n\nBlocked reason:\n${signal.blockedReason}` : "";
  const summary = signal.summary || fallback;
  return `${summary}${blockedReason}`;
}

// =======================================================================================
// Dispatcher
// =======================================================================================

export class Dispatcher {
  private readonly client: PlaneClientLike;
  private readonly config: Config;
  private readonly resolveRepoRoot: (ticket: Ticket) => string;
  private readonly publishRepo?: (args: {
    slug: string;
    repoRoot: string;
    description: string;
    ticket?: string;
  }) => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>;
  private readonly progress?: ProgressSink;
  private readonly logger: Logger;
  private readonly advanceOutbox?: AdvanceOutbox;

  /** At most one live worker per ticket (implement OR review). */
  private readonly workers = new Map<string, TicketWorkerHandle>();
  /** Full ticket metadata for live workers, needed for shutdown WIP commits. */
  private readonly liveTickets = new Map<string, Ticket>();
  /**
   * Repo HEAD sha captured when a ticket FIRST entered `implement` — the REVIEW/rework diff base.
   * v3.1 runs every stage of a ticket in the one project checkout (no per-stage branch), so the
   * reviewer diffs `<baseSha>..HEAD` to see the ticket's whole contribution. Persists across
   * rework cycles (so re-review still diffs from the original base); cleared on done/cancel.
   */
  private readonly baseShaForTicket = new Map<string, string>();
  /** FIFO queue of spawns waiting for a free concurrency slot. */
  private readonly pending: PendingSpawn[] = [];
  /**
   * Ticket ids with a spawn ADMITTED but whose handle has not yet landed in {@link workers}
   * (the async `spawnWorker` gap — worktree alloc + harness launch). This is the airtight
   * per-ticket dedup reservation: it is added SYNCHRONOUSLY the instant a spawn is admitted,
   * before any `await`, so a second event for the same ticket arriving during the gap is
   * rejected instead of launching a duplicate worker. Without it, duplicate spawns landed on
   * the same ticket id, the second `workers.set` overwrote (orphaning the first process), and
   * `atCap()` undercounted → the concurrency cap was silently bypassed (runaway fan-out).
   */
  private readonly staffing = new Set<string>();
  /** Project repos currently reserved by a live, spawning, or finishing ticket. */
  private readonly repoOwners = new Map<string, RepoOwner>();
  /** Reverse lookup so release paths can free the project repo for this ticket. */
  private readonly repoByTicket = new Map<string, string>();
  /** Ids of comments the dispatcher itself posted — never read back as steering (Fix: self-nudge). */
  private readonly ownCommentIds = new Set<string>();
  /** Per-ticket implement↔review round-trips, to bound auto-rework. */
  private readonly reworkCount = new Map<string, number>();
  /** Per-ticket count of implement workers that ended without a clean finish, to bound auto-retry. */
  private readonly implementRetries = new Map<string, number>();
  /** Per-ticket count of review crashes or malformed verdicts; separate from real rework cycles. */
  private readonly reviewInfraRetries = new Map<string, number>();

  constructor(deps: DispatcherDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.resolveRepoRoot = deps.resolveRepoRoot;
    this.publishRepo = deps.publishRepo;
    this.progress = deps.progress;
    this.logger = deps.logger ?? log.child("dispatch.dispatcher");
    this.advanceOutbox = deps.advanceOutboxPath
      ? new AdvanceOutbox(deps.advanceOutboxPath, this.logger.child("advance-outbox"))
      : undefined;
  }

  // ── public surface ─────────────────────────────────────────────────────────────────────

  /**
   * Route one or a batch of poll events through the state machine. Accepts a single
   * {@link PollEvent} (docs/V3.md §5) or an array (task spec); events are handled in order.
   */
  async handle(event: PollEvent | PollEvent[]): Promise<void> {
    await this.replayAdvances();
    if (Array.isArray(event)) {
      for (const e of event) await this.handleOne(e);
    } else {
      await this.handleOne(event);
    }
  }

  /** Replay durable Plane advances left by previous write failures. Safe to call on every tick. */
  async replayAdvances(): Promise<void> {
    if (!this.advanceOutbox) return;
    const applied = await this.advanceOutbox.drain((op) => this.applyAdvance(op));
    if (applied > 0) this.logger.info("replayed queued Plane advances", { count: applied });
  }

  /** Current active and queued dispatcher work, including repo queue context for status surfaces. */
  live(): DispatcherLiveEntry[] {
    const live = [...this.workers.entries()].map(([ticketId, h]) => ({
      state: "live" as const,
      ticketId,
      workerId: h.id,
      repoRoot: this.repoByTicket.get(ticketId) ?? null,
    }));
    const queued = this.pending.map((p) => ({
      state: "queued" as const,
      ticketId: p.ticket.id,
      workerId: null,
      stage: p.stage,
      repoRoot: p.repoRoot,
      waitingFor: p.waitingFor,
    }));
    return [...live, ...queued];
  }

  /**
   * Stop live workers during daemon shutdown, preserving any dirty checkout as a WIP commit before
   * process exit. Bounded so SIGTERM handling cannot hang indefinitely under systemd.
   */
  async drainForShutdown(
    reason = "daemon shutdown",
    timeoutMs = 20_000,
  ): Promise<DispatcherShutdownResult> {
    const live = [...this.workers.entries()];
    const queuedSpawns = this.pending.length;
    this.pending.splice(0);
    if (live.length === 0) {
      this.logger.info("dispatcher shutdown drain: no live workers", { queuedSpawns });
      return { liveWorkers: 0, queuedSpawns, completed: 0, timedOut: false };
    }

    this.logger.warn("dispatcher shutdown drain: stopping live workers", {
      liveWorkers: live.length,
      queuedSpawns,
      timeoutMs,
      reason,
    });

    let completed = 0;
    const drain = Promise.allSettled(
      live.map(async ([ticketId, handle]) => {
        const ticket = this.liveTickets.get(ticketId);
        this.workers.delete(ticketId);
        this.liveTickets.delete(ticketId);
        this.staffing.delete(ticketId);
        try {
          await handle.abort(reason);
        } catch (err) {
          this.logger.warn("shutdown worker abort failed", {
            ticketId,
            workerId: handle.id,
            error: (err as Error).message,
          });
        }
        const sha = ticket ? await this.commitWip(ticket, handle) : null;
        try {
          await handle.reap();
        } catch (err) {
          this.logger.warn("shutdown worker reap failed", {
            ticketId,
            workerId: handle.id,
            error: (err as Error).message,
          });
        } finally {
          this.releaseRepo(ticketId);
        }
        completed++;
        this.logger.info("shutdown drained worker", {
          ticket: ticket?.identifier ?? ticketId,
          workerId: handle.id,
          wipSha: sha,
        });
      }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);
    const timedOut = result === "timeout";
    if (timedOut) {
      this.logger.warn("dispatcher shutdown drain timed out", {
        liveWorkers: live.length,
        completed,
        timeoutMs,
      });
    }
    return { liveWorkers: live.length, queuedSpawns, completed, timedOut };
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
        await this.promoteDependents(ticket);
        return;
      case "cancelled":
        await this.onCancelled(ticket);
        return;
      case "todo":
      case "backlog":
        await this.onParked(ticket, to);
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
    this.baseShaForTicket.delete(ticket.id);
    this.implementRetries.delete(ticket.id);
    this.reviewInfraRetries.delete(ticket.id);
    this.staffing.delete(ticket.id); // drop any mid-spawn reservation so doSpawn discards it
    this.liveTickets.delete(ticket.id);
    this.dropPending(ticket.id);
    this.releaseRepo(ticket.id);
    if (!handle) {
      this.logger.info("ticket cancelled (no live worker)", { ticket: ticket.identifier });
      this.pump();
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

  private async onParked(ticket: Ticket, state: "todo" | "backlog"): Promise<void> {
    const handle = this.workers.get(ticket.id);
    this.baseShaForTicket.delete(ticket.id);
    this.implementRetries.delete(ticket.id);
    this.reviewInfraRetries.delete(ticket.id);
    this.staffing.delete(ticket.id);
    this.liveTickets.delete(ticket.id);
    this.dropPending(ticket.id);
    this.releaseRepo(ticket.id);
    if (!handle) {
      this.logger.info("ticket parked (no live worker)", { ticket: ticket.identifier, state });
      this.pump();
      return;
    }

    this.logger.warn("ticket parked — stopping live worker", {
      ticket: ticket.identifier,
      workerId: handle.id,
      state,
    });
    this.workers.delete(ticket.id);
    await handle.abort(`ticket moved to ${state}`);
    await handle.reap();
    const sha = await this.commitWip(ticket, handle);
    const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";
    await this.postComment(
      ticket.id,
      `Ticket moved to **${state}** while a worker was running, so I stopped the worker and ` +
        `committed any WIP${at}. Move it back to **in_progress** when you're ready to resume.`,
    );
    this.pump();
  }

  // ── spawning + concurrency ─────────────────────────────────────────────────────────────

  /** True if a worker is live, OR a spawn is mid-flight, for this ticket (airtight dedup). */
  private isStaffed(ticketId: string): boolean {
    return this.workers.has(ticketId) || this.staffing.has(ticketId);
  }

  /** True when live workers + admitted-but-not-yet-live spawns already fill the concurrency cap. */
  private atCap(): boolean {
    return this.workers.size + this.staffing.size >= this.config.concurrency.max_workers;
  }

  /** Spawn immediately if a slot is free, else enqueue for {@link pump}. */
  private spawnGuarded(ticket: Ticket, stage: string): void {
    if (this.isStaffed(ticket.id)) return; // already staffed (live or mid-spawn)
    const repoRoot = this.resolveRepoRoot(ticket);
    if (this.atCap()) {
      this.pending.push({ ticket, stage, repoRoot });
      this.logger.info("spawn queued (concurrency cap reached)", {
        ticket: ticket.identifier,
        stage,
        repoRoot,
        inUse: this.workers.size + this.staffing.size,
        cap: this.config.concurrency.max_workers,
        queueDepth: this.pending.length,
      });
      return;
    }
    const owner = this.repoOwners.get(repoRoot);
    if (owner) {
      this.pending.push({ ticket, stage, repoRoot, waitingFor: owner.identifier });
      this.logger.info("spawn queued (project repo busy)", {
        ticket: ticket.identifier,
        stage,
        repoRoot,
        waitingFor: owner.identifier,
        queueDepth: this.pending.length,
      });
      if (owner.ticketId !== ticket.id) {
        void this.postComment(
          ticket.id,
          `Waiting for ${owner.identifier} to free \`${repoRoot}\` before starting this ${stage} worker.`,
        );
      }
      return;
    }
    this.launchSpawn(ticket, stage, repoRoot);
  }

  /**
   * Reserve the ticket's slot SYNCHRONOUSLY ({@link staffing}.add) BEFORE the async spawn, so two
   * spawns racing through {@link spawnGuarded} can't both pass the dedup/cap checks. The
   * reservation is released — into {@link workers} on success, or dropped on failure — by
   * {@link doSpawn}; the queue is pumped once the spawn settles.
   */
  private launchSpawn(ticket: Ticket, stage: string, repoRoot: string): void {
    this.staffing.add(ticket.id);
    this.repoOwners.set(repoRoot, { ticketId: ticket.id, identifier: ticket.identifier });
    this.repoByTicket.set(ticket.id, repoRoot);
    this.refreshRepoWaiters(repoRoot, ticket.identifier);
    void this.doSpawn(ticket, stage, repoRoot)
      .catch(() => {
        /* doSpawn handles its own errors + ticket comment */
      })
      .finally(() => {
        this.staffing.delete(ticket.id); // no-op if doSpawn already moved it into `workers`
        if (!this.workers.has(ticket.id)) this.releaseRepo(ticket.id);
        this.pump();
      });
  }

  /** Admit queued spawns while slots are free. */
  private pump(): void {
    while (this.pending.length > 0 && !this.atCap()) {
      let launchAt = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const candidate = this.pending[i]!;
        if (this.isStaffed(candidate.ticket.id)) {
          this.pending.splice(i, 1);
          i--;
          continue;
        }
        const owner = this.repoOwners.get(candidate.repoRoot);
        if (owner) {
          candidate.waitingFor = owner.identifier;
          continue;
        }
        launchAt = i;
        break;
      }
      if (launchAt === -1) return;
      const next = this.pending.splice(launchAt, 1)[0]!;
      this.launchSpawn(next.ticket, next.stage, next.repoRoot);
    }
  }

  /** The real spawn path (cap already checked). Registers the finish handler. */
  private async doSpawn(ticket: Ticket, stage: string, repoRoot: string): Promise<void> {
    const spec = this.castFor(ticket, stage);

    // v3.1: ensure the ticket's OWN project repo exists before any stage runs — clone
    // `0xbeckett/<slug>` if it's already on GitHub (a continuing project, or Beckett's source for a
    // self-improvement ticket), else `git init` a fresh one. A worker never touches Beckett's live
    // source. A provisioning failure leaves the ticket for a human rather than spawning blind.
    try {
      await ensureProjectRepo(repoRoot, projectSlug(ticket.project || ticket.identifier));
    } catch (err) {
      this.logger.error("project repo provisioning failed", {
        ticket: ticket.identifier,
        repoRoot,
        error: (err as Error).message,
      });
      await this.postComment(
        ticket.id,
        `Could not provision the project repo at \`${repoRoot}\`: ${(err as Error).message}. Leaving for a human.`,
      );
      return; // launchSpawn's finally releases the reservation + pumps
    }

    // Capture the diff base the first time a ticket implements: every stage shares the one
    // checkout, so this sha is how a later REVIEW sees the ticket's whole contribution. A git
    // hiccup here must never block the spawn — the reviewer just falls back to diffing HEAD.
    if (stage === "implement" && !this.baseShaForTicket.has(ticket.id)) {
      try {
        const sha = await headSha(repoRoot);
        if (sha) this.baseShaForTicket.set(ticket.id, sha);
      } catch (err) {
        this.logger.warn("base-sha capture failed; review will diff HEAD", {
          ticket: ticket.identifier,
          error: (err as Error).message,
        });
      }
    }
    const baseRef = this.baseShaForTicket.get(ticket.id) ?? "HEAD";

    let handle: TicketWorkerHandle;
    try {
      handle = await spawnWorker({
        ticket,
        stage,
        harness: spec,
        config: this.config,
        repoRoot,
        baseRef,
        // Mirror this worker's granular event stream into the ticket's Discord thread, keyed by the
        // stable ticket identifier so implement/review/rework workers all post to the one thread.
        onProgress: this.progress
          ? (ev: WorkerEvent, ctx) => this.progress!.event(ticket.identifier, ev, ctx)
          : undefined,
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
      return; // launchSpawn's finally releases the reservation + pumps
    }

    // If the ticket was cancelled/reaped DURING the spawn gap, its reservation was dropped from
    // {@link staffing}; discard the freshly-spawned worker rather than register an orphan.
    if (!this.staffing.has(ticket.id)) {
      this.logger.info("ticket no longer staffed mid-spawn — discarding worker", {
        ticket: ticket.identifier,
        stage,
        workerId: handle.id,
      });
      await handle.abort("ticket no longer active");
      await handle.reap();
      return;
    }

    this.workers.set(ticket.id, handle);
    this.liveTickets.set(ticket.id, ticket);
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
    this.liveTickets.delete(ticket.id);

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
      this.releaseRepo(ticket.id);
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
      await this.onImplementIncomplete(ticket, handle, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (signal && (signal.status === "blocked" || signal.status === "partial")) {
      await this.onImplementReportedIncomplete(ticket, handle, signal, summary);
      return;
    }

    // Capture any uncommitted work the worker left in the checkout so review/rework (and the
    // human) can see it. The worker may have committed already; this is the safety net.
    let committedContribution = false;
    try {
      const commit = await commitWorktree(
        handle.workspace,
        `beckett: ${ticket.identifier} implement (${handle.workerId})`,
      );
      if (commit.committed) {
        committedContribution = true;
        this.logger.info("committed implementation", { ticket: ticket.identifier, sha: commit.sha });
      }
    } catch (err) {
      this.logger.warn("commit of implementation failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
    }

    // v3.1 effort-scaled review. `self` (low/medium-risk work) → the worker self-verified inline,
    // so go straight to done in ONE pass — no separate cold reviewer, no relay. `fresh` →
    // a separate adversarial reviewer (the in_review stage), as before. Done tickets promote DAG
    // dependents immediately here; the later poller state_changed(done) is only a restart backstop.
    if (this.reviewTierFor(ticket) === "self") {
      if (!(await this.hasTicketContribution(ticket, handle, committedContribution))) {
        await this.advanceTicket(
          ticket,
          "in_review",
          `Self-review withheld → **in_review** because the implement worker finished with no diff against the ticket base.\n\n${summary}`,
        );
        this.logger.warn("self-review withheld: zero-diff implementation", {
          ticket: ticket.identifier,
        });
        return;
      }
      const done = await this.finishTicketAsDone(ticket, "Self-reviewed → **done** (one pass).", summary);
      if (done) this.logger.info("ticket self-reviewed → done", { ticket: ticket.identifier });
      return;
    }

    await this.advanceTicket(ticket, "in_review", `Implementation complete → **in_review**.\n\n${summary}`);
    this.logger.info("ticket advanced to in_review", { ticket: ticket.identifier });
  }

  private async onImplementReportedIncomplete(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    signal: DoneSignal,
    summary: string,
  ): Promise<void> {
    const reason = doneSignalSummary(signal, summary);
    if (this.reviewTierFor(ticket) === "self") {
      const sha = await this.commitWip(ticket, handle);
      const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";
      await this.advanceTicket(
        ticket,
        "in_review",
        `The implement worker reported **${signal.status}**, so self-review is disabled and this ` +
          `is going to a fresh review instead of being marked done. I committed any WIP${at}.\n\n${reason}`,
      );
      this.logger.warn("self-tier implement reported incomplete — sent to review", {
        ticket: ticket.identifier,
        status: signal.status,
      });
      return;
    }

    await this.onImplementIncomplete(ticket, handle, reason);
  }

  private async hasTicketContribution(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    committedContribution: boolean,
  ): Promise<boolean> {
    if (committedContribution) return true;
    try {
      return await hasDiffSince(handle.workspace, this.baseShaForTicket.get(ticket.id) ?? null);
    } catch (err) {
      this.logger.warn("could not verify implementation diff; withholding self-review", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * An implement worker ended WITHOUT a clean finish — it tripped the generous backstop wall-clock
   * cap, crashed, or the harness errored. The fix for the OPS-50 "silent wedge": never leave the
   * ticket sitting in in_progress with nothing running. We (1) commit whatever WIP is in the
   * checkout so it's never lost, then (2) either retry — re-spawn an implement worker that continues
   * from that committed WIP (bounded by {@link MAX_IMPLEMENT_RETRIES}) — or, once retries are spent,
   * push the WIP to GitHub if we can and return the ticket to a ready state (`todo`) with a loud
   * comment so a human can pick it up. Both paths post a status comment saying what happened and
   * where the worker stopped.
   */
  private async onImplementIncomplete(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    summary: string,
  ): Promise<void> {
    const timedOut = handle.result?.timedOut === true;
    const reason = timedOut
      ? `hit the ${Math.round(hardCapSeconds(this.config) / 60)}-minute safety cap`
      : `stopped without finishing (crash or harness error)`;

    // 1. Safety-net commit so the WIP survives for the retry AND the human (the worker may have
    //    already committed; this captures anything still in the working tree).
    const sha = await this.commitWip(ticket, handle);
    const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";

    // 2. Bound the auto-retry so a persistently-failing ticket can't churn forever.
    const attempts = (this.implementRetries.get(ticket.id) ?? 0) + 1;
    this.implementRetries.set(ticket.id, attempts);

    if (attempts <= MAX_IMPLEMENT_RETRIES) {
      await this.postComment(
        ticket.id,
        `The worker ${reason} before finishing. I committed its work-in-progress${at} and am ` +
          `retrying (attempt ${attempts}/${MAX_IMPLEMENT_RETRIES}), continuing from the committed ` +
          `work.\n\nWhere it stopped:\n${summary}`,
      );
      this.logger.warn("implement incomplete — retrying", {
        ticket: ticket.identifier,
        attempts,
        timedOut,
      });
      // The old worker's whole process tree is already dead (the driver group-killed it before
      // signalling done), so a fresh worker can safely edit the same checkout. The ticket stays in
      // in_progress but is once again ACTIVELY staffed — not silently wedged.
      this.spawnGuarded(ticket, "implement");
      return;
    }

    // 3. Retries exhausted. Never leave it stuck in in_progress: push the WIP so a human has it, then
    //    return the ticket to a ready state (`todo`) with a loud comment.
    this.implementRetries.delete(ticket.id);
    const pub = await this.publishProject(ticket);
    const link =
      pub.status === "published"
        ? pub.kind === "pr"
          ? `\n\nWIP pushed as a PR: ${pub.prUrl ?? pub.url}`
          : `\n\nWIP pushed: ${pub.url}`
        : "";
    try {
      await this.advanceTicket(
        ticket,
        "todo",
        `The worker ${reason} again — that's ${MAX_IMPLEMENT_RETRIES} retries with no clean finish, ` +
          `so I'm stopping automatic retries and moving this back to **todo** so it isn't stuck in ` +
          `progress. Its WIP is committed${at}.${link}\n\nWhere it stopped:\n${summary}`,
      );
      this.logger.warn("implement retries exhausted — returned ticket to todo", {
        ticket: ticket.identifier,
      });
    } catch (err) {
      this.logger.warn("could not return ticket to todo after exhausted retries", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Commit whatever is in a ticket's checkout as a WIP snapshot, best-effort. Returns the new commit
   * sha, or null when there was nothing to commit (or the commit failed) — never throws.
   */
  private async commitWip(ticket: Ticket, handle: TicketWorkerHandle): Promise<string | null> {
    try {
      const commit = await commitWorktree(
        handle.workspace,
        `beckett: ${ticket.identifier} WIP (${handle.workerId})`,
      );
      if (commit.committed) {
        this.logger.info("committed WIP", { ticket: ticket.identifier, sha: commit.sha });
        return commit.sha ?? null;
      }
      return null;
    } catch (err) {
      this.logger.warn("WIP commit failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * The review gate for a ticket (v3.1). An explicit `reviewTier` on the implement cast wins;
   * otherwise it derives from the CAST effort: low/medium → `self` (one-pass, the worker
   * self-verifies inline), everything else (high/xhigh, or no cast) → `fresh` (separate
   * adversarial reviewer). Note this reads the *cast* effort, not the resolved worker effort —
   * an un-cast ticket defaults to a full fresh review (the safe, pre-v3.1 behavior).
   */
  private reviewTierFor(ticket: Ticket): "self" | "fresh" {
    const impl = this.castFor(ticket, "implement");
    if (impl.reviewTier) return impl.reviewTier;
    return impl.effort === "low" || impl.effort === "medium" ? "self" : "fresh";
  }

  /**
   * Publish a done ticket's checkout to GitHub and report the outcome. `skipped` when no `publishRepo`
   * was injected (tests / no PAT) — there's nothing to gate on, so the caller still marks it done.
   * `published` carries HOW it shipped (a repo push vs. a PR needing a human merge) so `done` wording
   * stays honest. `failed` is the load-bearing case: the caller must NOT mark the ticket done (a
   * done ticket whose work never left the box is the false-done this fixes — see OPS-30).
   */
  private async publishProject(ticket: Ticket): Promise<PublishOutcome> {
    if (!this.publishRepo) return { status: "skipped" };
    const slug = projectSlug(ticket.project || ticket.identifier);
    const repoRoot = this.resolveRepoRoot(ticket);
    try {
      const r = await this.publishRepo({ slug, repoRoot, description: ticket.title, ticket: ticket.identifier });
      this.logger.info("project published to github", { ticket: ticket.identifier, url: r.url, kind: r.kind });
      return { status: "published", url: r.url, kind: r.kind, prUrl: r.prUrl };
    } catch (err) {
      this.logger.warn("github publish failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return { status: "failed", error: (err as Error).message };
    }
  }

  private async onReviewDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    if (status !== "success") {
      await this.onReviewInfraFailure(ticket, `Reviewer exited with ${status}.`, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (!signal) {
      await this.onReviewInfraFailure(
        ticket,
        "Reviewer finished without a schema-valid structured verdict.",
        summary,
      );
      return;
    }

    this.reviewInfraRetries.delete(ticket.id);
    if (signal.status === "complete") {
      const done = await this.finishTicketAsDone(ticket, "Review passed → **done**.", summary);
      if (done) this.logger.info("ticket advanced to done", { ticket: ticket.identifier });
      return;
    }

    // Review failed — bound the implement↔review loop so it can't churn forever.
    const cycles = (this.reworkCount.get(ticket.id) ?? 0) + 1;
    this.reworkCount.set(ticket.id, cycles);
    if (cycles >= MAX_REWORK_CYCLES) {
      await this.postComment(
        ticket.id,
        `Review found issues, and this is rework cycle ${cycles}/${MAX_REWORK_CYCLES} — stopping ` +
          `automatic rework and leaving this in **in_review** for a human to take over.\n\n${summary}`,
      );
      this.reworkCount.delete(ticket.id);
      this.logger.warn("rework cap reached — leaving for human", {
        ticket: ticket.identifier,
        cycles,
      });
      return; // no setState → no new event → loop stops, ticket awaits a human
    }

    await this.advanceTicket(
      ticket,
      "in_progress",
      `Review found issues → back to **in_progress** for re-work (cycle ${cycles}/${MAX_REWORK_CYCLES}).\n\n${summary}`,
    );
    this.logger.info("ticket sent back to in_progress (review fail)", {
      ticket: ticket.identifier,
      cycle: cycles,
    });
  }

  private async onReviewInfraFailure(ticket: Ticket, reason: string, summary: string): Promise<void> {
    const attempts = (this.reviewInfraRetries.get(ticket.id) ?? 0) + 1;
    this.reviewInfraRetries.set(ticket.id, attempts);

    if (attempts <= MAX_REVIEW_INFRA_RETRIES) {
      await this.postComment(
        ticket.id,
        `${reason} Retrying the review gate (attempt ${attempts}/${MAX_REVIEW_INFRA_RETRIES}); ` +
          `this does not count as a rework cycle.\n\n${summary}`,
      );
      this.logger.warn("review infra/schema failure — retrying review", {
        ticket: ticket.identifier,
        attempts,
        reason,
      });
      this.spawnGuarded(ticket, "review");
      return;
    }

    this.reviewInfraRetries.delete(ticket.id);
    await this.postComment(
      ticket.id,
      `${reason} Review still did not produce a reliable verdict after ${MAX_REVIEW_INFRA_RETRIES} ` +
        `retry, so I'm leaving this in **in_review** for a human instead of marking it done or ` +
        `sending it back as failed work.\n\n${summary}`,
    );
    this.logger.warn("review infra/schema retries exhausted — leaving for human", {
      ticket: ticket.identifier,
      reason,
    });
  }

  /**
   * Publish FIRST, then mark done — publish success now gates the done transition (and DAG promotion).
   * This reverses the old "done before best-effort publish" ordering: that let a publish failure slip
   * through as a green "done" while nothing shipped (the false-done, OPS-30). On failure the ticket is
   * Parked in `todo` with a loud "needs a courier" comment and dependents are NOT promoted. That
   * keeps the ticket from being re-staffed on restart while still refusing to report `done` for work
   * that did not leave the box. DAG dependents build from the local `~/Projects/<slug>` checkout, so
   * a PR-up-but-unmerged ticket doesn't starve them.
   */
  private async finishTicketAsDone(
    ticket: Ticket,
    messagePrefix: string,
    summary: string,
  ): Promise<boolean> {
    const pub = await this.publishProject(ticket);
    if (pub.status === "failed") {
      await this.advanceTicket(
        ticket,
        "todo",
        `The work is complete, but I couldn't publish it to GitHub (${pub.error}). It's committed ` +
          `locally in \`${this.resolveRepoRoot(ticket)}\` — moving this ticket to **todo** for a ` +
          `human/courier to push or PR. I'm NOT marking it done, so it isn't lost, and I'm parking ` +
          `it so no worker keeps burning tokens.\n\n${summary}`,
      );
      this.logger.warn("publish failed — parked ticket for courier", { ticket: ticket.identifier });
      return false; // no setState(done), no promote — the work isn't shipped
    }

    // Honest wording: a PR still needs the human's merge; a direct push is actually shipped.
    const link =
      pub.status === "published"
        ? pub.kind === "pr"
          ? `\n\nPR opened (needs your merge): ${pub.prUrl ?? pub.url}`
          : `\n\nShipped: ${pub.url}`
        : "";
    const advanced = await this.advanceTicket(ticket, "done", `${messagePrefix}${link}\n\n${summary}`, {
      promoteDependents: true,
    });
    return advanced;
  }

  // ── dependency promotion (the `beckett plan` DAG) ────────────────────────────────────────

  /**
   * When a ticket reaches `done`, promote any dependent whose blockers are ALL now `done` from its
   * held `backlog`/`todo` slot to `in_progress` (which staffs it). The DAG lives entirely in Plane
   * (each ticket's ```beckett-deps``` block), so this is stateless and restart-proof: we re-read
   * the board and recompute readiness rather than track edges in memory. A dependent with a still
   * unresolved blocker (or a cancelled one) is left held and logged — never force-started.
   */
  private async promoteDependents(doneTicket: Ticket): Promise<void> {
    let all: Ticket[];
    try {
      all = await this.client.listIssues();
    } catch (err) {
      this.logger.warn("promote: listIssues failed — dependents not advanced", {
        ticket: doneTicket.identifier,
        error: (err as Error).message,
      });
      return;
    }
    const stateByIdent = new Map(all.map((t) => [t.identifier, t.state]));

    for (const t of all) {
      if (!t.blockedBy.includes(doneTicket.identifier)) continue; // not waiting on this ticket
      if (t.state !== "backlog" && t.state !== "todo") continue; // already running/terminal — leave it
      const unresolved = t.blockedBy.filter((id) => stateByIdent.get(id) !== "done");
      if (unresolved.length > 0) {
        this.logger.info("dependent still blocked — leaving held", {
          ticket: t.identifier,
          waitingOn: unresolved,
        });
        continue;
      }
      this.logger.info("promoting unblocked dependent → in_progress", {
        ticket: t.identifier,
        after: doneTicket.identifier,
      });
      try {
        await this.client.setState(t.id, "in_progress");
        await this.postComment(
          t.id,
          `All blockers done (${t.blockedBy.join(", ")}) → starting now.`,
        );
      } catch (err) {
        this.logger.warn("promote: setState failed", {
          ticket: t.identifier,
          error: (err as Error).message,
        });
      }
    }
  }

  private async advanceTicket(
    ticket: Ticket,
    state: TicketState,
    comment: string,
    opts: { promoteDependents?: boolean } = {},
  ): Promise<boolean> {
    const op: AdvanceOperation = {
      id: randomUUID(),
      ticketId: ticket.id,
      state,
      comment,
      ...(opts.promoteDependents ? { promoteDependents: true } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.applyAdvance(op);
      return true;
    } catch (err) {
      if (this.advanceOutbox) {
        this.advanceOutbox.append(op);
        return false;
      }
      throw err;
    }
  }

  private async applyAdvance(op: AdvanceOperation): Promise<void> {
    const state = op.state as TicketState;
    const current = await this.client.getIssue?.(op.ticketId);
    if (current && this.humanTerminalMoveWins(current, state)) {
      this.logger.warn("skipping queued Plane advance because ticket is terminal", {
        ticket: current.identifier,
        current: current.state,
        requested: state,
      });
      return;
    }
    await this.client.setState(op.ticketId, state);
    await this.addMarkedComment(op.ticketId, op.comment);
    if (op.promoteDependents) {
      let doneTicket = (await this.client.getIssue?.(op.ticketId)) ?? current;
      if (!doneTicket) {
        const all = await this.client.listIssues();
        doneTicket = all.find((t) => t.id === op.ticketId);
      }
      if (doneTicket) await this.promoteDependents(doneTicket);
    }
    if (state === "done") this.clearTicketMemory(op.ticketId);
  }

  private humanTerminalMoveWins(current: Ticket, requested: TicketState): boolean {
    if (current.state === requested) return false;
    return current.state === "cancelled" || current.state === "done";
  }

  private clearTicketMemory(ticketId: string): void {
    this.baseShaForTicket.delete(ticketId);
    this.reworkCount.delete(ticketId);
    this.implementRetries.delete(ticketId);
    this.reviewInfraRetries.delete(ticketId);
    this.liveTickets.delete(ticketId);
  }

  // ── reaping + comments ───────────────────────────────────────────────────────────────

  /** Reap any live worker for a ticket (terminal-state cleanup). */
  private async reapTicket(ticketId: string, reason: string): Promise<void> {
    const handle = this.workers.get(ticketId);
    this.baseShaForTicket.delete(ticketId);
    this.implementRetries.delete(ticketId);
    this.reviewInfraRetries.delete(ticketId);
    this.staffing.delete(ticketId); // drop any mid-spawn reservation so doSpawn discards it
    this.liveTickets.delete(ticketId);
    this.dropPending(ticketId);
    this.releaseRepo(ticketId);
    if (!handle) return;
    this.workers.delete(ticketId);
    this.logger.info("reaping worker", { ticketId, workerId: handle.id, reason });
    await handle.abort(reason);
    await handle.reap();
    this.pump();
  }

  private dropPending(ticketId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.ticket.id === ticketId) this.pending.splice(i, 1);
    }
  }

  private releaseRepo(ticketId: string): void {
    const repoRoot = this.repoByTicket.get(ticketId);
    if (!repoRoot) return;
    const owner = this.repoOwners.get(repoRoot);
    if (owner?.ticketId === ticketId) this.repoOwners.delete(repoRoot);
    this.repoByTicket.delete(ticketId);
  }

  private refreshRepoWaiters(repoRoot: string, waitingFor: string): void {
    for (const pending of this.pending) {
      if (pending.repoRoot === repoRoot) pending.waitingFor = waitingFor;
    }
  }

  /** Post a dispatcher comment, tagged with the bot marker so it is never read back as steering. */
  private async postComment(ticketId: string, body: string): Promise<void> {
    try {
      await this.addMarkedComment(ticketId, body);
    } catch (err) {
      this.logger.warn("addComment failed", { ticketId, error: (err as Error).message });
    }
  }

  private async addMarkedComment(ticketId: string, body: string): Promise<void> {
    const posted = await this.client.addComment(ticketId, `${BECKETT_COMMENT_MARKER}\n${body}`);
    // Record the id so we recognise our own comment even if Plane mangles the HTML marker.
    if (posted?.id) this.ownCommentIds.add(posted.id);
  }

  /**
   * True if a comment was authored by Beckett itself. Primary signal is the comment id we
   * recorded when we posted it; the HTML marker is a restart-surviving fallback (the id set is
   * in-memory). Either match means "don't treat this as a human steering nudge."
   */
  private isBeckettComment(comment: PlaneComment): boolean {
    return this.ownCommentIds.has(comment.id) || comment.body.trimStart().startsWith("<!-- beckett");
  }
}

/** Convenience factory matching the repo's `createX` style. */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return new Dispatcher(deps);
}
