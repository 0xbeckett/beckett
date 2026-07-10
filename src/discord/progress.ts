/**
 * Beckett v3 — the progress feed (`src/discord/progress.ts`)
 * =======================================================================================
 * The bridge that turns a ticket's raw {@link WorkerEvent} firehose into a readable Discord
 * THREAD hanging off the ack Beckett posted when it filed the work, plus a quiet sibling workspace
 * where humans can talk to Beckett about that ticket without an @mention. The main channel stays
 * sparse: the person gets one ack, the anchored activity thread gets the granular worker
 * play-by-play, and the standalone workspace thread gets the human conversation. Discord permits
 * only one thread per message, which is why the workspace is a sibling under the same parent.
 *
 * Why a hub and not "just post each event":
 *  - **Correlation is racy.** The thread is anchored to the ack message, which is posted at the
 *    END of the Concierge's turn, while `beckett ticket create` fires mid-turn. So events can
 *    arrive before the thread exists. The hub BUFFERS per ticket and opens/flushes when the
 *    anchor lands ({@link openThread}), retrying the open on any later event if Discord was down.
 *  - **A worker is chatty.** A scan worker emits many tool calls per second; posting each raw
 *    would flood the thread and blow Discord's per-channel rate limit. The hub COALESCES lines
 *    into one digest post every {@link FLUSH_INTERVAL_MS}, caps each post at ~2k chars, and
 *    bounds the backlog (drop-oldest with an "N elided" marker) so it never replays minutes
 *    behind real-time or grows without bound. Terminal events (`finished`/`error`) jump the
 *    queue and flush at once.
 *  - **Many workers, many tickets, one thread.** A `beckett plan` DAG files N tickets under ONE
 *    ack; each maps to the same thread and its lines are tagged by ticket identifier. A single
 *    ticket runs implement→review→rework workers over time; all post to its thread, tagged by
 *    stage.
 *
 * Both ticket → activity-thread and workspace-thread → tickets are persisted, so worker events and
 * unmentioned human workspace messages keep routing after a daemon restart. The state is
 * best-effort: if it is corrupt or missing, new ticket.filed acks still create fresh mappings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerEvent, Logger } from "../types.ts";
import { log as rootLog } from "../log.ts";

/** The slice of the Discord gateway the hub needs: open a thread, post into it. */
export interface ThreadCapableGateway {
  startThread(channelId: string, anchorMessageId: string, name: string): Promise<string>;
  startStandaloneThread(channelId: string, name: string): Promise<string>;
  post(channelId: string, content: string): Promise<string>;
}

/** Which worker produced an event — used to tag thread lines (implement / review / rework). */
export interface ProgressContext {
  stage: string;
  workerId: string;
}

/** The narrow sink the dispatcher wires a worker's event stream into. */
export interface ProgressSink {
  event(ticketIdent: string, ev: WorkerEvent, ctx: ProgressContext): void;
}

/** Request to anchor a ticket's thread to the ack message (idempotent per anchor). */
export interface OpenThreadRequest {
  channelId: string;
  anchorMessageId: string;
  ticketIdent: string;
  /** Human title for the thread name (usually the ticket title). */
  title: string;
}

/** Ticket context attached to an inbound message from a human workspace thread. */
export interface TicketWorkspaceContext {
  parentChannelId: string;
  ticketIdents: string[];
}

/** Timing knobs (defaults are production values; tests shrink them to drive the timer fast). */
export interface ProgressHubOptions {
  flushIntervalMs?: number;
  openRetryMs?: number;
  openMaxAttempts?: number;
  /** JSON file used to remember ticket → thread mappings across daemon restarts. */
  stateFile?: string;
}

/** Coalesce window: at most one digest post per thread per this interval (rate-limit safety). */
const FLUSH_INTERVAL_MS = 3_000;
/** Per-post character cap — well under Discord's 2000 so the digest never truncates mid-line. */
const MAX_POST_CHARS = 1_900;
/** Backlog ceiling per thread; beyond this we drop the OLDEST lines and count them as elided. */
const MAX_BUFFER_LINES = 200;
/** After an open fails (gateway mid-reconnect), retry on this cadence even if no new events arrive. */
const OPEN_RETRY_MS = 5_000;
/** Bounded retries before degrading to parent-channel digests. */
const OPEN_MAX_ATTEMPTS = 3;

