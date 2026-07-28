/**
 * Beckett — Discord Gateway (`src/discord/gateway.ts`)
 * =======================================================================================
 * The "front porch": the one long-lived discord.js v14 `Client` that is Beckett's only
 * human-facing surface (Spec 05). It owns the gateway WebSocket, captures every inbound
 * message as a normalized {@link IncomingMessage}, and posts Beckett's sparse replies back
 * to the SAME channel (ambient model — no threads, Spec 05 §2). It implements the frozen
 * {@link DiscordGateway} contract and nothing more: routing precedence (awaiting-reply
 * resolution vs fresh mention vs steering-as-nudge) is the Orchestrator's job — this layer
 * hands it a rich `IncomingMessage` (with `repliedToId` + `mentionsBot`) and lets the loop
 * decide (Spec 05 §2.2 defers the state machine + control primitives to Specs 04/03).
 *
 * Design notes anchored to canon:
 *  - **Privileged MessageContent intent** is mandatory — Beckett's whole model is reading
 *    free-text `@beckett` mentions (Spec 05 §1.1, Risk-E). Without it `message.content` is
 *    empty and the gateway rejects the connection.
 *  - **Auto-reconnect is discord.js's job**, not ours (Spec 05 §1.2). We only observe shard
 *    lifecycle for diagnostics + to drive the outbound flush.
 *  - **No post is lost when the ws drops** (Spec 01 §6 failure table): while disconnected,
 *    `post()` queues the message and resolves the caller's promise with the real message id
 *    once it actually lands on reconnect. Workers don't depend on the ws, so the work
 *    completes and is simply delivered late. Edits differ deliberately: a stale progress
 *    update has no value, so offline edits are coalesced last-write-wins per message and their
 *    caller receives a typed transient error rather than waiting across the disconnect.
 *  - **Sparseness is law** (Spec 05 §7): the gateway is a dumb pipe — it posts exactly what
 *    it's told. Deciding *whether* to speak (the five YES moments) lives in the loop/Brain.
 *  - **Loop guard**: bot-authored messages (incl. our own) are dropped before they reach the
 *    handler, preventing an ack-of-an-ack cascade (Spec 05 §2.2 / §9.2).
 *  - **Threads are observed, never opened**: Beckett does not create threads for its own work —
 *    a PERSON opens one and attaches work to it. The gateway's whole job here is to make a thread
 *    visible: every inbound message carries `isThread`/`parentChannelId` read off the live
 *    channel, and a thread surfaces whether it was just created OR Beckett was merely added to it.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type {
  DiscordGateway,
  DiscordMessageEditPayload,
  IncomingMessage,
  DiscordComponentInteraction,
  ReplyContextMessage,
  ReplyOptions,
  TaskThreadCreated,
  ThreadCreated,
  Config,
  Logger,
} from "../types.ts";
import { log as rootLog } from "../log.ts";
import { isInternalUrl } from "../net/url-safety.ts";
import { isFederatedPeer, PeerBurstLimiter } from "./federation.ts";
import { loadPeers } from "./peers.ts";
import { buildPaths } from "../paths.ts";
import { chunkReply, delaySchedule, TOTAL_DELAY_BUDGET_MS } from "./chunk.ts";
import {
  BROWSER_QUESTION_ATTACHMENT_NAME,
  isBrowserQuestionMessage,
} from "../browser/question-message.ts";

/** Discord's hard per-message ceiling (Spec 05 §9.1). */
const DISCORD_MAX_CHARS = 2000;

/** Snowflakes are decimal 64-bit integers; malformed test/legacy cursors degrade to inequality. */
function snowflakeAfter(id: string, cursor: string): boolean {
  try {
    return BigInt(id) > BigInt(cursor);
  } catch {
    return id !== cursor;
  }
}

/** A post buffered while the gateway is down, flushed on reconnect (Spec 01 §6). */
interface QueuedPost {
  channelId: string;
  content: string;
  opts?: ReplyOptions;
  resolve: (messageId: string) => void;
  reject: (err: Error) => void;
}

/** A latest-only edit buffered across a gateway outage. */
interface QueuedEdit {
  channelId: string;
  messageId: string;
  payload: DiscordMessageEditPayload;
}

/** Base class for every edit failure. Consumers can catch this instead of parsing Discord text. */
export class DiscordMessageEditError extends Error {
  readonly kind: "unknown-message" | "permission" | "transient" | "failed";
  readonly channelId: string;
  readonly messageId: string;

  constructor(
    kind: DiscordMessageEditError["kind"],
    channelId: string,
    messageId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiscordMessageEditError";
    this.kind = kind;
    this.channelId = channelId;
    this.messageId = messageId;
  }
}

/** The target was deleted (Discord HTTP 404 / code 10008); callers should post a replacement. */
export class DiscordUnknownMessageError extends DiscordMessageEditError {
  constructor(channelId: string, messageId: string, options?: ErrorOptions) {
    super("unknown-message", channelId, messageId, "discord message no longer exists", options);
    this.name = "DiscordUnknownMessageError";
  }
}

/** The bot cannot edit this message; retrying will not help until permissions change. */
export class DiscordMessageEditPermissionError extends DiscordMessageEditError {
  constructor(channelId: string, messageId: string, options?: ErrorOptions) {
    super("permission", channelId, messageId, "discord permission denied while editing message", options);
    this.name = "DiscordMessageEditPermissionError";
  }
}

/** A disconnect, Discord 5xx, or rate limit; callers should skip this tick and try later. */
export class DiscordTransientMessageEditError extends DiscordMessageEditError {
  /** Server-requested delay, when the transient failure was a rate limit. */
  readonly retryAfterMs: number | undefined;

