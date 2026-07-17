/**
 * SessionPool — per-channel concierge sessions (OPS-80 §9.3, the deferred "per-scope sessions").
 *
 * v4.0 ran ONE `claude -p` session for the entire Discord surface, so every turn — every user,
 * every channel, every DM — serialized through a single pump: while Beckett thought about one
 * request, everyone else waited in line behind a fast-ack. The pool removes that bottleneck by
 * keying sessions to a SCOPE (the Discord channel — a DM is its own channel), so conversations in
 * different channels run truly concurrently, bounded by a shared {@link TurnGate}.
 *
 * This also hard-partitions the model transcript the way the shared-context store already
 * partitions injection: a DM's session never hosts guild turns at all, closing the model-side
 * DM↔guild bleed that doctrine alone used to hold (multiplayer design doc §6.1 honest residual).
 *
 * Cross-channel continuity is deliberately NOT the transcript's job anymore: the knowledge graph
 * (global), the per-channel context store, and the cross-channel awareness footer carry it — the
 * same seams a rotation has always relied on.
 *
 * Process economics: each session is one `claude` child. The pool bounds LIVE children
 * (`max_live_sessions`) by recycling the least-recently-used IDLE session's child — its transcript
 * survives (`--resume` on the next turn), exactly the existing timeout-recycle semantics. An idle
 * timer applies the same treatment to sessions quiet for `idle_recycle_minutes`.
 *
 * Tests can pin a single fixed session (the legacy injection surface) — every scope then resolves
 * to it and the pool degrades to v4.0 behavior, keeping the existing test fleet meaningful.
 */
import type { Logger } from "../types.ts";
import { log as rootLog } from "../log.ts";
import type { TurnMessage } from "./index.ts";
import { coerceDiscordTurnOutput, type DiscordTurnOutput } from "./output.ts";

/** The slice of ConciergeSession the pool routes through (structural — no runtime import cycle). */
export interface PoolSession {
  start?(): Promise<void>;
  stop(): Promise<void>;
  /** String is legacy support for injected test doubles; real sessions return DiscordTurnOutput. */
  ask(message: TurnMessage, meta?: unknown, opts?: { priority?: boolean }): Promise<DiscordTurnOutput | string>;
  requestReload?(): void;
  queueDepth?(): number;
  currentSessionId?(): string;
  getCurrentMeta?(): unknown;
  stats?(): Record<string, unknown>;
  /** Kill the child process, keep the session (`--resume` on the next turn). */
  recycle?(reason: string): void;
  hasLiveChild?(): boolean;
  /** Per-process issuer credential exported into the child env (bus-op correlation, §9.3). */
  busToken?(): string;
}

export interface SessionPoolOptions {
  /** "channel" = one session per channel id; "global" = every scope resolves to one session. */
  scope: "channel" | "global";
  /** Live `claude` children allowed before LRU idle recycling kicks in. */
  maxLiveSessions: number;
  /** Recycle a session's child after this much idle time (0/negative disables the timer). */
  idleRecycleMs: number;
  /**
   * Called when an idle, child-less entry is evicted from the pool (its per-scope state persists
   * on disk, so the scope resumes on its next turn). Lets the owner drop per-scope caches — e.g.
   * the Concierge's awareness-suppression map — so neither side grows without bound.
   */
  onEvict?: (scopeKey: string) => void;
  /** Build a real session for a scope key. Unused when {@link fixedSession} is set. */
  makeSession: (scopeKey: string) => PoolSession;
  /**
   * Pin every scope to ONE session (test injection / legacy single-session mode). The pool never
   * starts, stops-all still stops it once, and scope keys collapse to {@link GLOBAL_SCOPE}.
   */
  fixedSession?: PoolSession;
  logger?: Logger;
}

export const GLOBAL_SCOPE = "global";

interface PoolEntry {
  session: PoolSession;
  /** start() in flight or settled — every ask awaits it so a turn can't race the launch. */
  ready: Promise<void>;
  /** Set once ready resolved — lets ask() skip the await (and stay synchronous up to session.ask). */
  started: boolean;
  lastUsedAt: number;
}

export class SessionPool {
  private readonly opts: SessionPoolOptions;
  private readonly log: Logger;
  private readonly entries = new Map<string, PoolEntry>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Legacy parity: a fixed session is started exactly once, by warm() (i.e. Concierge.start()). */
  private fixedStarted = false;