/** One live activity/workspace pair (one per acknowledgement anchor). */
interface ThreadFeed {
  channelId: string;
  anchorMessageId: string;
  name: string;
  /** Ticket identifiers mapped to this feed (one normally, many for plan DAGs). */
  ticketIdents: Set<string>;
  /** null until the Discord thread is actually created; events buffer until then. */
  threadId: string | null;
  /** True while a {@link startThread} call is in flight (dedups concurrent opens). */
  opening: boolean;
  /** Count of failed open attempts; permanent failures degrade immediately. */
  openAttempts: number;
  /** True once thread creation is abandoned and digests post in the parent channel. */
  degradedToChannel: boolean;
  /** Set once a 2nd ticket maps here (a `plan` DAG) → lines get an `[IDENT]` prefix to disambiguate. */
  multiTicket: boolean;
  /** Formatted lines awaiting a flush. */
  buffer: string[];
  /** Count of oldest lines dropped under backpressure, surfaced once as a marker then reset. */
  elided: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** toolId → tool name, so a later `tool_result` error can name the tool that failed. */
  toolNames: Map<string, string>;
  /** Human-facing sibling thread; its inbound messages route to the Concierge. */
  workspaceName: string;
  workspaceThreadId: string | null;
  workspaceOpening: boolean;
  workspaceOpenAttempts: number;
  workspaceFailed: boolean;
  workspaceRetryTimer: ReturnType<typeof setTimeout> | null;
  workspaceIntroPosted: boolean;
}

interface StoredThread {
  channelId: string;
  activityThreadId: string;
  activityName: string;
  workspaceThreadId: string | null;
  workspaceName: string;
}

interface WorkspaceRoute {
  parentChannelId: string;
  ticketIdents: Set<string>;
}

/**
 * Owns every ticket's Discord thread pair. Constructed with the live gateway (which the Concierge
 * also owns) and injected into the dispatcher as a {@link ProgressSink}. Fire-and-forget by
 * design: a failure to open or post a thread must never disturb the work itself, so every gateway
 * call here is best-effort and logged, never thrown to the caller.
 */
export class ProgressHub implements ProgressSink {
  private readonly gateway: ThreadCapableGateway;
  private readonly log: Logger;
  private readonly flushIntervalMs: number;
  private readonly openRetryMs: number;
  private readonly openMaxAttempts: number;
  private readonly stateFile?: string;
  /** One feed per anchor message (the thread). */
  private readonly feeds = new Map<string, ThreadFeed>();
  /** ticketIdent → anchorMessageId, so {@link event} can route a ticket's events to its thread. */
  private readonly anchorByTicket = new Map<string, string>();
  /** ticketIdent → persisted thread mapping, loaded at boot and updated when threads open. */
  private readonly savedByTicket = new Map<string, StoredThread>();
  /** workspace thread id → its ticket(s), used to make unmentioned messages directed turns. */
  private readonly workspaceByThread = new Map<string, WorkspaceRoute>();
  /** Events for a ticket whose thread isn't registered yet (openThread not called), drained on open. */
  private readonly pendingByTicket = new Map<string, string[]>();

  constructor(gateway: ThreadCapableGateway, logger?: Logger, opts?: ProgressHubOptions) {
    this.gateway = gateway;
    this.log = (logger ?? rootLog).child("discord.progress");
    this.flushIntervalMs = opts?.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.openRetryMs = opts?.openRetryMs ?? OPEN_RETRY_MS;
    this.openMaxAttempts = opts?.openMaxAttempts ?? OPEN_MAX_ATTEMPTS;
    this.stateFile = opts?.stateFile;
    this.loadState();
  }