  constructor(
    channelId: string,
    messageId: string,
    message: string,
    retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super("transient", channelId, messageId, message, options);
    this.name = "DiscordTransientMessageEditError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Construction options. The daemon wires these; `token` falls back to `DISCORD_TOKEN`. */
export interface GatewayOptions {
  /** Bot token. Defaults to `process.env.DISCORD_TOKEN` (loaded from `.env` by config). */
  token?: string;
  /** Full config (reserved for chattiness/reply-mode hooks; reply mode is always 'same'). */
  config?: Config;
  /** Override the living peer-file path (tests). Defaults to `buildPaths(config).peersFile`. */
  peersFile?: string;
  /** Logger to bind under the `discord` component. Defaults to the root logger child. */
  logger?: Logger;
}

/**
 * The concrete {@link DiscordGateway}. One instance per daemon; the connection is
 * process-lifetime (Spec 05 §1.2 — there is no per-task connection).
 */
export class DiscordJsGateway implements DiscordGateway {
  private client: Client | undefined;
  private readonly logger: Logger;
  private readonly token: string | undefined;

  /** Baseline trusted peer-Beckett bot ids from config (`federation.peers`) — the deploy-managed
   *  seed. The owner-added live list (`peers.txt`) is unioned on top at read time. */
  private readonly baselinePeers: ReadonlySet<string>;
  /** Path to the living peer file (`peers.txt`), read fresh per bot message so owner adds take
   *  effect with NO restart. Undefined only when no config was supplied (tests). */
  private readonly peersFile: string | undefined;
  /** Runaway backstop for peer-bot traffic — caps processed peer messages per channel per minute. */
  private readonly peerBurst: PeerBurstLimiter;

  /** The single inbound handler the Orchestrator registers via {@link onMessage}. */
  private handler: ((m: IncomingMessage) => void | Promise<void>) | undefined;

  /** Handler for user-created threads ({@link onThreadCreate}); numbered task threads register directly. */
  private threadHandler: ((t: ThreadCreated) => void | Promise<void>) | undefined;

  /** Component callback. Components need no applications.commands OAuth scope or slash command. */
  private interactionHandler: ((i: DiscordComponentInteraction) => void | Promise<void>) | undefined;

  /** Outbound posts buffered while disconnected (Spec 01 §6 — flushed on reconnect). */
  private readonly outbound: QueuedPost[] = [];
  /**
   * Latest-only edits buffered while disconnected. Unlike posts, progress edits are stale as soon
   * as a newer cycle supersedes them, so this is keyed by channel/message rather than a FIFO.
   */
  private readonly queuedEdits = new Map<string, QueuedEdit>();
  /** Per-channel Discord edit cooldowns, populated from 429 retry_after responses. */
  private readonly editRetryAt = new Map<string, number>();
  private readonly editFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushingEdits = false;
  /** Message ids posted by this process, used to recognize native no-ping replies to Beckett. */
  private readonly ownMessageIds = new Set<string>();
  /** Privacy-critical subset of own ids, marked synchronously before `sendNow` returns. */
  private readonly browserQuestionMessageIds = new Set<string>();

  /** Liveness, tracked from shard lifecycle events (more accurate than client.isReady). */
  private connected = false;

  /** Epoch ms of the last gateway event we observed (StatusReport health signal). */
  private lastEventTs: number | null = null;

  constructor(opts: GatewayOptions = {}) {
    this.token = opts.token;
    this.logger = opts.logger ?? rootLog.child("discord");
    const fed = opts.config?.federation;
    this.baselinePeers = new Set(fed?.peers ?? []);
    this.peersFile = opts.peersFile ?? (opts.config ? buildPaths(opts.config).peersFile : undefined);
    this.peerBurst = new PeerBurstLimiter(fed?.peer_burst_per_min ?? 5);
  }

  /**
   * The effective trusted-peer set for THIS message: the config baseline unioned with the live
   * `peers.txt` (owner-added, no restart). Read fresh — but only ever on the rare `author.bot`
   * path, so a normal human message never touches disk here.
   */
  private effectivePeers(): ReadonlySet<string> {
    if (!this.peersFile) return this.baselinePeers;
    const live = loadPeers(this.peersFile);
    if (this.baselinePeers.size === 0) return live;
    for (const id of this.baselinePeers) live.add(id);
    return live;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────

  /**
   * Open the gateway and resolve once `ClientReady` fires (Spec 05 §1.2 "go live" signal).
   * Idempotent: a second call while already started is a no-op. Throws loudly if the token
   * is missing or login fails — a dead interface is a refuse-to-start, not a silent degrade.
   */
  async start(): Promise<void> {
    if (this.client) return;

    const token = this.token ?? process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error(
        "beckett: DISCORD_TOKEN is not set (expected in ~/.beckett/.env) — cannot start the Discord gateway",
      );
    }

    // Threads need NO extra intent, and definitely no extra privileged one: `Guilds` already
    // delivers the full thread lifecycle (threadCreate / threadUpdate / threadDelete / thread
    // member updates), and `GuildMessages` already delivers messageCreate for messages posted
    // INSIDE a thread — Discord models a thread as a channel, so it rides the same intent as its
    // parent. Verified against the discord.js v14 intent table; do not add ThreadMembers hoping
    // to "fix" thread visibility, the gap was ours (we dropped non-newlyCreated events), not
    // Discord's.
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds, // channel/role cache + thread lifecycle — required for everything
        GatewayIntentBits.GuildMessages, // receive messageCreate in guild channels AND their threads
        GatewayIntentBits.MessageContent, // PRIVILEGED — without it message.content is empty (Risk-E)
        GatewayIntentBits.DirectMessages, // 1:1 DMs (still ambient — the DM is the channel)
        GatewayIntentBits.GuildVoiceStates, // NON-privileged; required by @discordjs/voice to join (#81)
      ],
      // DM channels/messages arrive uncached → partials so we still get the event.
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;

    this.wireListeners(client);

    // Surface REST rate-limit throttling for diagnostics; discord.js still handles the wait
    // (Spec 05 §9.3 — sparseness is the real rate-limit defense).
    client.rest.on("rateLimited", (info) => {
      this.logger.warn("discord REST rate limited", {
        route: info.route,
        method: info.method,
        timeToResetMs: info.timeToReset,
        global: info.global,
      });
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      client.once(Events.ClientReady, (c) => {
        if (settled) return;
        settled = true;
        this.connected = true;
        this.lastEventTs = Date.now();
        this.logger.info("discord gateway up", { tag: c.user.tag, botUserId: c.user.id });
        void this.flushOutbound();
        void this.flushQueuedEdits();
        resolve();
      });
      // A login/connect error before we go live is fatal to start().
      client.once(Events.Error, (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      client.login(token).catch((err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Close the gateway and unblock any callers still awaiting a queued post. */
  async stop(): Promise<void> {
    this.connected = false;
    // Drain the outbound queue: a shutdown should not leave callers hanging forever.
    const pending = this.outbound.splice(0);
    for (const p of pending) p.reject(new Error("discord gateway stopped before post was sent"));
    // Queued edits have no awaiters — each caller was already told to skip the offline tick.
    this.queuedEdits.clear();
    this.editRetryAt.clear();
    for (const timer of this.editFlushTimers.values()) clearTimeout(timer);
    this.editFlushTimers.clear();

    const client = this.client;
    if (!client) return;
    this.client = undefined;
    await client.destroy();
    this.logger.info("discord gateway stopped");
  }

  // ── inbound ──────────────────────────────────────────────────────────────────────────

  /**
   * Register the single inbound handler (Orchestrator-owned). The gateway normalizes every
   * non-bot message and hands it over; the loop applies the routing precedence ladder
   * (Spec 05 §2.2 / §4 / §5). A later call replaces the handler.
   */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void {
    if (this.handler) this.logger.warn("discord onMessage handler replaced");
    this.handler = cb;
  }

  /**
   * REST reconciliation for the gap a fresh IDENTIFY cannot replay. The caller supplies the
   * channel store's newest id; every accepted user message after it is normalized through the
   * exact event path before it reaches the Concierge. Fetch in pages so a longer deploy does not
   * silently lose the 101st message.
   */
  async fetchMessagesAfter(channelId: string, after: string): Promise<IncomingMessage[]> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`discord channel ${channelId} is not text based`);

    const messages: IncomingMessage[] = [];
    // Discord returns each page newest-first. Start with the required `after` fetch, then page
    // backwards from its oldest row; advancing `after` would skip the middle of a >100-message
    // outage when the first response is the newest hundred.
    let before: string | undefined;
    for (;;) {
      const page = await channel.messages.fetch(before ? { before, limit: 100 } : { after, limit: 100 });
      if (page.size === 0) break;
      const raw = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const missed = raw.filter((msg) => snowflakeAfter(msg.id, after));
      for (const msg of missed) {
        // Match MessageCreate's bot guard. A trusted federated peer is still a conversational
        // input; every other bot (including us) is never put through downtime catch-up.
        if (msg.author.bot) {
          if (!isFederatedPeer(msg.author.id, client.user?.id, this.effectivePeers())) continue;
          if (!this.peerBurst.allow(msg.channelId)) continue;
        }
        try {
          messages.push(await this.normalize(msg));
        } catch (err) {
          // One stale/deleted reference must not make the rest of a downtime page disappear.
          this.logger.warn("discord downtime message normalization failed", {
            channelId,
            messageId: msg.id,
            error: String(err),
          });
        }
      }
      const oldest = raw[0]?.id;
      // The page was short, or it reached the durable cursor. Either way there cannot be more
      // outage messages below this point. The duplicate guard avoids a pathological REST loop.
      if (!oldest || page.size < 100 || !snowflakeAfter(oldest, after) || oldest === before) break;
      before = oldest;
    }
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The message a native reply points at, plus the conversation around it (default ±5).
   * One REST call (`around` returns the target and its neighbours); oldest-first out, the
   * target flagged. Any failure — deleted target, missing access, thread archived — resolves
   * to null: reply-context injection is best-effort and must never break a turn.
   */
  async fetchMessageContext(
    channelId: string,
    messageId: string,
    opts?: { surrounding?: number },
  ): Promise<ReplyContextMessage[] | null> {
    const client = this.client;
    if (!client) return null;
    const surrounding = Math.max(0, Math.min(25, Math.trunc(opts?.surrounding ?? 5)));
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return null;
      const page = await channel.messages.fetch({ around: messageId, limit: surrounding * 2 + 1 });
      const rows = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      if (!rows.some((row) => row.id === messageId)) return null;
      const botId = client.user?.id;
      return rows.map((row) => ({
        messageId: row.id,
        ts: row.createdTimestamp,
        authorId: row.author.id,
        authorName:
          row.member?.displayName || row.author.globalName || row.author.username || row.author.id,
        // Attachments fold in as placeholders, same convention as the shared-context store —
        // a bare "look at this" with the image silently dropped would mislead the turn.
        content: [row.content, ...row.attachments.values().map((a) => `[file: ${a.name}]`)]
          .filter(Boolean)
          .join(" "),
        isBeckett: botId !== undefined && row.author.id === botId,
        isTarget: row.id === messageId,
      }));
    } catch (err) {
      this.logger.warn("discord reply-context fetch failed", {
        channelId,
        messageId,
        error: String(err),
      });
      return null;
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────────────────────

  /**
   * Post to a channel and return the bot message id (the reply-correlation anchor, Spec 05
   * §4.1). When connected, sends immediately. When the ws is down, the post is queued and
   * the returned promise resolves with the real id once it lands on reconnect (Spec 01 §6 —
   * no delivery is lost). A genuine send error while still connected is surfaced to the
   * caller so the loop can retry / degrade to the CLI (Spec 04 T19, Spec 05 §9.2).
   */
  async post(channelId: string, content: string, opts?: ReplyOptions): Promise<string> {
    if (this.connected && this.client) {
      try {
        return await this.sendNow(channelId, content, opts);
      } catch (err) {
        // If the drop happened mid-send, fall through to the queue; otherwise it's a real
        // failure (e.g. bad channel / permissions) the caller must handle.
        if (this.connected || opts?.queueIfOffline === false) throw err;
        this.logger.warn("post failed mid-disconnect; queueing for reconnect", {
          channelId,
          error: String(err),
        });
      }
    }
    if (opts?.queueIfOffline === false) throw new Error("discord gateway is offline");
    return this.enqueue(channelId, content, opts);
  }

  /**
   * Post a single image and return its Discord CDN URL (or null when it can't be resolved). Used to
   * surface a frontend result screenshot as the channel ping AND to embed that same hosted image on
   * the ticket record (#75) — a tracker comment can render `![](url)` but cannot host bytes. Never
   * throws: a failed URL lookup (offline/queued/permissions) degrades to null, leaving the caller to
   * fall back to referencing the file by path.
   */
  async postImage(channelId: string, content: string, filePath: string): Promise<string | null> {
    const messageId = await this.post(channelId, content, { files: [filePath], singleMessage: true });
    try {
      const client = this.client;
      if (!client) return null;
      const channel = await client.channels.fetch(channelId);
      const messages = (channel as { messages?: { fetch: (id: string) => Promise<Message> } } | null)?.messages;
      if (!messages) return null;
      const msg = await messages.fetch(messageId);
      return msg.attachments.first()?.url ?? null;
    } catch {
      return null;
    }
  }

  /**
   * PATCH an existing message. Offline/transient edits are retained as one latest-only value per
   * message for reconnect, but reject immediately with a typed transient error so a periodic
   * caller never hangs across a gateway blip. Deleted messages and permission failures are typed
   * separately so the caller can repost or stop retrying respectively.
   */
  async editMessage(
    channelId: string,
    messageId: string,
    payload: DiscordMessageEditPayload,
  ): Promise<void> {
    if (!hasEditFields(payload)) {
      throw new DiscordMessageEditError(
        "failed",
        channelId,
        messageId,
        "discord message edit needs content and/or embeds",
      );
    }

    if (!this.connected || !this.client) {
      this.enqueueEdit(channelId, messageId, payload);
      throw new DiscordTransientMessageEditError(
        channelId,
        messageId,
        "discord gateway is offline; edit queued for reconnect",
      );
    }

    const retryAt = this.editRetryAt.get(channelId);
    if (retryAt && retryAt > Date.now()) {
      this.enqueueEdit(channelId, messageId, payload);
      throw new DiscordTransientMessageEditError(
        channelId,
        messageId,
        "discord edit is rate limited; edit queued for retry",
        retryAt - Date.now(),
      );
    }
    if (retryAt) this.editRetryAt.delete(channelId);

    // If a reconnect/rate-limit retry is already pending, replace it before the live PATCH so
    // a late flush can never overwrite this newer update with its old payload.
    const key = editKey(channelId, messageId);
    const pending = this.queuedEdits.has(key) ? { channelId, messageId, payload } : undefined;
    if (pending) this.queuedEdits.set(key, pending);
    try {
      await this.editNow(channelId, messageId, payload);
      if (pending && this.queuedEdits.get(key) === pending) this.queuedEdits.delete(key);
    } catch (error) {
      const typed = this.toEditError(channelId, messageId, error);
      if (typed instanceof DiscordTransientMessageEditError) {
        this.enqueueEdit(channelId, messageId, payload, typed.retryAfterMs);
      } else if (pending && this.queuedEdits.get(key) === pending) {
        this.queuedEdits.delete(key);
      }
      throw typed;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`discord channel ${channelId} is not text based`);
    try {
      const message = await channel.messages.fetch(messageId);
      await message.delete();
    } catch (error) {
      if ((error as { code?: unknown }).code !== 10_008) throw error;
    }
    this.ownMessageIds.delete(messageId);
    this.browserQuestionMessageIds.delete(messageId);
  }

  /**
   * Return the author id of a message, or null if it no longer exists. The `beckett discord
   * delete` verb (issue #35) uses this to enforce the one guardrail that matters — only ever
   * delete a message Beckett itself authored — by comparing against {@link botUserId} BEFORE it
   * calls {@link deleteMessage}. A vanished message (Unknown Message / 10008) resolves to null so
   * the caller can report "already gone" distinctly from "not mine".
   */
  async fetchMessageAuthorId(channelId: string, messageId: string): Promise<string | null> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`discord channel ${channelId} is not text based`);
    try {
      const message = await channel.messages.fetch(messageId);
      return message.author?.id ?? null;
    } catch (error) {
      if ((error as { code?: unknown }).code === 10_008) return null; // Unknown Message — already gone
      throw error;
    }
  }

  /** Beckett's own Discord user id once connected (undefined before login). The Concierge asks the
   *  gateway rather than tracking it, since only the live client knows the bot's identity. */
  botUserId(): string | undefined {
    return this.client?.user?.id;
  }

  /**
   * The live discord.js {@link Client}, exposed narrowly so the voice transport (#81) can build a
   * `@discordjs/voice` connection off the SAME gateway connection (a bot has one WebSocket; voice
   * rides its guild adapter). Undefined before {@link start}. Not part of the frozen
   * {@link DiscordGateway} contract — voice is an additive capability, not a text-surface change.
   */
  discordClient(): Client | undefined {
    return this.client;
  }

  /** Create a dedicated task thread, or adopt/rename the current thread when already inside one. */
  async createTaskThread(channelId: string, requestedName: string): Promise<TaskThreadCreated> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");
    const name = taskThreadName(requestedName);
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`discord channel ${channelId} was not found`);

    if (channel.isThread()) {
      await channel.setName(name, "Beckett task workspace");
      return { threadId: channel.id, parentChannelId: channel.parentId ?? channel.id, name };
    }
    if (channel.type !== ChannelType.GuildText) {
      throw new Error("tasks can only create workspaces in a server text channel or existing thread");
    }
    const thread = await channel.threads.create({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "Beckett task workspace",
    });
    return { threadId: thread.id, parentChannelId: channel.id, name: thread.name };
  }

  /**
   * Register the handler for threads people create. Numbered task threads are created through
   * {@link createTaskThread} and registered directly, while the worker firehose remains private.
   * A later call replaces the handler.
   */
  onThreadCreate(cb: (t: ThreadCreated) => void | Promise<void>): void {
    if (this.threadHandler) this.logger.warn("discord onThreadCreate handler replaced");
    this.threadHandler = cb;
  }

  /** Register the single versioned component router owned by the Concierge. */
  onInteraction(cb: (i: DiscordComponentInteraction) => void | Promise<void>): void {
    if (this.interactionHandler) this.logger.warn("discord interaction handler replaced");
    this.interactionHandler = cb;
  }

  /**
   * Join a thread so Beckett stays a member of it: Discord keeps delivering to members, an
   * archived thread unarchives when a member posts, and the thread stops silently falling out of
   * our view after the archive window. Idempotent — `joined` is checked first so a re-surfaced
   * thread does not burn a rate-limited REST call.
   *
   * NEVER throws into the caller. Every call site is an event handler or a background attach, and
   * a private thread, a deleted thread, or a guild where we lack access is an ordinary Tuesday,
   * not a reason to kill the gateway: Missing Access (50001) and Unknown Channel (10003) are
   * expected and land at debug, anything else warns and is still swallowed.
   */
  async joinThread(threadId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const channel = await client.channels.fetch(threadId);
      // Not a thread (or unresolvable): nothing to join, and joining a text channel is meaningless.
      if (!channel?.isThread()) return;
      if (channel.joined) return;
      await channel.join();
      this.logger.info("discord thread joined", { threadId });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 50_001 || code === 10_003) {
        this.logger.debug("discord thread join skipped", { threadId, code });
        return;
      }
      this.logger.warn("discord thread join failed", { threadId, error: String(error) });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastEventAgeMs(): number | null {
    return this.lastEventTs === null ? null : Date.now() - this.lastEventTs;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  /** Attach the gateway lifecycle + message listeners (Spec 05 §1.2). */
  private wireListeners(client: Client): void {
    client.on(Events.MessageCreate, (msg) => {
      this.lastEventTs = Date.now();
      // Loop guard: never react to bots, including ourselves (Spec 05 §2.2 / §9.2). This MUST come
      // before any logging — otherwise the Discord log-mirror's own posts get re-logged and amplify
      // into a feedback loop. Federation exemption: a *trusted peer* Beckett (config
      // `federation.peers`) is let through so sibling Becketts can address each other — but never
      // ourselves, and never past the per-channel burst backstop (federation.ts).
      if (msg.author.bot) {
        if (!isFederatedPeer(msg.author.id, this.client?.user?.id, this.effectivePeers())) return;
        if (!this.peerBurst.allow(msg.channelId)) {
          this.logger.warn("discord peer message dropped — channel burst cap", {
            peerId: msg.author.id,
            channelId: msg.channelId,
          });
          return;
        }
        this.logger.info("discord peer message accepted", {
          peerId: msg.author.id,
          peer: msg.author.username,
          channelId: msg.channelId,
        });
      }
      // Observability: record every inbound (non-bot) message to confirm gateway receipt + intent.
      this.logger.info("discord message received", {
        author: msg.author.username,
        channelId: msg.channelId,
        len: msg.content.length,
        mentionsBot: client.user ? msg.mentions.has(client.user.id) : undefined,
      });
      // Isolate handler failures — a thrown intake/route must never kill the gateway.
      void Promise.resolve()
        .then(async () => {
          const m = await this.normalize(msg);
          const handler = this.handler;
          if (!handler) return;
          await handler(m);
        })
        .catch((err) =>
          this.logger.error("discord onMessage handler threw", {
            messageId: msg.id,
            error: String(err),
          }),
        );
    });

    // Components are interactions, not slash commands: Guilds is sufficient, so no OAuth scope
    // or bot re-invite is needed. Acknowledge first, before routing or any disk/network work, to
    // meet Discord's three-second interaction deadline. All outcomes are ephemeral by design.
    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
      this.lastEventTs = Date.now();
      void Promise.resolve()
        .then(async () => {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = interaction.channel;
          const normalized: DiscordComponentInteraction = {
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            isThread: channel?.isThread() === true,
            ...(channel?.isThread() && channel.parentId ? { parentChannelId: channel.parentId } : {}),
            ...(channel && "name" in channel && typeof channel.name === "string" ? { channelName: channel.name } : {}),
            editReply: async (content) => { await interaction.editReply({ content }); },
          };
          const handler = this.interactionHandler;
          if (!handler) {
            await normalized.editReply("That control is not available right now.");
            return;
          }
          await handler(normalized);
        })
        .catch(async (err) => {
          this.logger.error("discord interaction handler threw", {
            interactionId: interaction.id,
            error: String(err),
          });
          // deferReply can itself fail (expired/deleted interaction); only edit when it succeeded.
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "That action could not be completed." }).catch(() => undefined);
          }
        });
    });

    // A person's thread SURFACED → a workspace candidate. We deliberately no longer drop
    // `newlyCreated === false`: that is exactly the event Discord fires when the bot is merely
    // ADDED to a thread that already existed, which is the only signal we ever get for a thread
    // that predates the daemon or that someone invites Beckett into later. Dropping it made those
    // threads invisible forever, so both cases are delivered and tagged with `newlyCreated` for
    // the Concierge to log the difference. The remaining guards stand: the ownerId check filters
    // the bot's own threads (it should never create any — belt and braces) so a workspace can only
    // originate from a human decision, and a thread with no parentId is not a channel workspace.
    client.on(Events.ThreadCreate, (thread, newlyCreated) => {
      this.lastEventTs = Date.now();
      const creatorId = thread.ownerId ?? undefined;
      if (!creatorId || creatorId === this.client?.user?.id) return;
      if (!thread.parentId) return;
      const t: ThreadCreated = {
        threadId: thread.id,
        parentChannelId: thread.parentId,
        name: thread.name,
        creatorId,
        newlyCreated: newlyCreated === true,
      };
      this.logger.info("discord user thread surfaced", t as unknown as Record<string, unknown>);
      // NOTE: joining is deliberately NOT done here. The gateway cannot see the access list, so
      // joining on the raw event made Beckett a member of every thread anyone could open — including
      // an outsider's — before the Concierge had gated it. Joining is now the Concierge's call,
      // taken after the access check, at the moment it decides the thread is a real workspace.
      // Isolate handler failures — a thrown registration must never kill the gateway.
      void Promise.resolve()
        .then(() => this.threadHandler?.(t))
        .catch((err) =>
          this.logger.error("discord onThreadCreate handler threw", {
            threadId: thread.id,
            error: String(err),
          }),
        );
    });

    // discord.js owns reconnect/backoff + RESUME-vs-IDENTIFY; we observe for diagnostics
    // and to drive the outbound flush (Spec 05 §1.2).
    client.on(Events.ShardDisconnect, (e, id) => {
      this.connected = false;
      this.logger.warn("discord shard disconnected", { shard: id, code: e.code });
    });
    client.on(Events.ShardReconnecting, (id) => {
      this.logger.warn("discord shard reconnecting", { shard: id });
    });
    client.on(Events.ShardResume, (id, replayed) => {
      this.connected = true;
      this.lastEventTs = Date.now();
      this.logger.info("discord shard RESUMEd", { shard: id, replayedEvents: replayed });
      void this.flushOutbound();
      void this.flushQueuedEdits();
    });
    client.on(Events.ShardReady, (id) => {
      // Re-IDENTIFY after an invalidated session: the gap is NOT replayed (Spec 05 §1.2);
      // downtime mention reconciliation is the loop's job. We just resume posting.
      this.connected = true;
      this.lastEventTs = Date.now();
      void this.flushOutbound();
      void this.flushQueuedEdits();
    });
    client.on(Events.Error, (err) => {
      this.logger.error("discord client error", { error: String(err) });
    });
  }

