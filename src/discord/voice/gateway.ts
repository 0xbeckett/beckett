/**
 * Beckett — voice gateway + authorization (`src/discord/voice/gateway.ts`)
 * =======================================================================================
 * The entry point for joining/leaving a voice channel, and the ONE authorization gate for it.
 *
 * Joining/leaving voice is a maintainer-grade action — the same authority the four elevated
 * verbs (push / merge / deploy / restart) use. {@link canControlVoice} encodes that exactly:
 * owner and maintainers only. The gate is CODE-enforced here (not left to the model): every
 * {@link VoiceGateway.join} and {@link VoiceGateway.leave} is checked against the caller's
 * access level, taken from Discord's authenticated author id via the injected classifier —
 * never from chat content — mirroring how `access.ts`/`maintainers.ts` resolve authority.
 *
 * A bot can be in at most one voice channel per guild, so the gateway holds one live session
 * per guild and moves/replaces it on a fresh join.
 */

import type { Logger } from "../../types.ts";
import { log as rootLog } from "../../log.ts";
import type { AccessLevel, VoiceBackend, VoiceSession } from "./types.ts";
import { DiscordVoiceSession, type VoiceSessionOptions } from "./session.ts";

/**
 * Whether an access level may control the voice channel. Owner and maintainer only — the exact
 * set that may have Beckett push/merge/deploy/restart. Members and outsiders are refused.
 */
export function canControlVoice(level: AccessLevel): boolean {
  return level === "owner" || level === "maintainer";
}

/** Raised (and typed) when a non-owner/maintainer tries to join or leave voice. */
export class VoiceAuthorizationError extends Error {
  readonly userId: string;
  readonly level: AccessLevel;
  constructor(userId: string, level: AccessLevel) {
    super(`voice control is owner/maintainer only — ${userId} is '${level}'`);
    this.name = "VoiceAuthorizationError";
    this.userId = userId;
    this.level = level;
  }
}

/** What a join needs: which channel, and who is asking (for the code-enforced gate). */
export interface JoinRequest {
  guildId: string;
  channelId: string;
  /** Discord user id of the requester — MUST come from the authenticated message author. */
  requestedByUserId: string;
}

/**
 * Opens a real {@link VoiceBackend} for a channel. Injected so the gateway is testable with an
 * in-memory fake and the daemon wires the `@discordjs/voice` implementation.
 */
export type VoiceBackendFactory = (req: {
  guildId: string;
  channelId: string;
}) => Promise<VoiceBackend>;

export interface VoiceGatewayOptions {
  /** Opens a backend for a channel (the real adapter, or a fake in tests). */
  backendFactory: VoiceBackendFactory;
  /** Resolve a user's access level from their AUTHENTICATED Discord id (never chat content). */
  authorize: (userId: string) => AccessLevel;
  logger?: Logger;
  /** Session tuning forwarded to every session (utterance cap, barge-in, clock). */
  sessionOptions?: Pick<VoiceSessionOptions, "maxUtteranceMs" | "bargeIn" | "now">;
}

/** Manages voice sessions and enforces the owner/maintainer gate. */
export class VoiceGateway {
  private readonly backendFactory: VoiceBackendFactory;
  private readonly authorize: (userId: string) => AccessLevel;
  private readonly log: Logger;
  private readonly sessionOptions: VoiceGatewayOptions["sessionOptions"];
  /** At most one live session per guild (a bot occupies one voice channel per guild). */
  private readonly sessions = new Map<string, DiscordVoiceSession>();

  constructor(opts: VoiceGatewayOptions) {
    this.backendFactory = opts.backendFactory;
    this.authorize = opts.authorize;
    this.log = opts.logger ?? rootLog.child("voice");
    this.sessionOptions = opts.sessionOptions;
  }

  /**
   * Join a voice channel on a requester's behalf. Throws {@link VoiceAuthorizationError} unless
   * the requester is the owner or a maintainer. If already in a channel in that guild, the old
   * session is left first (a move).
   */
  async join(req: JoinRequest): Promise<VoiceSession> {
    const level = this.authorize(req.requestedByUserId);
    if (!canControlVoice(level)) {
      this.log.warn("voice join refused — not owner/maintainer", {
        userId: req.requestedByUserId,
        level,
        channelId: req.channelId,
      });
      throw new VoiceAuthorizationError(req.requestedByUserId, level);
    }

    const existing = this.sessions.get(req.guildId);
    if (existing) {
      if (existing.channelId === req.channelId) return existing; // already there
      await existing.leave().catch((err) =>
        this.log.warn("leaving prior voice session failed", { error: String(err) }),
      );
      this.sessions.delete(req.guildId);
    }

    const backend = await this.backendFactory({ guildId: req.guildId, channelId: req.channelId });
    const session = new DiscordVoiceSession({
      guildId: req.guildId,
      channelId: req.channelId,
      backend,
      logger: this.log,
      ...this.sessionOptions,
    });
    this.sessions.set(req.guildId, session);
    this.log.info("voice joined", {
      guildId: req.guildId,
      channelId: req.channelId,
      requestedBy: req.requestedByUserId,
      level,
    });
    return session;
  }

  /**
   * Leave the guild's voice channel. Same owner/maintainer gate as {@link join}. A leave with no
   * active session is a no-op (returns false).
   */
  async leave(guildId: string, requestedByUserId: string): Promise<boolean> {
    const level = this.authorize(requestedByUserId);
    if (!canControlVoice(level)) {
      this.log.warn("voice leave refused — not owner/maintainer", { userId: requestedByUserId, level });
      throw new VoiceAuthorizationError(requestedByUserId, level);
    }
    const session = this.sessions.get(guildId);
    if (!session) return false;
    this.sessions.delete(guildId);
    await session.leave();
    return true;
  }

  /** The live session for a guild, if any (for the next branch to attach its listeners). */
  session(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /** Leave every channel — called on daemon shutdown. Not gated (internal lifecycle). */
  async leaveAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.leave().catch(() => {})));
  }
}