  /**
   * Anchor a ticket's progress thread to the ack message. Idempotent: called from both ack paths
   * (the Concierge's auto-posted turn text AND its `beckett discord reply`) and once per ticket in
   * a `plan` DAG, so the first call for an anchor creates the thread and the rest just map their
   * ticket onto it. A ticket only ever gets ONE pair: the first anchor wins and a later call with
   * a different anchor is ignored. Drains any events that arrived before the anchor landed.
   */
  openThread(req: OpenThreadRequest): void {
    const { channelId, anchorMessageId, ticketIdent, title } = req;
    const existing = this.anchorByTicket.get(ticketIdent);
    if (existing === anchorMessageId) return; // already mapped
    if (existing) {
      // FIRST anchor wins. The Concierge often replies more than once while a turn runs (an ack
      // up front, a wrap-up after filing), and each reply re-anchors the turn's ack message —
      // re-registering here would fork a SECOND Discord thread for the same ticket and split the
      // worker's log stream across threads (the OPS-76 triple-thread bug). Later anchors are
      // ignored; the ticket keeps streaming into the thread it already has.
      this.log.info("ticket already anchored to a progress thread — ignoring re-anchor", {
        ticket: ticketIdent,
        keptAnchor: existing,
        ignoredAnchor: anchorMessageId,
      });
      return;
    }
    this.anchorByTicket.set(ticketIdent, anchorMessageId);

    let feed = this.feeds.get(anchorMessageId);
    if (!feed) {
      feed = {
        channelId,
        anchorMessageId,
        name: `${ticketIdent} · activity`,
        ticketIdents: new Set([ticketIdent]),
        threadId: null,
        opening: false,
        openAttempts: 0,
        degradedToChannel: false,
        multiTicket: false,
        buffer: [],
        elided: 0,
        flushTimer: null,
        toolNames: new Map(),
        workspaceName: `${ticketIdent} · with Beckett`,
        workspaceThreadId: null,
        workspaceOpening: false,
        workspaceOpenAttempts: 0,
        workspaceFailed: false,
        workspaceRetryTimer: null,
        workspaceIntroPosted: false,
      };
      this.feeds.set(anchorMessageId, feed);
      this.log.info("progress thread registered", { ticket: ticketIdent, channelId, anchorMessageId });
    } else {
      // A second ticket joined this ack's thread (a plan DAG) — from now on tag lines by ticket.
      feed.ticketIdents.add(ticketIdent);
      feed.multiTicket = true;
      if (feed.threadId) this.remember(feed, feed.threadId);
      this.pushLine(feed, `▸ also tracking ${ticketIdent}: ${title}`);
      if (feed.workspaceThreadId) {
        const workspaceThreadId = feed.workspaceThreadId;
        this.mapWorkspace(workspaceThreadId, feed.channelId, ticketIdent);
        if (feed.workspaceIntroPosted) {
          void this.gateway
            .post(workspaceThreadId, `Also tracking ${ticketIdent}: ${title}`)
            .catch((err) => {
              this.log.warn("ticket workspace addition post failed", {
                threadId: workspaceThreadId,
                ticket: ticketIdent,
                error: String(err),
              });
            });
        }
      }
    }

    // Drain any pre-registration events for this ticket into the feed (tagged if multi-ticket).
    const pending = this.pendingByTicket.get(ticketIdent);
    if (pending && pending.length) {
      const prefix = feed.multiTicket ? `[${ticketIdent}] ` : "";
      for (const line of pending) this.pushLine(feed, prefix + line);
      this.pendingByTicket.delete(ticketIdent);
    }

    this.ensureOpen(feed);
    this.ensureWorkspaceOpen(feed);
    this.scheduleFlush(feed);
  }

  /** Resolve an inbound Discord channel to its persisted ticket workspace, if it is one. */
  workspaceContext(channelId: string): TicketWorkspaceContext | null {
    const route = this.workspaceByThread.get(channelId);
    if (!route) return null;
    return {
      parentChannelId: route.parentChannelId,
      ticketIdents: [...route.ticketIdents].sort(),
    };
  }