  /** Normalize a raw discord.js message into the contract's {@link IncomingMessage}. */
  private async normalize(msg: Message): Promise<IncomingMessage> {
    const botId = this.client?.user?.id;
    const isDM = msg.guildId === null;
    // A DM addressed to the bot is an address even without an explicit @mention (Spec 05
    // §1.1 — the DM IS the channel). In guilds, count a direct @mention OR a native reply to one
    // of Beckett's messages (the reply-ping lands in `repliedUser`, which `.users.has()` MISSES —
    // that bug silently dropped every reply-style mention). `ignoreEveryone` avoids @everyone noise.
    const directMention = botId ? msg.mentions.has(botId, { ignoreEveryone: true }) : false;
    const reference = botId
      ? await this.referenceInfo(msg, botId)
      : { toBot: false, browserQuestion: false, unverified: false };
    // The human-friendly name to address the speaker by: guild nickname first (what the server
    // calls them), then their global display name, then the raw username. Threaded through so
    // each turn knows WHO is talking, not just which channel (OPS-42).
    const displayName =
      msg.member?.displayName || msg.author.globalName || msg.author.username || undefined;
    return {
      messageId: msg.id,
      userId: msg.author.id,
      authorDisplayName: displayName,
      roleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
      channelId: msg.channelId,
      // Guild channels carry a name ("media"); DM channels don't have one — the shared-context
      // store keys server-wide awareness/search off exactly this distinction.
      channelName: (msg.channel as { name?: string | null } | null)?.name ?? undefined,
      // Thread awareness straight off the live channel. Beckett used to learn "this is a thread"
      // ONLY by finding the channel in the workspace registry, which meant a thread it was added
      // to late — or one that predates the daemon — looked exactly like a top-level channel. The
      // registry is now an enrichment, not the source of truth.
      ...threadInfo(msg),
      guildId: msg.guildId ?? null,
      content: msg.content,
      repliedToId: msg.reference?.messageId ?? null,
      ...(reference.browserQuestion ? { repliedToBrowserQuestion: true } : {}),
      ...(reference.unverified ? { repliedToBotUnverified: true } : {}),
      mentionsBot: isDM || directMention || reference.toBot,
      authorIsBot: msg.author.bot,
      createdAt: msg.createdTimestamp,
      // Every file dragged into the message (images, txt, pdf, md, anything). The shell
      // downloads these locally so the parent can Read them; the gateway just captures the
      // refs (Spec 05 §2.1 extended). `.contentType` is null for some uploads — keep as-is.
      attachments: [...msg.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url,
        contentType: a.contentType ?? null,
        size: a.size,
      })),
      // Discord forwards leave `content` empty (or hold only the forwarder's comment) and put
      // the original in this collection. Normalize it rather than passing discord.js objects past
      // the gateway; the Concierge labels it as quoted material before the model sees it.
      forwardedSnapshots: [...msg.messageSnapshots.values()].map((snapshot) => ({
        content: snapshot.content,
        attachments: [...snapshot.attachments.values()].map((a) => ({
          id: a.id,
          name: a.name,
          url: a.url,
          contentType: a.contentType ?? null,
          size: a.size,
        })),
        embeds: snapshot.embeds.map((embed) => ({
          name: embed.title ?? embed.author?.name ?? embed.provider?.name ?? "embed",
          urls: [...new Set([embed.url, embed.image?.url, embed.thumbnail?.url, embed.video?.url].filter(
            (url): url is string => Boolean(url),
          ))],
        })),
      })),
    };
  }

  private async referenceInfo(
    msg: Message,
    botId: string,
  ): Promise<{ toBot: boolean; browserQuestion: boolean; unverified: boolean }> {
    const refId = msg.reference?.messageId;
    if (!refId) return { toBot: false, browserQuestion: false, unverified: false };
    if (this.browserQuestionMessageIds.has(refId)) {
      return { toBot: true, browserQuestion: true, unverified: false };
    }
    if (this.ownMessageIds.has(refId)) return { toBot: true, browserQuestion: false, unverified: false };
    const repliedUser = (msg.mentions as { repliedUser?: { id?: string } }).repliedUser;
    try {
      const ref = await msg.fetchReference();
      const toBot = ref.author.id === botId;
      return {
        toBot,
        browserQuestion: toBot && isBrowserQuestionMessage(
          ref.content,
          [...ref.attachments.values()].map((attachment) => attachment.name),
        ),
        unverified: false,
      };
    } catch {
      const toBot = repliedUser?.id === botId;
      return { toBot, browserQuestion: false, unverified: toBot };
    }
  }

  /**
   * Trigger the "Beckett is typing…" indicator in a channel. Discord shows it for ~10s, so the
   * caller re-invokes on an interval to keep it alive while Beckett is thinking (Risk: the user
   * should see something is coming). Best-effort: never throws (a typing failure must not break
   * anything).
   */
  async sendTyping(channelId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isSendable()) {
        await (channel as { sendTyping: () => Promise<unknown> }).sendTyping();
      }
    } catch {
      /* typing is cosmetic — swallow */
    }
  }

  /** Send now; ordinary posts may split, while `singleMessage` posts reject instead. */
  private async sendNow(
    channelId: string,
    content: string,
    opts?: ReplyOptions,
  ): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");

    // This is the last common boundary before discord.js. Keep this here, rather than relying on
    // callers, so turns, acks, ticket updates, and queued posts get the same protection.
    content = this.redactOutboundText(channelId, "content", content);
    opts = this.redactOutboundOptions(channelId, opts);

    if (opts?.singleMessage) {
      if (content.length > DISCORD_MAX_CHARS) {
        throw new Error(`single-message Discord post exceeds ${DISCORD_MAX_CHARS} characters`);
      }
    }
    if (opts?.browserQuestion && (!opts.singleMessage || opts.files?.length !== 1)) {
      throw new Error("browser questions require one atomic Discord message with one screenshot");
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`discord channel ${channelId} is not a sendable text channel`);
    }

    // Validate file paths exist before building payload
    if (opts?.files && opts.files.length > 0) {
      const { existsSync } = await import("node:fs");
      for (const filePath of opts.files) {
        if (!existsSync(filePath)) {
          throw new Error(`attachment file not found: ${filePath}`);
        }
      }
    }

    // Two-stage split: first into natural, human-cadence sections (OPS-62 — paragraph/sentence
    // boundaries, code fences kept whole; a short reply stays ONE section, unchanged), then each
    // section into hard 2000-char pieces Discord will actually accept. `chunkReply` is the sole
    // outgoing text shaper; the hard 2000-char split still guards every section.
    const sections = opts?.singleMessage ? (content ? [content] : []) : chunkReply(content);
    const chunks = opts?.singleMessage ? [...sections] : sections.flatMap((section) => splitDiscordContent(section));
    if (
      chunks.length === 0 &&
      (!opts?.files || opts.files.length === 0) &&
      (!opts?.embeds || opts.embeds.length === 0) &&
      (!opts?.buttons || opts.buttons.length === 0)
    ) {
      throw new Error("discord post needs text, files, an embed, or a component");
    }
    if (chunks.length === 0) chunks.push("");

    // Inter-message delays make several messages read as a person typing, not one API dump. A flat
    // random 2–4s pause between consecutive bubbles (OPS-84) — the first sends immediately — with a
    // total budget so a pathological many-chunk reply can't take forever.
    const gaps = opts?.singleMessage ? [] : delaySchedule(chunks.length);
    let capped = false;

    let firstId: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        const gap = gaps[i - 1] ?? 0;
        if (gap > 0) {
          // Keep the "typing…" indicator alive across the pause so the wait reads as composing.
          void this.sendTyping(channelId);
          await new Promise((r) => setTimeout(r, gap));
        } else if (!capped) {
          capped = true;
          this.logger.info("discord humanized-delay budget reached; posting remainder promptly", {
            channelId,
            messages: chunks.length,
            budgetMs: TOTAL_DELAY_BUDGET_MS,
          });
        }
      }
      const replyUserId = i === 0 ? discordUserId(opts?.replyToUserId) : undefined;
      // A native reply already notifies its author. Strip a model-authored duplicate mention so
      // the same person never gets both an explicit ping and the reply notification.
      const messageContent = replyUserId ? stripUserMention(chunks[i]!, replyUserId) : chunks[i]!;
      const payload: MessageCreateOptions = messageContent ? { content: messageContent } : {};
      // Every outgoing message disables Discord's implicit parsing. A direct reply opts back into
      // exactly its author's native-reply notification — never roles, @here, @everyone, or another
      // user named in model text. If the author id is unavailable, the reply stays visually native
      // but deliberately sends no notification.
      payload.allowedMentions = replyUserId
        ? { parse: [], users: [replyUserId], repliedUser: true }
        : { parse: [] };
      if (i === 0 && opts?.replyToMessageId) {
        // Native reply-to: visual threading without threads + the strong correlation key
        // (Spec 05 §4.2). failIfNotExists=false so a deleted ask doesn't reject the post.
        payload.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
      }
      if (i === 0 && opts?.files && opts.files.length > 0) {
        payload.files = opts.files.map((path) => new AttachmentBuilder(
          path,
          opts.browserQuestion ? { name: BROWSER_QUESTION_ATTACHMENT_NAME } : undefined,
        ));
      }
      if (i === 0 && opts?.embeds?.length) payload.embeds = opts.embeds.map((embed) => new EmbedBuilder(embed));
      if (i === 0 && opts?.buttons?.length) payload.components = [buildButtonRow(opts.buttons)];

      const sent = await channel.send(payload);
      this.ownMessageIds.add(sent.id);
      if (i === 0 && opts?.browserQuestion) this.browserQuestionMessageIds.add(sent.id);
      firstId ??= sent.id;
    }
    this.lastEventTs = Date.now();
    // The FIRST message id is the reply-correlation anchor (Spec 05 §4.1): it carries the native
    // reply-to + any file attachments, so returning it keeps the messageId contract intact even
    // when a long reply lands as several messages.
    return firstId!;
  }

  /** PATCH through discord.js's REST route after fetching the target message. */
  private async editNow(
    channelId: string,
    messageId: string,
    payload: DiscordMessageEditPayload,
  ): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`discord channel ${channelId} is not a text channel`);
    }
    const message = await channel.messages.fetch(messageId);
    const edit: MessageEditOptions = { allowedMentions: { parse: [] } };
    if (payload.content !== undefined) {
      edit.content = this.redactOutboundText(channelId, "edit.content", payload.content);
    }
    if (payload.embeds !== undefined) {
      edit.embeds = this.redactEmbeds(channelId, payload.embeds).map((embed) => new EmbedBuilder(embed));
    }
    await message.edit(edit);
    this.lastEventTs = Date.now();
  }

  /** Remove URLs that recipients cannot use before they cross the public Discord boundary. */
  private redactOutboundText(channelId: string, location: string, content: string): string {
    return redactUnsafeDiscordUrls(content, (host) => {
      this.logger.warn("redacted internal URL from outbound discord message", { channelId, location, host });
    });
  }

  private redactEmbeds(channelId: string, embeds: NonNullable<ReplyOptions["embeds"]>) {
    return embeds.map((embed) => {
      const safe = {
        ...embed,
        title: embed.title === undefined ? undefined : this.redactOutboundText(channelId, "embed.title", embed.title),
        description: embed.description === undefined
          ? undefined
          : this.redactOutboundText(channelId, "embed.description", embed.description),
        footer: embed.footer === undefined
          ? undefined
          : { ...embed.footer, text: this.redactOutboundText(channelId, "embed.footer", embed.footer.text) },
        fields: embed.fields?.map((field) => ({
          ...field,
          name: this.redactOutboundText(channelId, "embed.field.name", field.name),
          value: this.redactOutboundText(channelId, "embed.field.value", field.value),
        })),
      };
      if (embed.url && isUnsafeDiscordUrl(embed.url)) {
        this.logger.warn("redacted internal URL from outbound discord message", {
          channelId,
          location: "embed.url",
          host: new URL(embed.url).hostname,
        });
        delete safe.url;
      }
      return safe;
    });
  }

  private redactOutboundOptions(channelId: string, opts: ReplyOptions | undefined): ReplyOptions | undefined {
    if (!opts) return opts;
    return {
      ...opts,
      embeds: opts.embeds === undefined ? undefined : this.redactEmbeds(channelId, opts.embeds),
      buttons: opts.buttons?.flatMap((button) => {
        if (!("url" in button) || !isUnsafeDiscordUrl(button.url)) return [button];
        this.logger.warn("redacted internal URL from outbound discord message", {
          channelId,
          location: "button.url",
          host: new URL(button.url).hostname,
        });
        return [];
      }),
    };
  }

  /** Store the current value only: reconnect must never replay a stale progress history. */
  private enqueueEdit(
    channelId: string,
    messageId: string,
    payload: DiscordMessageEditPayload,
    retryAfterMs?: number,
  ): void {
    const key = editKey(channelId, messageId);
    this.queuedEdits.set(key, { channelId, messageId, payload });
    this.logger.warn("discord edit deferred", {
      channelId,
      messageId,
      queueDepth: this.queuedEdits.size,
      retryAfterMs,
    });
    if (retryAfterMs !== undefined) this.applyEditCooldown(channelId, retryAfterMs);
  }

  /** Run the one queued edit for each message once the gateway reconnects or a 429 expires. */
  private async flushQueuedEdits(): Promise<void> {
    if (this.flushingEdits || !this.connected || !this.client || this.queuedEdits.size === 0) return;
    this.flushingEdits = true;
    try {
      for (const [key, item] of [...this.queuedEdits]) {
        // A concurrent update replaced this snapshot; it will be handled by its newer value.
        if (this.queuedEdits.get(key) !== item) continue;
        if (!this.connected || !this.client) return;

        const retryAt = this.editRetryAt.get(item.channelId);
        if (retryAt && retryAt > Date.now()) {
          this.scheduleEditFlush(item.channelId, retryAt);
          continue;
        }
        if (retryAt) this.editRetryAt.delete(item.channelId);

        try {
          await this.editNow(item.channelId, item.messageId, item.payload);
          // Do not erase a newer edit that arrived while the PATCH was in flight.
          if (this.queuedEdits.get(key) === item) this.queuedEdits.delete(key);
        } catch (error) {
          const typed = this.toEditError(item.channelId, item.messageId, error);
          if (typed instanceof DiscordTransientMessageEditError) {
            // Keep this latest value for the next reconnect/tick. A concurrent caller may have
            // replaced it while this PATCH was in flight; never put this older payload back.
            if (this.queuedEdits.get(key) === item) {
              this.enqueueEdit(item.channelId, item.messageId, item.payload, typed.retryAfterMs);
            } else if (typed.retryAfterMs !== undefined) {
              this.applyEditCooldown(item.channelId, typed.retryAfterMs);
            }
            if (!this.connected) return;
          } else {
            // A deleted target or permissions problem cannot be fixed by replaying this edit.
            if (this.queuedEdits.get(key) === item) this.queuedEdits.delete(key);
            this.logger.warn("dropping queued discord edit", {
              channelId: item.channelId,
              messageId: item.messageId,
              kind: typed.kind,
              error: String(typed),
            });
          }
        }
      }
    } finally {
      this.flushingEdits = false;
    }
  }

  /** Record Discord's per-channel rate-limit boundary and arrange delivery at that boundary. */
  private applyEditCooldown(channelId: string, retryAfterMs: number): void {
    const retryAt = Date.now() + retryAfterMs;
    const previous = this.editRetryAt.get(channelId) ?? 0;
    const nextRetryAt = Math.max(previous, retryAt);
    this.editRetryAt.set(channelId, nextRetryAt);
    this.scheduleEditFlush(channelId, nextRetryAt);
  }

  /** Arrange a single retry at Discord's advertised rate-limit boundary. */
  private scheduleEditFlush(channelId: string, retryAt: number): void {
    const oldTimer = this.editFlushTimers.get(channelId);
    if (oldTimer) clearTimeout(oldTimer);
    const waitMs = Math.max(0, retryAt - Date.now());
    const timer = setTimeout(() => {
      this.editFlushTimers.delete(channelId);
      void this.flushQueuedEdits();
    }, waitMs);
    // The timer merely improves eventual delivery; it must not keep a cleanly stopped daemon alive.
    timer.unref?.();
    this.editFlushTimers.set(channelId, timer);
  }

  /** Convert all discord.js/REST failures into a branchable edit error. */
  private toEditError(channelId: string, messageId: string, error: unknown): DiscordMessageEditError {
    if (error instanceof DiscordMessageEditError) return error;
    const details = (error !== null && typeof error === "object" ? error : {}) as {
      code?: unknown;
      status?: unknown;
      retry_after?: unknown;
      rawError?: { code?: unknown; retry_after?: unknown };
      data?: { retry_after?: unknown };
    };
    const code = numericDiscordError(details.code ?? details.rawError?.code);
    const status = numericDiscordError(details.status);
    const retryAfterMs = discordRetryAfterMs(
      details.retry_after ?? details.rawError?.retry_after ?? details.data?.retry_after,
    );
    const options = { cause: error };

    // Discord uses code 10008 for Unknown Message. HTTP 404 is likewise the message endpoint's
    // deleted/missing target outcome and intentionally maps to the repost path.
    if (code === 10_008 || status === 404) {
      return new DiscordUnknownMessageError(channelId, messageId, options);
    }
    // Missing Permissions is 50013; a raw 403 is the equivalent REST response.
    if (code === 50_013 || status === 403) {
      return new DiscordMessageEditPermissionError(channelId, messageId, options);
    }
    if (
      !this.connected ||
      !this.client ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      isTransientTransportError(error)
    ) {
      return new DiscordTransientMessageEditError(
        channelId,
        messageId,
        status === 429 ? "discord edit rate limited" : "discord edit temporarily unavailable",
        status === 429 ? retryAfterMs ?? 1_000 : undefined,
        options,
      );
    }
    return new DiscordMessageEditError(
      "failed",
      channelId,
      messageId,
      "discord message edit failed",
      options,
    );
  }

  /** Buffer a post until reconnect; the promise resolves with the real id when it lands. */
  private enqueue(channelId: string, content: string, opts?: ReplyOptions): Promise<string> {
    this.logger.warn("discord gateway down; queueing post for reconnect", {
      channelId,
      queueDepth: this.outbound.length + 1,
    });
    return new Promise<string>((resolve, reject) => {
      this.outbound.push({ channelId, content, opts, resolve, reject });
    });
  }

  /** Flush buffered posts in order on reconnect (Spec 01 §6 — no delivery is lost). */
  private async flushOutbound(): Promise<void> {
    if (this.outbound.length === 0) return;
    const pending = this.outbound.splice(0);
    this.logger.info("flushing queued discord posts", { count: pending.length });
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i]!;
      try {
        const id = await this.sendNow(item.channelId, item.content, item.opts);
        item.resolve(id);
      } catch (err) {
        if (!this.connected) {
          // Dropped again mid-flush: requeue this + the remainder for the next reconnect.
          this.outbound.unshift(...pending.slice(i));
          this.logger.warn("gateway dropped mid-flush; re-queued remaining posts", {
            remaining: pending.length - i,
          });
          return;
        }
        // Connected but this specific post is unsendable (bad channel/perms) — reject it
        // so the loop can surface via the CLI (Spec 04 T19), and continue the rest.
        this.logger.warn("dropping unsendable queued post", {
          channelId: item.channelId,
          error: String(err),
        });
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

}