  constructor(opts: SessionPoolOptions) {
    this.opts = opts;
    this.log = (opts.logger ?? rootLog).child("concierge.pool");
    if (opts.fixedSession) {
      // Pre-seeded as started: legacy fakes expect ask() to reach session.ask synchronously, and
      // the real single-session mode never gated asks on start() either (ask() self-relaunches).
      this.entries.set(GLOBAL_SCOPE, {
        session: opts.fixedSession,
        ready: Promise.resolve(),
        started: true,
        lastUsedAt: Date.now(),
      });
    }
  }

  /** Channel id → scope key. Fixed-session and global modes collapse everything to one scope. */
  scopeKey(channelId: string): string {
    if (this.opts.fixedSession || this.opts.scope === "global") return GLOBAL_SCOPE;
    return channelId.trim() || GLOBAL_SCOPE;
  }

  /**
   * The session for a channel, created (and started) on first use. Synchronous by design — the
   * queue-depth fast-ack check needs it without awaiting; {@link ask} awaits readiness itself.
   */
  sessionFor(channelId: string): PoolSession {
    return this.entryFor(channelId).session;
  }

  private entryFor(channelId: string): PoolEntry {
    const key = this.scopeKey(channelId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.stopped) throw new Error("concierge session pool is stopped");
    const session = this.opts.makeSession(key);
    const entry: PoolEntry = {
      session,
      ready: Promise.resolve(),
      started: false,
      lastUsedAt: Date.now(),
    };
    entry.ready = (session.start?.() ?? Promise.resolve()).then(
      () => {
        entry.started = true;
      },
      (err) => {
        // A failed launch must not poison the scope forever — drop the entry so the next turn
        // retries a fresh start, and surface the failure to the awaiting ask().
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    // Mark the rejection handled: the synchronous sessionFor() path (the fast-ack queue-depth
    // check) may never await `ready` — a failed launch must surface to the next ask(), not as an
    // unhandled rejection that can take down the daemon.
    entry.ready.catch(() => undefined);
    this.entries.set(key, entry);
    this.enforceLiveCap(key);
    this.armIdleTimer();
    return entry;
  }

  /** Ensure a scope's session is up NOW (boot fail-fast for the home scope). */
  async warm(channelId: string): Promise<void> {
    const entry = this.entryFor(channelId);
    if (this.opts.fixedSession && !this.fixedStarted) {
      // Legacy parity: Concierge.start() used to be the one start() call on the injected session.
      this.fixedStarted = true;
      await this.opts.fixedSession.start?.();
      return;
    }
    await entry.ready;
  }

  /** Run one turn on the channel's session (creates/starts/resumes it as needed). */
  async ask(
    channelId: string,
    message: TurnMessage,
    meta?: unknown,
    opts?: { priority?: boolean },
  ): Promise<DiscordTurnOutput> {
    const entry = this.entryFor(channelId);
    // Synchronous up to session.ask() when the session is already up — queue admission (and the
    // priority jump) must not lose a race to an intervening microtask.
    if (!entry.started) await entry.ready;
    entry.lastUsedAt = Date.now();
    try {
      // Real ConciergeSessions return this discriminated value after validating Claude's
      // structured_output. Coercion only keeps pre-existing untyped injected test doubles usable;
      // assistant text from a real model never reaches this boundary.
      return coerceDiscordTurnOutput(await entry.session.ask(message, meta, opts));
    } finally {
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * Metas of turns EXECUTING right now, across every session (reply-claim correlation under
   * concurrency). Empty when nothing runs. `tracksMeta()` distinguishes "no live turn" from
   * "injected fake session that doesn't track meta at all" (the legacy test surface).
   */
  currentMetas(): unknown[] {
    const metas: unknown[] = [];
    for (const { session } of this.entries.values()) {
      const meta = session.getCurrentMeta?.();
      if (meta) metas.push(meta);
    }
    return metas;
  }

  /** True iff every session exposes meta tracking (real sessions do; fake test doubles may not). */
  tracksMeta(): boolean {
    for (const { session } of this.entries.values()) {
      if (typeof session.getCurrentMeta !== "function") return false;
    }
    return true;
  }

  /**
   * Exact bus-op correlation (OPS-80 §9.3): resolve an issuer token — the secret a session exports
   * into its child's env — to the meta of the turn EXECUTING on that session right now. Returns
   * null for an unknown/stale token or a token whose session is between turns: the caller must
   * deny rather than fall back to guessing by channel.
   */
  metaForToken(token: string): unknown {
    if (!token) return null;
    for (const { session } of this.entries.values()) {
      if (session.busToken?.() === token) return session.getCurrentMeta?.() ?? null;
    }
    return null;
  }

  /** The live sessionId for a channel's scope (watermarks + awareness suppression are keyed to it). */
  sessionIdFor(channelId: string): string {
    return this.sessionFor(channelId).currentSessionId?.() ?? "";
  }

  /** Persona/doctrine reload for every live session (each re-grounds at its own turn boundary). */
  requestReloadAll(): void {
    for (const { session } of this.entries.values()) session.requestReload?.();
  }

  /** Per-scope session health + pool shape, for `beckett status`. */
  stats(): Record<string, unknown> {
    const sessions: Record<string, unknown> = {};
    let liveChildren = 0;
    for (const [key, { session }] of this.entries) {
      sessions[key] = session.stats?.() ?? {};
      if (session.hasLiveChild?.()) liveChildren += 1;
    }
    return {
      scope: this.opts.fixedSession ? "global" : this.opts.scope,
      sessions: this.entries.size,
      liveChildren,
      maxLiveSessions: this.opts.maxLiveSessions,
      perSession: sessions,
    };
  }

  /** Stop every session and refuse further creation (daemon shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    const sessions = [...this.entries.values()].map((e) => e.session);
    this.entries.clear();
    await Promise.all(
      sessions.map((s) =>
        s.stop().catch((err) => this.log.warn("session stop failed", { err: String(err) })),
      ),
    );
  }

  // ── child-process economics ────────────────────────────────────────────────────────────────

  /** Over the live-children cap? Recycle LRU idle sessions' children (never the busy, never `keep`). */
  private enforceLiveCap(keep: string): void {
    const live = [...this.entries.entries()].filter(([, e]) => e.session.hasLiveChild?.() === true);
    // The `keep` scope was just created and is ABOUT to spawn a child — count it now, or the pool
    // would run one child over the cap until the next creation.
    const pending = live.some(([key]) => key === keep) ? 0 : 1;
    let excess = live.length + pending - Math.max(1, this.opts.maxLiveSessions);
    if (excess <= 0) return;
    const victims = live
      .filter(([key, e]) => key !== keep && (e.session.queueDepth?.() ?? 0) === 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of victims) {
      if (excess <= 0) break;
      entry.session.recycle?.("session pool live-child cap");
      this.log.info("recycled idle concierge session child (live cap)", { scope: key });
      excess -= 1;
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.stopped) return;
    const idleMs = this.opts.idleRecycleMs;
    if (!(idleMs > 0)) return;
    const tick = Math.max(30_000, Math.min(idleMs, 5 * 60_000));
    this.idleTimer = setInterval(() => this.idleSweep(Date.now()), tick);
    // Never keep the process alive just for housekeeping (bun timers support unref).
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** One idle-housekeeping pass: recycle long-idle children; evict long-idle child-less entries. */
  private idleSweep(now: number): void {
    const idleMs = this.opts.idleRecycleMs;
    for (const [key, entry] of this.entries) {
      if ((entry.session.queueDepth?.() ?? 0) > 0) continue;
      if (now - entry.lastUsedAt < idleMs) continue;
      if (entry.session.hasLiveChild?.() === true) {
        entry.session.recycle?.("idle session recycle");
        this.log.info("recycled idle concierge session child (idle timer)", { scope: key });
      } else {
        // Long-idle and child-less: drop the entry entirely so the pool (and the owner's
        // per-scope caches) can't grow one entry per channel forever. The scope's session state
        // is on disk — its next turn recreates the entry and resumes the same conversation.
        this.entries.delete(key);
        this.opts.onEvict?.(key);
        void entry.session
          .stop()
          .catch((err) => this.log.warn("evicted session stop failed", { err: String(err) }));
        this.log.info("evicted idle concierge session entry", { scope: key });
      }
    }
  }
}

export function createSessionPool(opts: SessionPoolOptions): SessionPool {
  return new SessionPool(opts);
}