  /**
   * Route one worker event to its ticket's thread. If the thread isn't registered yet (events beat
   * the ack), buffer it per-ticket (bounded) to be drained by {@link openThread}. Terminal events
   * flush promptly; everything else coalesces into the next digest post.
   */
  event(ticketIdent: string, ev: WorkerEvent, ctx: ProgressContext): void {
    const anchor = this.anchorByTicket.get(ticketIdent);
    let feed = anchor ? this.feeds.get(anchor) : undefined;
    if (!feed) feed = this.restoreFeed(ticketIdent);
    if (feed) this.ensureWorkspaceOpen(feed);
    const line = formatEvent(ev, ctx, feed?.toolNames);
    if (line === null) return; // event not worth surfacing (noise: partial text, turn ticks, echoes)

    if (!feed) {
      // No thread yet — buffer per ticket (drop-oldest) until openThread lands.
      const pending = this.pendingByTicket.get(ticketIdent) ?? [];
      if (pending.length >= MAX_BUFFER_LINES) pending.shift();
      pending.push(line);
      this.pendingByTicket.set(ticketIdent, pending);
      return;
    }

    this.pushLine(feed, feed.multiTicket ? `[${ticketIdent}] ${line}` : line);
    if (ev.kind === "finished" || ev.kind === "error") this.flush(feed);
    else this.scheduleFlush(feed);
  }