/**
 * Best-effort thread classification for an inbound message.
 *
 * discord.js hands us a full channel object most of the time, but not always: DM channels arrive
 * as partials (`Partials.Channel`), an uncached channel can be a bare stub, and injected test
 * fakes carry only the fields their test needs. An inbound human message is far too valuable to
 * drop over a missing method, so anything unexpected degrades to `{}` — both fields undefined,
 * meaning "unknown" — rather than throwing out of `normalize` and losing the whole message.
 * `isThread: false` is therefore a positive answer, distinct from an absent one.
 */
function threadInfo(msg: Message): { isThread?: boolean; parentChannelId?: string } {
  try {
    const channel = msg.channel as unknown as
      | { isThread?: () => boolean; parentId?: string | null }
      | null
      | undefined;
    if (!channel || typeof channel.isThread !== "function") return {};
    if (!channel.isThread()) return { isThread: false };
    // A thread always has a parent in practice; keep the field absent rather than inventing one.
    const parentChannelId = channel.parentId ?? undefined;
    return parentChannelId ? { isThread: true, parentChannelId } : { isThread: true };
  } catch {
    return {};
  }
}

/** Split Discord content without truncating, preferring paragraph/newline/word boundaries. */
export function splitDiscordContent(content: string, limit = DISCORD_MAX_CHARS): string[] {
  if (content.length === 0) return [];
  const chunks: string[] = [];
  let rest = content;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = window.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit * 0.4)) cut = window.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.4)) cut = window.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Only a real Discord snowflake may become an allowed-mentions user whitelist entry. */
