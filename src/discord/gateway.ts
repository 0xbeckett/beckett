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
} from "discord.js";
import type {
  DiscordGateway,
  IncomingMessage,
  ReplyOptions,
  Config,
  Logger,
} from "../types.ts";
import { log as rootLog } from "../log.ts";
import { isFederatedPeer, PeerBurstLimiter } from "./federation.ts";
import { loadPeers } from "./peers.ts";
import { buildPaths } from "../paths.ts";
import { chunkReply, delaySchedule, TOTAL_DELAY_BUDGET_MS } from "./chunk.ts";
import { chillReply } from "./chill.ts";

/** Discord's hard per-message ceiling (Spec 05 §9.1). */
const DISCORD_MAX_CHARS = 2000;

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

  /** Outbound posts buffered while disconnected (Spec 01 §6 — flushed on reconnect). */
  private readonly outbound: QueuedPost[] = [];
  /** Message ids posted by this process, used to recognize native no-ping replies to Beckett. */
  private readonly ownMessageIds = new Set<string>();

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
        if (this.connected) throw err;
        this.logger.warn("post failed mid-disconnect; queueing for reconnect", {
          channelId,
          error: String(err),
        });
      }
    }
    return this.enqueue(channelId, content, opts);
  }

  /**
   * Open a public thread hanging off an existing message (Spec 05 exception: the ambient channel
   * stays sparse, but a filed ticket gets a collapsible progress thread anchored to its ack). Returns
   * the thread id — itself a sendable channel id, so {@link post} delivers into it. Unlike `post`,
   * this has NO queue-on-disconnect safety net: it needs a live client and the anchor message to
   * still exist, so it throws when either is missing and lets the caller (the progress hub) keep
   * buffering + retry on a later event. `autoArchiveDuration` is the max (1 week) so a long worker's
   * late events don't post into an already-archived thread.
   */
  async startThread(channelId: string, anchorMessageId: string, name: string): Promise<string> {
    const client = this.client;
    if (!this.connected || !client) {
      throw new Error("discord gateway not connected — cannot open thread yet");
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`discord channel ${channelId} cannot host a thread`);
    }
    // Fetch the anchor so the thread hangs off the exact ack message (not a standalone thread).
    const anchor = await (channel as { messages: { fetch: (id: string) => Promise<unknown> } }).messages.fetch(
      anchorMessageId,
    );
    const started = await (anchor as {
      startThread: (o: { name: string; autoArchiveDuration: number }) => Promise<{ id: string }>;
    }).startThread({ name: this.threadName(name), autoArchiveDuration: 10080 /* 1 week, the max */ });
    this.lastEventTs = Date.now();
    this.logger.info("discord progress thread opened", { channelId, anchorMessageId, threadId: started.id });
    return started.id;
  }

  /** Discord thread names cap at 100 chars — trim so a long ticket title never rejects the call. */
  private threadName(name: string): string {
    const trimmed = name.trim() || "beckett";
    return trimmed.length <= 100 ? trimmed : trimmed.slice(0, 99) + "…";
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
    const replyToBot = botId ? await this.referencesBot(msg, botId) : false;
    // The human-friendly name to address the speaker by: guild nickname first (what the server
    // calls them), then their global display name, then the raw username. Threaded through so
    // each turn knows WHO is talking, not just which channel (OPS-42).
    const displayName =
      msg.member?.displayName || msg.author.globalName || msg.author.username || undefined;
    return {
      messageId: msg.id,
      userId: msg.author.id,
      authorDisplayName: displayName,
      channelId: msg.channelId,
      guildId: msg.guildId ?? null,
      content: msg.content,
      repliedToId: msg.reference?.messageId ?? null,
      mentionsBot: isDM || directMention || replyToBot,
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

  private async referencesBot(msg: Message, botId: string): Promise<boolean> {
    const refId = msg.reference?.messageId;
    if (!refId) return false;
    if (this.ownMessageIds.has(refId)) return true;
    const repliedUser = (msg.mentions as { repliedUser?: { id?: string } }).repliedUser;
    if (repliedUser?.id === botId) return true;
    try {
      const ref = await msg.fetchReference();
      return ref.author.id === botId;
    } catch {
      return false;
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

  /** Actually send a message now; returns the first sent message id. Splits overlong content. */
  private async sendNow(
    channelId: string,
    content: string,
    opts?: ReplyOptions,
  ): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("discord gateway not started");

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

    // Chilltext compression (OPS-73): collapse the outgoing text into one short casual bubble
    // via the collector API — but ONLY when the caller opted in with `opts.chill` (the Concierge's
    // own conversational replies). Everything else — worker logs relayed into progress threads,
    // startup banners, fixed acks — must reach Discord verbatim, so the default is raw. On ANY
    // failure (unreachable, error, ~35s timeout, overlong text) `chillReply` returns null and the
    // ORIGINAL text flows through the existing two-stage split unchanged — a transform-in-the-middle
    // with a hard passthrough; no message is ever dropped. Only the text payload is touched:
    // reply-to, files, and targeting are applied below as before.
    const chilled = opts?.chill ? await chillReply(content) : null;
    if (opts?.chill && content.trim().length > 0) {
      // Log BOTH outcomes: silent success made "is chilltext even on?" undiagnosable from prod.
      if (chilled === null) {
        this.logger.info("chilltext unavailable or skipped; sending original text", { channelId });
      } else {
        this.logger.info("chilltext reformatted reply", {
          channelId,
          bubbles: chilled.length,
          rawChars: content.length,
        });
      }
    }
    // Two-stage split: first into natural, human-cadence sections (OPS-62 — paragraph/sentence
    // boundaries, code fences kept whole; a short reply stays ONE section, unchanged), then each
    // section into hard 2000-char pieces Discord will actually accept. Short text ⇒ one message,
    // byte-for-byte as before. Chilled bubbles are already message-sized sections; the hard
    // 2000-char split still guards them.
    const sections = chilled ?? chunkReply(content);
    const chunks = sections.flatMap((section) => splitDiscordContent(section));
    if (chunks.length === 0 && (!opts?.files || opts.files.length === 0)) {
      throw new Error("discord post needs text or files");
    }
    if (chunks.length === 0) chunks.push("");

    // Inter-message delays make several messages read as a person typing, not one API dump. Scaled
    // to chunk length + jittered, with a total budget so a very long reply can't take forever.
    const gaps = delaySchedule(chunks.map((c) => c.length));
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
      const payload: MessageCreateOptions = { content: chunks[i]! };
      if (i === 0 && opts?.replyToMessageId) {
        // Native reply-to: visual threading without threads + the strong correlation key
        // (Spec 05 §4.2). failIfNotExists=false so a deleted ask doesn't reject the post.
        payload.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
      }
      if (i === 0 && opts?.files && opts.files.length > 0) {
        payload.files = opts.files.map((path) => new AttachmentBuilder(path));
      }

      const sent = await channel.send(payload);
      this.ownMessageIds.add(sent.id);
      firstId ??= sent.id;
    }
    this.lastEventTs = Date.now();
    // The FIRST message id is the reply-correlation anchor (Spec 05 §4.1): it carries the native
    // reply-to + any file attachments, so returning it keeps the messageId contract intact even
    // when a long reply lands as several messages.
    return firstId!;
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

/** Factory: build a {@link DiscordGateway} from options (the daemon wires the impl). */
export function createDiscordGateway(opts: GatewayOptions = {}): DiscordGateway {
  return new DiscordJsGateway(opts);
}

/** Compile-time check: the class satisfies the frozen {@link DiscordGateway} contract. */
const _gatewayCheck: new (o?: GatewayOptions) => DiscordGateway = DiscordJsGateway;
void _gatewayCheck;

export type { DiscordGateway } from "../types.ts";