  /** Cancel every pending flush/retry timer (shutdown + tests). */
  dispose(): void {
    for (const feed of this.feeds.values()) {
      if (feed.flushTimer) clearTimeout(feed.flushTimer);
      feed.flushTimer = null;
      if (feed.workspaceRetryTimer) clearTimeout(feed.workspaceRetryTimer);
      feed.workspaceRetryTimer = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  /** Append a line, dropping the oldest under backpressure so the backlog can't grow unbounded. */
  private pushLine(feed: ThreadFeed, line: string): void {
    if (feed.buffer.length >= MAX_BUFFER_LINES) {
      feed.buffer.shift();
      feed.elided++;
    }
    feed.buffer.push(line);
  }

  /** Arm the coalescing timer if one isn't already pending. */
  private scheduleFlush(feed: ThreadFeed): void {
    if (feed.flushTimer) return;
    feed.flushTimer = setTimeout(() => {
      feed.flushTimer = null;
      void this.flush(feed);
    }, this.flushIntervalMs);
  }

  /**
   * Post ONE digest of the oldest buffered lines (≤{@link MAX_POST_CHARS}). If the thread isn't
   * open yet, kick the open and stay buffered (the open's success re-flushes). If lines remain
   * after the post, re-arm the timer so the rest drain on the next tick (steady, rate-safe stream).
   */
  private async flush(feed: ThreadFeed): Promise<void> {
    if (feed.flushTimer) {
      clearTimeout(feed.flushTimer);
      feed.flushTimer = null;
    }
    if (!feed.threadId) {
      this.ensureOpen(feed);
      return;
    }
    if (feed.buffer.length === 0) return;

    const chunk = this.drainChunk(feed);
    try {
      await this.gateway.post(feed.threadId, chunk);
    } catch (err) {
      this.log.warn("progress thread post failed (dropped)", {
        threadId: feed.threadId,
        error: String(err),
      });
    }
    if (feed.buffer.length > 0) this.scheduleFlush(feed);
  }

  /** Pull the oldest lines that fit one post, prefixing an elision marker if any were dropped. */
  private drainChunk(feed: ThreadFeed): string {
    const lines: string[] = [];
    if (feed.elided > 0) {
      lines.push(`… ${feed.elided} earlier events elided (backlog trimmed)`);
      feed.elided = 0;
    }
    let size = lines[0]?.length ?? 0;
    while (feed.buffer.length > 0) {
      const next = feed.buffer[0]!;
      const add = next.length + 1;
      if (lines.length > 0 && size + add > MAX_POST_CHARS) break;
      lines.push(next);
      feed.buffer.shift();
      size += add;
    }
    return lines.join("\n").slice(0, MAX_POST_CHARS);
  }

  /**
   * Open the Discord thread for a feed if it isn't open (or opening). Best-effort: transient
   * failures retry, but permanent failures (DMs cannot host threads) and repeated failures degrade
   * to parent-channel digest posts so the feed does not retry forever.
   */
  private ensureOpen(feed: ThreadFeed): void {
    if (feed.threadId || feed.opening || feed.degradedToChannel) return;
    feed.opening = true;
    feed.openAttempts++;
    void this.gateway
      .startThread(feed.channelId, feed.anchorMessageId, feed.name)
      .then((threadId) => {
        feed.opening = false;
        feed.openAttempts = 0;
        feed.threadId = threadId;
        this.remember(feed, threadId);
        this.postWorkspaceIntro(feed);
        void this.flush(feed);
      })
      .catch((err) => {
        feed.opening = false;
        const error = String(err);
        const permanent = /cannot host a thread|dm|direct message/i.test(error);
        if (permanent || feed.openAttempts >= this.openMaxAttempts) {
          feed.degradedToChannel = true;
          feed.threadId = feed.channelId;
          this.remember(feed, feed.channelId);
          this.pushLine(
            feed,
            `Progress thread unavailable; posting ${feed.name} progress digests here instead.`,
          );
          this.log.warn("progress thread open failed — degrading to parent channel", {
            anchorMessageId: feed.anchorMessageId,
            attempts: feed.openAttempts,
            error,
          });
          this.postWorkspaceIntro(feed);
          void this.flush(feed);
          return;
        }
        this.log.warn("progress thread open failed — will retry", {
          anchorMessageId: feed.anchorMessageId,
          attempts: feed.openAttempts,
          error,
        });
        // Retry even if no further events arrive (e.g. the worker finished before the gateway came back).
        if (!feed.flushTimer) {
          feed.flushTimer = setTimeout(() => {
            feed.flushTimer = null;
            void this.flush(feed);
          }, this.openRetryMs);
        }
      });
  }

  /** Open the quiet sibling thread used for human-to-Beckett collaboration. */
  private ensureWorkspaceOpen(feed: ThreadFeed): void {
    if (feed.workspaceThreadId || feed.workspaceOpening || feed.workspaceFailed) return;
    feed.workspaceOpening = true;
    feed.workspaceOpenAttempts++;
    void this.gateway
      .startStandaloneThread(feed.channelId, feed.workspaceName)
      .then((threadId) => {
        feed.workspaceOpening = false;
        feed.workspaceOpenAttempts = 0;
        feed.workspaceThreadId = threadId;
        for (const ticketIdent of feed.ticketIdents) {
          this.mapWorkspace(threadId, feed.channelId, ticketIdent);
        }
        if (feed.threadId) this.remember(feed, feed.threadId);
        this.postWorkspaceIntro(feed);
      })
      .catch((err) => {
        feed.workspaceOpening = false;
        const error = String(err);
        const permanent = /cannot host a thread|dm|direct message/i.test(error);
        if (permanent || feed.workspaceOpenAttempts >= this.openMaxAttempts) {
          feed.workspaceFailed = true;
          this.pushLine(
            feed,
            "Human workspace unavailable; talk to Beckett from the parent channel instead.",
          );
          this.log.warn("ticket workspace open failed — leaving the parent channel as fallback", {
            anchorMessageId: feed.anchorMessageId,
            attempts: feed.workspaceOpenAttempts,
            error,
          });
          void this.flush(feed);
          return;
        }
        this.log.warn("ticket workspace open failed — will retry", {
          anchorMessageId: feed.anchorMessageId,
          attempts: feed.workspaceOpenAttempts,
          error,
        });
        if (!feed.workspaceRetryTimer) {
          feed.workspaceRetryTimer = setTimeout(() => {
            feed.workspaceRetryTimer = null;
            this.ensureWorkspaceOpen(feed);
          }, this.openRetryMs);
        }
      });
  }

  /** Post one fixed orientation line once both sibling destinations are known. */
  private postWorkspaceIntro(feed: ThreadFeed): void {
    if (feed.workspaceIntroPosted || !feed.workspaceThreadId || !feed.threadId) return;
    feed.workspaceIntroPosted = true;
    const tickets = [...feed.ticketIdents].sort().join(", ");
    void this.gateway
      .post(
        feed.workspaceThreadId,
        `This is the human workspace for ${tickets}. Talk to me here without an @mention. ` +
          `Worker activity stays in <#${feed.threadId}>.`,
      )
      .catch((err) => {
        this.log.warn("ticket workspace intro failed", {
          threadId: feed.workspaceThreadId,
          error: String(err),
        });
      });
  }

  private mapWorkspace(threadId: string, parentChannelId: string, ticketIdent: string): void {
    const route = this.workspaceByThread.get(threadId) ?? {
      parentChannelId,
      ticketIdents: new Set<string>(),
    };
    route.ticketIdents.add(ticketIdent);
    this.workspaceByThread.set(threadId, route);
  }

  private restoreFeed(ticketIdent: string): ThreadFeed | undefined {
    const saved = this.savedByTicket.get(ticketIdent);
    if (!saved) return undefined;
    const anchor = saved.activityThreadId;
    this.anchorByTicket.set(ticketIdent, anchor);
    let feed = this.feeds.get(anchor);
    if (!feed) {
      feed = {
        channelId: saved.channelId,
        anchorMessageId: anchor,
        name: saved.activityName,
        ticketIdents: new Set([ticketIdent]),
        threadId: saved.activityThreadId,
        opening: false,
        openAttempts: 0,
        degradedToChannel: saved.activityThreadId === saved.channelId,
        multiTicket: false,
        buffer: [],
        elided: 0,
        flushTimer: null,
        toolNames: new Map(),
        workspaceName: saved.workspaceName,
        workspaceThreadId: saved.workspaceThreadId,
        workspaceOpening: false,
        workspaceOpenAttempts: 0,
        workspaceFailed: false,
        workspaceRetryTimer: null,
        workspaceIntroPosted: saved.workspaceThreadId !== null,
      };
      this.feeds.set(anchor, feed);
    } else {
      feed.ticketIdents.add(ticketIdent);
      if (feed.ticketIdents.size > 1) feed.multiTicket = true;
    }
    if (feed.workspaceThreadId) this.mapWorkspace(feed.workspaceThreadId, feed.channelId, ticketIdent);
    return feed;
  }

  private remember(feed: ThreadFeed, threadId: string): void {
    for (const ticketIdent of feed.ticketIdents) {
      this.savedByTicket.set(ticketIdent, {
        channelId: feed.channelId,
        activityThreadId: threadId,
        activityName: feed.name,
        workspaceThreadId: feed.workspaceThreadId,
        workspaceName: feed.workspaceName,
      });
      if (feed.workspaceThreadId) {
        this.mapWorkspace(feed.workspaceThreadId, feed.channelId, ticketIdent);
      }
    }
    this.saveState();
  }

  private loadState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [ticketIdent, rec] of Object.entries(raw)) {
        const channelId = typeof rec?.channelId === "string" ? rec.channelId : null;
        // Backward compatible with the original `{ threadId, name }` state shape.
        const activityThreadId =
          typeof rec?.activityThreadId === "string"
            ? rec.activityThreadId
            : typeof rec?.threadId === "string"
              ? rec.threadId
              : null;
        const activityName =
          typeof rec?.activityName === "string"
            ? rec.activityName
            : typeof rec?.name === "string"
              ? rec.name
              : `${ticketIdent} · activity`;
        if (!channelId || !activityThreadId) continue;
        const stored: StoredThread = {
          channelId,
          activityThreadId,
          activityName,
          workspaceThreadId: typeof rec.workspaceThreadId === "string" ? rec.workspaceThreadId : null,
          workspaceName:
            typeof rec.workspaceName === "string" ? rec.workspaceName : `${ticketIdent} · with Beckett`,
        };
        this.savedByTicket.set(ticketIdent, stored);
        this.anchorByTicket.set(ticketIdent, activityThreadId);
        if (stored.workspaceThreadId) {
          this.mapWorkspace(stored.workspaceThreadId, channelId, ticketIdent);
        }
      }
    } catch (err) {
      this.log.warn("progress thread state load failed; starting fresh", { err: String(err) });
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(
        this.stateFile,
        JSON.stringify(Object.fromEntries(this.savedByTicket.entries()), null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      this.log.warn("progress thread state save failed", { err: String(err) });
    }
  }
}

/** Factory matching the repo's `createX` convention. */
export function createProgressHub(
  gateway: ThreadCapableGateway,
  logger?: Logger,
  opts?: ProgressHubOptions,
): ProgressHub {
  return new ProgressHub(gateway, logger, opts);
}

// =======================================================================================
// event → line formatting
// =======================================================================================

/** Longest tool-input hint we inline before truncating (keeps each line compact). */
const HINT_MAX = 80;
/** Longest finish/error summary we inline in the thread. */
const SUMMARY_MAX = 400;

/**
 * Turn one {@link WorkerEvent} into a compact thread line, or null to drop it. We surface the
 * play-by-play a human would want — stage boundaries, tool calls, file edits, scope-guard blocks,
 * plan ticks, failures, and the verdict — and drop pure noise (streaming text, per-turn ticks,
 * user echoes, tool_result successes that just mirror the preceding call). `toolNames` (when
 * present) lets a `tool_result` error name the tool that failed. No emojis / no em-dashes (house
 * voice); ascii-ish markers only.
 */
export function formatEvent(
  ev: WorkerEvent,
  ctx: ProgressContext,
  toolNames?: Map<string, string>,
): string | null {
  const stage = ctx.stage;
  switch (ev.kind) {
    case "session_started":
      return `▸ ${stage} worker started (${ev.model})`;
    case "tool_call": {
      if (toolNames) toolNames.set(ev.toolId, ev.tool);
      const hint = toolHint(ev.tool, ev.input);
      return `  · ${ev.tool}${hint ? `  ${hint}` : ""}`;
    }
    case "tool_result": {
      if (!ev.isError) return null; // successes just echo the call — skip
      const tool = toolNames?.get(ev.toolId) ?? "tool";
      return `  ! ${tool} errored`;
    }
    case "file_change": {
      if (!ev.paths.length) return null;
      const shown = ev.paths.slice(0, 4).map((p) => `${changeMark(p.kind)} ${p.path}`).join(", ");
      const more = ev.paths.length > 4 ? ` (+${ev.paths.length - 4} more)` : "";
      return `  ~ ${shown}${more}`;
    }
    case "plan_update": {
      const done = ev.items.filter((i) => i.done).length;
      return `  = plan ${done}/${ev.items.length}`;
    }
    case "hook_decision": {
      // Scope-guard blocks + other hook denials are exactly the "all the hooks listed" signal.
      const verdict = ev.decision ? String(ev.decision) : "decision";
      const reason = ev.reason ? `: ${truncate(String(ev.reason), HINT_MAX)}` : "";
      return `  x hook ${verdict}${reason}`;
    }
    case "finished": {
      const mark = ev.status === "success" ? "✓" : "✗";
      const s = summaryFromStructured(ev.structuredOutput);
      return `${mark} ${stage} ${ev.status}${s ? `: ${truncate(s, SUMMARY_MAX)}` : ""}`;
    }
    case "error":
      return `⚠ ${stage}: ${truncate(ev.message, SUMMARY_MAX)}`;
    // Deliberately silent: streaming assistant text, per-turn start/complete ticks, user echoes,
    // unknown raw lines. They're either noise or belong to the sparse main-channel feed, not here.
    default:
      return null;
  }
}

/** Pull the done-signal `summary` (blocked reason falls back) from a finished event's structured output. */
function summaryFromStructured(structured: unknown | null): string {
  if (!structured || typeof structured !== "object") return "";
  const o = structured as Record<string, unknown>;
  if (typeof o.summary === "string" && o.summary.trim()) return o.summary.trim();
  if (typeof o.blockedReason === "string" && o.blockedReason.trim()) return o.blockedReason.trim();
  return "";
}

/** A short, human hint for a tool call (the command, the path) — never the full input blob. */
function toolHint(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const raw =
    pick("command") ?? // Bash
    pick("file_path") ?? // Read / Edit / Write
    pick("path") ??
    pick("pattern") ?? // Grep
    pick("query") ?? // search tools
    pick("url") ??
    "";
  return raw ? truncate(raw.replace(/\s+/g, " ").trim(), HINT_MAX) : "";
}

/** Single-char mark for a file change kind. */
function changeMark(kind: "add" | "update" | "delete"): string {
  return kind === "add" ? "+" : kind === "delete" ? "-" : "~";
}

/** Truncate to `n` chars with an ellipsis, collapsing nothing else. */
function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