function discordUserId(value: string | undefined): string | undefined {
  return value && /^\d{1,20}$/.test(value) ? value : undefined;
}

/** Avoid a redundant explicit ping when Discord's native reply already notifies this user. */
function stripUserMention(content: string, userId: string): string {
  const stripped = content.replace(new RegExp(`<@!?${userId}>`, "g"), "").replace(/ {2,}/g, " ").trim();
  // Discord rejects an entirely empty text message. Keep the reply deliverable if a model emitted
  // only the redundant mention, without restoring a second notification.
  return stripped || "\u200b";
}

/** URLs are deliberately recognized only in outbound Discord text, not as a general content filter. */
const DISCORD_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'(){}]+/gi;

function redactUnsafeDiscordUrls(content: string, onRedaction: (host: string) => void): string {
  return content.replace(DISCORD_URL, (candidate) => {
    // Keep sentence punctuation outside the replacement; URL pathname/query punctuation is
    // immaterial once the unusable link is removed.
    const punctuation = candidate.match(/[.,!?;:]+$/)?.[0] ?? "";
    const url = candidate.slice(0, candidate.length - punctuation.length);
    if (!isUnsafeDiscordUrl(url)) return candidate;
    onRedaction(new URL(url).hostname);
    return `[internal link removed]${punctuation}`;
  });
}

