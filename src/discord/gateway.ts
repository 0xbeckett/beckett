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
 *    completes and is simply delivered late.
 *  - **Sparseness is law** (Spec 05 §7): the gateway is a dumb pipe — it posts exactly what
 *    it's told. Deciding *whether* to speak (the five YES moments) lives in the loop/Brain.
 *  - **Loop guard**: bot-authored messages (incl. our own) are dropped before they reach the
 *    handler, preventing an ack-of-an-ack cascade (Spec 05 §2.2 / §9.2).
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type MessageCreateOptions,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type {
  DiscordGateway,
  DiscordCommand,
  DiscordCommandReply,
  IncomingMessage,
  ReplyContextMessage,
  ReplyOptions,
  TaskThreadCreated,
  ThreadCreated,
  Config,
  Logger,
} from "../types.ts";
import { log as rootLog } from "../log.ts";
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

/** Native command surface. Registration is additive: unrelated application commands survive. */
export const BECKETT_SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show remaining usage for connected AI subscriptions")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Create or inspect a Beckett task")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((command) =>
      command
        .setName("create")
        .setDescription("Create a numbered task and Discord workspace")
        .addStringOption((option) => option.setName("name").setDescription("Task name").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("show")
        .setDescription("Show a task summary")
        .addStringOption((option) => option.setName("number").setDescription("Task number, e.g. 42").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("workspace")
        .setDescription("Create or repair a task's Discord workspace")
        .addStringOption((option) => option.setName("number").setDescription("Task number, e.g. 42").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("branch")
    .setDescription("Show Git, checks, review, and discussion status for a task branch")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option.setName("reference").setDescription("Branch reference, e.g. 42.2").setRequired(true)),
] as const;

/** A post buffered while the gateway is down, flushed on reconnect (Spec 01 §6). */
interface QueuedPost {
  channelId: string;
  content: string;
  opts?: ReplyOptions;
  resolve: (messageId: string) => void;
  reject: (err: Error) => void;
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

  /** Native slash commands are handled outside the transport and return render-neutral cards. */
  private commandHandler: ((command: DiscordCommand) => Promise<DiscordCommandReply>) | undefined;

  /** Outbound posts buffered while disconnected (Spec 01 §6 — flushed on reconnect). */
  private readonly outbound: QueuedPost[] = [];
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

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds, // channel/role cache — required for everything
        GatewayIntentBits.GuildMessages, // receive messageCreate in guild channels
        GatewayIntentBits.MessageContent, // PRIVILEGED — without it message.content is empty (Risk-E)
        GatewayIntentBits.DirectMessages, // 1:1 DMs (still ambient — the DM is the channel)
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
        void this.syncSlashCommands(c).catch((err) =>
          this.logger.warn("discord slash-command registration failed; chat remains online", { error: String(err) })
        );
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

  onCommand(cb: (command: DiscordCommand) => Promise<DiscordCommandReply>): void {
    if (this.commandHandler) this.logger.warn("discord onCommand handler replaced");
    this.commandHandler = cb;
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

    // A person opened a thread → a workspace candidate. `newlyCreated` filters out the replayed
    // create Discord fires when the bot is merely ADDED to an existing thread; the ownerId check
    // filters the bot's own threads (it should never create any — belt and braces) so a workspace
    // can only originate from a human decision.
    client.on(Events.ThreadCreate, (thread, newlyCreated) => {
      this.lastEventTs = Date.now();
      if (!newlyCreated) return;
      const creatorId = thread.ownerId ?? undefined;
      if (!creatorId || creatorId === this.client?.user?.id) return;
      if (!thread.parentId) return;
      const t: ThreadCreated = {
        threadId: thread.id,
        parentChannelId: thread.parentId,
        name: thread.name,
        creatorId,
      };
      this.logger.info("discord user thread created", t as unknown as Record<string, unknown>);
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

    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (!BECKETT_SLASH_COMMANDS.some((command) => command.name === interaction.commandName)) return;
      void this.handleCommandInteraction(interaction).catch((err) =>
        this.logger.error("discord command handler threw", { command: interaction.commandName, error: String(err) })
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
    });
    client.on(Events.ShardReady, (id) => {
      // Re-IDENTIFY after an invalidated session: the gap is NOT replayed (Spec 05 §1.2);
      // downtime mention reconciliation is the loop's job. We just resume posting.
      this.connected = true;
      this.lastEventTs = Date.now();
      void this.flushOutbound();
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

  private async syncSlashCommands(client: Client<true>): Promise<void> {
    const application = client.application;
    if (!application) throw new Error("discord application metadata is unavailable");
    const existing = await application.commands.fetch();
    for (const builder of BECKETT_SLASH_COMMANDS) {
      const data = builder.toJSON();
      const command = existing.find((candidate) => candidate.name === data.name);
      if (command) await application.commands.edit(command.id, data);
      else await application.commands.create(data);
    }
    this.logger.info("discord slash commands synced", { commands: BECKETT_SLASH_COMMANDS.map((command) => command.name) });
  }

  private async handleCommandInteraction(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const handler = this.commandHandler;
    const ephemeral = interaction.commandName === "stats";
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    if (!handler) {
      await interaction.editReply({ content: "That command is not ready yet.", allowedMentions: { parse: [] } });
      return;
    }
    try {
      const subcommand = interaction.options.getSubcommand(false) ?? undefined;
      const command: DiscordCommand = {
        name: interaction.commandName as DiscordCommand["name"],
        ...(subcommand ? { subcommand } : {}),
        userId: interaction.user.id,
        channelId: interaction.channelId,
        options: flattenCommandOptions(interaction.options.data),
      };
      const reply = await handler(command);
      if (!reply.content && !reply.embeds?.length && !reply.buttons?.length) {
        throw new Error("command returned an empty reply");
      }
      await interaction.editReply({
        allowedMentions: { parse: [] },
        ...(reply.content ? { content: reply.content } : {}),
        ...(reply.embeds?.length ? { embeds: reply.embeds.map((embed) => new EmbedBuilder(embed)) } : {}),
        ...(reply.buttons?.length ? { components: [buildButtonRow(reply.buttons)] } : {}),
      });
    } catch (err) {
      this.logger.warn("discord slash command failed", { command: interaction.commandName, error: String(err) });
      await interaction.editReply({
        content: "I couldn't load that right now. The failure was logged.",
        allowedMentions: { parse: [] },
      });
    }
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

/** Discord channel/thread names are 1-100 characters. Keep task names stable and single-line. */
export function taskThreadName(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("task thread name cannot be empty");
  return [...clean].slice(0, 100).join("");
}

type CommandOptionData = { name: string; value?: unknown; options?: readonly CommandOptionData[] };

/** Flatten Discord's one-level subcommand option tree into the transport-neutral command map. */
export function flattenCommandOptions(data: readonly CommandOptionData[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const option of data) {
    if (typeof option.value === "string" || typeof option.value === "number" || typeof option.value === "boolean") {
      out[option.name] = option.value;
    }
    if (option.options) Object.assign(out, flattenCommandOptions(option.options));
  }
  return out;
}

function buildButtonRow(buttons: NonNullable<ReplyOptions["buttons"]>): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.slice(0, 5).map((button) =>
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(button.label.slice(0, 80)).setURL(button.url)
    ),
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