/**
 * Whether an outbound Discord URL is unsafe to post — a host recipients cannot reach. The
 * classification now lives in the shared {@link isInternalUrl} (`src/net/url-safety.ts`) so the
 * preview feature strips the exact same hosts this boundary redacts; the alias keeps the local
 * call sites (and the redaction characterization suite) byte-identical.
 */
const isUnsafeDiscordUrl = isInternalUrl;

/** Discord channel/thread names are 1-100 characters. Keep task names stable and single-line. */
export function taskThreadName(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("task thread name cannot be empty");
  return [...clean].slice(0, 100).join("");
}

/** A collision-free identity for the latest queued edit of one Discord message. */
function editKey(channelId: string, messageId: string): string {
  return `${channelId}\u0000${messageId}`;
}

function hasEditFields(payload: unknown): payload is DiscordMessageEditPayload {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (Object.hasOwn(payload, "content") || Object.hasOwn(payload, "embeds"))
  );
}

function numericDiscordError(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Discord's JSON retry_after is seconds; normalize it to a non-negative millisecond delay. */
function discordRetryAfterMs(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}

/** Network failures often arrive before the shard listener has marked us disconnected. */
function isTransientTransportError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && [
    "ECONNABORTED",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETDOWN",
    "ENETUNREACH",
    "ETIMEDOUT",
  ].includes(code);
}

function buildButtonRow(buttons: NonNullable<ReplyOptions["buttons"]>): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.slice(0, 5).map((button) => {
      const built = new ButtonBuilder().setLabel(button.label.slice(0, 80));
      if ("url" in button) return built.setStyle(ButtonStyle.Link).setURL(button.url);
      return built
        .setStyle(button.danger ? ButtonStyle.Danger : ButtonStyle.Primary)
        .setCustomId(button.customId);
    }),
  );
}

/** Factory: build a {@link DiscordGateway} from options (the daemon wires the impl). */
export function createDiscordGateway(opts: GatewayOptions = {}): DiscordGateway {
  return new DiscordJsGateway(opts);
}

/** Compile-time check: the class satisfies the frozen {@link DiscordGateway} contract. */
const _gatewayCheck: new (o?: GatewayOptions) => DiscordGateway = DiscordJsGateway;
void _gatewayCheck;

export type { DiscordGateway } from "../types.ts";
