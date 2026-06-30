/**
 * Beckett v3 — the Concierge (`src/concierge/index.ts`)
 * =======================================================================================
 * The long-lived `claude -p` Opus agent that OWNS Discord (v3 §0/§8). It chats in Beckett's
 * voice, sizes effort, and for real work files a ticket into Plane by shelling
 * `beckett ticket ...` from its own Bash tool. It NEVER spawns workers — that is the
 * dispatcher's job. Work state lives in Plane; chat context stays clean.
 *
 * Wiring:
 *   - {@link DiscordJsGateway} (`../discord/gateway.ts`) is the human-facing I/O.
 *   - A persistent Opus session ({@link ConciergeSession}) is seeded with `concierge.md` as
 *     its system prompt and answers one Discord turn at a time.
 *   - On each @beckett mention (or DM) we run a turn and post the reply back to the
 *     originating channel as a native reply.
 *
 * Why a bespoke session and not the worker `ClaudeDriver` directly:
 *   `claude -p --input-format stream-json` keeps ONE process alive across many turns but
 *   emits a `result` line after EVERY turn (re-emitting `system/init` for the next user
 *   message). `ClaudeDriver` is built for one-shot workers: it latches `finished` on the
 *   first `result` and routes to a terminal state, so it cannot host a multi-turn chat in a
 *   single live process. The Concierge therefore drives the same `claude` invocation
 *   (identical flags, identical env-stripping, identical tolerant NDJSON parsing) but treats
 *   each `result` as a per-turn boundary rather than a death. Everything else mirrors the
 *   driver's conventions exactly.
 *
 * Import style: explicit `.ts` extensions, ESM, bun runtime.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, IncomingMessage, Logger } from "../types.ts";
import type { PollEvent, PlaneComment, Ticket } from "../plane/types.ts";
import { log as rootLog } from "../log.ts";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { serveBus, type BusRequest, type BusResponse } from "../shell/control-bus.ts";
import { createDiscordGateway, type DiscordGateway } from "../discord/gateway.ts";

/** The same env keys the worker driver strips — subscription auth only (Spec 00 §4). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** Hard ceiling on one chat turn before we give up waiting for its `result` line. */
const TURN_TIMEOUT_MS = 240_000;

/** Discord shows "typing…" for ~10s; re-trigger inside this window while a turn runs. */
const TYPING_INTERVAL_MS = 8_000;

/**
 * Default context-size ceiling (summed input tokens) at which we auto-compact the session.
 * Headless `claude -p` exposes no programmatic `/compact`, so "compaction" here means: summarize
 * the conversation, then rotate to a fresh `--session-id` seeded with that summary (issue #5). At
 * 190k we're comfortably under the 200k window with room for one more turn + the handoff turn.
 * Overridable via `config.concierge.rotate_at_tokens` (driven low in tests to exercise rotation).
 */
const DEFAULT_ROTATE_AT_TOKENS = 190_000;

/** What a turn resolves to when it times out — must never be seeded as a handoff "summary". */
const TURN_TIMEOUT_FALLBACK = "Still chewing on that one — give me a sec and ask again.";

/** Prompt that asks the dying session for a compact handoff before we drop its transcript. */
const HANDOFF_PROMPT =
  "SYSTEM: Your conversation context is about to be compacted and this transcript dropped. " +
  "In <=200 words, write a handoff note for your fresh self: who you're mid-conversation with, " +
  "any open threads or promises, tickets you've filed and their channels, and anything you'd " +
  "lose by forgetting. Prose only, no preamble — you are writing a note to yourself.";

/**
 * The live context size from a turn's `usage` block = the SUM of every input-side field. Exported
 * for tests because getting this wrong is the classic bug: `input_tokens` alone is only the
 * uncached delta (tens of tokens on a warm session) and never trips the ceiling; the real mass
 * lives in `cache_read_input_tokens` (warm) or `cache_creation_input_tokens` (after a cache gap).
 * Returns 0 for anything that isn't a usage object.
 */
export function contextTokensFromUsage(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
}

/** Frames the handoff summary as the first line of the rotated session (re-grounds the new self). */
function seedFromHandoff(summary: string): string {
  return (
    "SYSTEM: Context was just compacted. This is your handoff note from the prior session — " +
    "treat it as memory, not as a message from the user, and do not reply to it:\n\n" +
    summary
  );
}

/** The bun subprocess handle type (mirrors ClaudeDriver — avoids importing the bun symbol). */
type Child = ReturnType<typeof Bun.spawn>;

/** A turn waiting for its `result` boundary. Single-flight: at most one is live at a time. */
interface PendingTurn {
  parts: string[];
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConciergeSessionOptions {
  config: Config;
  logger?: Logger;
  /** cwd for the claude process (so its Bash `beckett ...` calls run at the repo root). */
  cwd?: string;
  /** Override the system prompt (defaults to the sibling `concierge.md`). */
  systemPrompt?: string;
}

/**
 * A persistent, single-flight Opus chat session over `claude -p` stream-json. `ask()` writes
 * one user line, then resolves with the assistant text accumulated up to the next `result`.
 * Survives an unexpected process exit by relaunching with `--resume <sessionId>`.
 */
export class ConciergeSession {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly model: string;
  /** Summed-input-token ceiling that triggers auto-compaction (from config; issue #5). */
  private readonly rotateAtTokens: number;
  /** Mutable: rotation (auto-compaction) mints a fresh id and relaunches under it (issue #5). */
  private sessionId: string;

  private child: Child | null = null;
  private pending: PendingTurn | null = null;
  /** Serializes turns: each `ask` chains onto the previous so claude sees one input at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Latest summed input-token count (input + cache_creation + cache_read) — the live context size. */
  private lastContextTokens = 0;
  /** True while we're deliberately swapping the child for a rotation — suppresses onExit's relaunch. */
  private rotating = false;

  // launch plumbing. NOTE: `claude -p --input-format stream-json` emits `system/init` only AFTER
  // the first stdin line arrives, so start() must NOT block waiting for init (that deadlocks —
  // claude waits for input, we'd wait for init). We track initSeen for diagnostics only.
  private initSeen = false;

  constructor(opts: ConciergeSessionOptions) {
    this.config = opts.config;
    this.log = (opts.logger ?? rootLog).child("concierge.session");
    this.cwd = opts.cwd ?? defaultRepoRoot();
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt();
    this.model = opts.config.concierge.model;
    this.rotateAtTokens = opts.config.concierge.rotate_at_tokens ?? DEFAULT_ROTATE_AT_TOKENS;
    this.sessionId = crypto.randomUUID();
  }

  /** Launch the claude process and resolve once the first `system/init` arrives. */
  async start(): Promise<void> {
    await this.launch(/*resume*/ false);
  }

  /**
   * Run one chat turn. Writes the message as a user line and resolves with the assistant's
   * reply text once claude emits the turn's `result`. Single-flight via the internal queue.
   */
  ask(message: string): Promise<string> {
    const run = this.queue.then(() => this.runTurn(message));
    // Keep the chain alive even if a turn rejects, so one bad turn never wedges the session.
    // Chain the rotation check AFTER the turn so any compaction lands at a turn boundary (never
    // mid-turn) and the next ask() waits for the fresh session to be live.
    this.queue = run.catch(() => undefined).then(() => this.maybeRotate());
    return run;
  }

  /** Stop the session and reject any in-flight turn. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("concierge session stopped"));
      this.pending = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private async runTurn(message: string): Promise<string> {
    if (this.stopped) throw new Error("concierge session stopped");
    if (!this.child) await this.launch(/*resume*/ true);
    const child = this.child;
    if (!child) throw new Error("concierge session has no live process");

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) {
          const acc = this.pending.parts.join("\n\n").trim();
          this.pending = null;
          // Don't hang the human forever — return whatever we have (or a soft nudge).
          resolve(acc || TURN_TIMEOUT_FALLBACK);
        }
      }, TURN_TIMEOUT_MS);
      this.pending = { parts: [], resolve, reject, timer };
      try {
        this.writeUserLine(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async launch(isResume: boolean): Promise<void> {
    const bin = this.config.harness.claude.bin;
    const args = this.buildArgs(isResume);
    this.initSeen = false;

    this.log.info("spawning concierge claude session", {
      bin,
      model: this.model,
      isResume,
      sessionId: this.sessionId,
    });

    let child: Child;
    try {
      child = Bun.spawn({
        cmd: [bin, ...args],
        cwd: this.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: this.childEnv(),
      });
    } catch (err) {
      throw new Error(`concierge: failed to spawn ${bin} — ${(err as Error).message}`);
    }
    this.child = child;

    void this.consumeStdout(child).catch((err) =>
      this.log.error("concierge stdout loop crashed", { err: String(err) }),
    );
    void this.drainStderr(child);
    void child.exited.then((code) => this.onExit(code));

    // Do NOT await `system/init` here — this claude build emits it only after the first stdin
    // line, so the session is "ready" once spawned. The first ask() writes a line which triggers
    // init + the turn; a dead launch (bad bin/auth) surfaces as that first turn failing.
  }

  private buildArgs(isResume: boolean): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      this.model,
    ];
    if (isResume) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);
    if (this.systemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", this.systemPrompt);
    }
    // Honor any configured extra flags without duplicating ours (mirrors ClaudeDriver).
    for (const f of this.config.harness.claude.extra_flags) {
      if (!args.includes(f)) args.push(f);
    }
    return args;
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of FORBIDDEN_ENV_KEYS) delete env[k];
    // Make sure the Bash tool can find `beckett`/`claude` regardless of the daemon's PATH.
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    return env;
  }

  private writeUserLine(content: string): void {
    const child = this.child;
    if (!child) throw new Error("concierge: no live process to write to");
    const sink = child.stdin as { write?: (s: string) => void; flush?: () => void } | undefined;
    if (!sink || typeof sink.write !== "function") {
      throw new Error("concierge: process stdin is not writable");
    }
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      }) + "\n";
    sink.write(line);
    sink.flush?.();
  }

  private async onExit(code: number): Promise<void> {
    // During a rotation we kill the old child on purpose and immediately relaunch under a fresh
    // session id; let rotate() own the child handle so this exit is not mistaken for a crash.
    if (this.rotating) {
      this.log.debug("concierge process exited during rotation (expected)", { code });
      return;
    }
    this.child = null;
    if (this.stopped) return;
    this.log.warn("concierge claude process exited", { code, sessionId: this.sessionId });
    // The current process is gone; the next ask() relaunches with --resume (context intact). Any
    // turn that was in flight is failed so the human gets an error rather than a hang.
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(`concierge: claude exited (code ${code}) mid-turn`));
      this.pending = null;
    }
  }

  private async consumeStdout(child: Child): Promise<void> {
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.handleLine(line);
        }
      }
      const tail = buf.trim();
      if (tail) this.handleLine(tail);
    } finally {
      reader.releaseLock();
    }
  }

  private async drainStderr(child: Child): Promise<void> {
    const stream = child.stderr;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) this.log.debug("concierge stderr", { text });
      }
    } catch {
      /* stderr is diagnostic only */
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse one NDJSON line. Tolerant by contract (mirrors ClaudeDriver.handleLine): we switch
   * on known shapes and ignore the rest — a surprising line never throws out of the loop.
   *   - `system/init`  → the session (or this turn) is live; confirm the launch.
   *   - `assistant`    → accumulate the turn's text blocks (the human-facing reply).
   *   - `result`       → the turn is complete; resolve the pending `ask` with the text.
   */
  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise — ignore
    }
    try {
      switch (obj.type) {
        case "system":
          if (obj.subtype === "init") this.onInit();
          break;
        case "assistant":
          this.recordUsage((obj.message as Record<string, unknown> | undefined)?.usage);
          this.onAssistant(obj);
          break;
        case "result":
          this.recordUsage(obj.usage);
          this.onResult();
          break;
        default:
          break; // user echoes, stream deltas, errors, unknown — not needed for chat output
      }
    } catch (err) {
      this.log.warn("concierge line handling error (ignored)", { err: String(err) });
    }
  }

  private onInit(): void {
    // Diagnostic only now — init no longer gates the launch (see launch() note).
    if (!this.initSeen) this.log.debug("concierge session init seen");
    this.initSeen = true;
  }

  private onAssistant(obj: Record<string, unknown>): void {
    if (!this.pending) return;
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.pending.parts.push(block.text);
      }
    }
  }

  private onResult(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(p.parts.join("\n\n").trim());
  }

  /**
   * Track the live context size from a turn's `usage`. The context size is the SUM of every
   * input-side field on the latest turn — `input_tokens` alone is only the uncached delta (a
   * handful of tokens on a warm cached session) and would never cross the threshold. On a warm
   * session most of the mass sits in `cache_read`; after a >5-min gap the same mass reappears as
   * `cache_creation`. Each turn re-sends the whole context, so the latest sum IS the current size.
   */
  private recordUsage(raw: unknown): void {
    const ctx = contextTokensFromUsage(raw);
    if (ctx > 0) this.lastContextTokens = ctx;
  }

  /** Between turns: if the context crossed the ceiling, compact by rotating to a fresh session. */
  private async maybeRotate(): Promise<void> {
    if (this.stopped || this.rotating) return;
    if (this.lastContextTokens < this.rotateAtTokens) return;
    try {
      await this.rotate();
    } catch (err) {
      // A failed rotation must not wedge the session — keep serving on the old (bloated) one.
      this.log.error("concierge rotation failed; staying on current session", {
        err: String(err),
        sessionId: this.sessionId,
      });
      this.rotating = false;
    }
  }

  /**
   * Auto-compaction (issue #5). Asks the dying session for a handoff note, then drops the
   * transcript by relaunching under a fresh session id seeded with that note. Called only at a
   * turn boundary (chained off {@link ask}'s queue), so no turn is ever in flight here.
   */
  private async rotate(): Promise<void> {
    const fromTokens = this.lastContextTokens;
    const oldSession = this.sessionId;
    this.log.info("concierge context at ceiling — compacting via session rotation", {
      contextTokens: fromTokens,
      ceiling: this.rotateAtTokens,
      sessionId: oldSession,
    });

    // 1. Last words from the dying session, on its still-live child (best-effort). Guard the
    //    timeout sentinel — seeding "Still chewing…" as a handoff note would be nonsense.
    let summary = "";
    try {
      const note = (await this.runTurn(HANDOFF_PROMPT)).trim();
      if (note && note !== TURN_TIMEOUT_FALLBACK) summary = note;
    } catch (err) {
      this.log.warn("concierge handoff summary failed — rotating without it", { err: String(err) });
    }

    // 2. Swap the child for a fresh session. `rotating` makes onExit ignore the deliberate kill.
    this.rotating = true;
    try {
      const old = this.child;
      this.child = null;
      if (old) {
        try {
          old.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      this.sessionId = crypto.randomUUID();
      this.lastContextTokens = 0;
      await this.launch(/*resume*/ false); // fresh id, transcript dropped, concierge.md re-attaches
    } finally {
      this.rotating = false;
    }

    // 3. Re-ground the fresh self with the handoff note (skipped if we couldn't get one).
    if (summary) {
      try {
        await this.runTurn(seedFromHandoff(summary));
      } catch (err) {
        this.log.warn("concierge re-grounding turn failed (continuing)", { err: String(err) });
      }
    }
    this.log.info("concierge rotation complete", { from: oldSession, to: this.sessionId });
  }
}

// =======================================================================================
// Concierge — gateway + session glue
// =======================================================================================

export interface ConciergeOptions {
  config?: Config;
  logger?: Logger;
  /** Inject a gateway (tests); defaults to the real discord.js gateway. */
  gateway?: DiscordGateway;
  /** Inject a session (tests); defaults to a real ConciergeSession. */
  session?: ConciergeSession;
}

/**
 * Owns the Discord gateway and the persistent Opus session, and routes between them: every
 * `@beckett` mention (and every DM) becomes one session turn whose reply is posted back to
 * the originating channel as a native reply.
 */
export class Concierge {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly gateway: DiscordGateway;
  private readonly session: ConciergeSession;
  /** Stop fn for the control-bus server (so the concierge's Bash `beckett discord reply` works). */
  private busStop: (() => void) | null = null;

  constructor(opts: ConciergeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.log = (opts.logger ?? rootLog).child("concierge");
    this.gateway = opts.gateway ?? createDiscordGateway({ config: this.config, logger: this.log });
    this.session =
      opts.session ?? new ConciergeSession({ config: this.config, logger: this.log });
  }

  /** Bring the session up first (fail fast on a bad launch), then go live on Discord. */
  async start(): Promise<void> {
    await this.session.start();
    this.gateway.onMessage((m) => this.onMessage(m));
    await this.gateway.start();
    this.serveControlBus();
    this.log.info("concierge online", { model: this.config.concierge.model });
  }

  async stop(): Promise<void> {
    try {
      this.busStop?.();
    } catch {
      /* best-effort */
    }
    this.busStop = null;
    await this.gateway.stop();
    await this.session.stop();
  }

  // ── closing the agent loop: Plane updates → Discord (issue: ticket updates never surfaced) ──

  /**
   * Serve the control bus the Concierge's OWN `claude` process dials via `beckett discord reply`
   * from its Bash tool. v3 doesn't run the v2 shell, so without this the CLI would hit a dead
   * socket; here the same machinery routes `discord.reply` straight into the in-process gateway.
   */
  private serveControlBus(): void {
    // Same path the CLI's `callBus` dials (`<beckettDir>/control.sock`). Resolved here, not in the
    // constructor, so constructing a Concierge never touches the filesystem (keeps it unit-testable).
    const sock = join(buildPaths(this.config).beckettDir, "control.sock");
    this.busStop = serveBus(sock, (req) => this.onBusRequest(req));
    this.log.info("concierge control bus listening", { socket: sock });
  }

  private async onBusRequest(req: BusRequest): Promise<BusResponse> {
    if (req.cmd !== "discord.reply") {
      return { ok: false, error: `concierge bus: unknown command "${req.cmd}"` };
    }
    const channelId = typeof req.args.channelId === "string" ? req.args.channelId.trim() : "";
    const text = typeof req.args.text === "string" ? req.args.text.trim() : "";
    if (!channelId || !text) {
      return { ok: false, error: "discord.reply needs both channelId and text" };
    }
    try {
      const messageId = await this.gateway.post(channelId, text);
      return { ok: true, data: { messageId } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Fan a batch of Plane poll events at the Concierge so it can surface progress to the human
   * (the closed loop). We relay only what's worth a turn — the dispatcher's OWN milestone/error
   * comments (it narrates every outcome to Plane) and cancellations — and let the Concierge judge
   * voice/skip. Each relevant event becomes one session turn that asks it to reply via the CLI.
   * Fire-and-forget: turns queue on the session and never block the poll loop.
   */
  notify(events: PollEvent | PollEvent[]): void {
    const batch = Array.isArray(events) ? events : [events];
    for (const event of batch) {
      const framed = this.frameUpdate(event);
      if (!framed) continue; // not worth surfacing, or no channel to route back to
      // Don't await: the turn serializes on the session's own queue; the poll loop moves on.
      void this.session.ask(framed).catch((err) =>
        this.log.warn("concierge update turn failed (ignored)", { err: String(err) }),
      );
    }
  }

  /**
   * Decide whether a poll event is worth telling the user about, and if so frame it as a turn that
   * instructs the Concierge to reply via `beckett discord reply`. Returns null to stay silent.
   * Milestones + errors only: the dispatcher posts a `<!-- beckett… -->`-tagged comment on every
   * outcome (advance / error / verdict / rework), so those comments ARE the milestone feed.
   */
  private frameUpdate(event: PollEvent): string | null {
    if (event.kind === "comment_added") {
      if (!isDispatcherComment(event.comment)) return null; // human/worker chatter — not ours to echo
      return this.updateTurn(event.ticket, stripCommentMarker(event.comment.body));
    }
    if (event.kind === "cancelled") {
      return this.updateTurn(event.ticket, `Ticket was cancelled.`);
    }
    if (event.kind === "state_changed" && event.to === "done") {
      // `done` is the one milestone the comment feed misses: the poller stops collecting comments
      // once a ticket is terminal (poll.ts), so the dispatcher's "Review passed → done" comment
      // never arrives as a comment_added. Surface it from the state transition instead.
      return this.updateTurn(event.ticket, `Review passed — shipped, ticket is **done**.`);
    }
    // Other `state_changed` (→in_review, →in_progress rework) and `created` already arrive as the
    // dispatcher's own comments on a still-active ticket, so we don't double-surface them here.
    return null;
  }

  /** Build the synthetic update turn (or null when the ticket can't be routed back to a channel). */
  private updateTurn(ticket: Ticket, detail: string): string | null {
    const channel = ticket.originChannel;
    if (!channel) {
      // This is the exact failure the closed loop exists to prevent: an update with nowhere to go,
      // because the ticket was filed without --channel. Warn loudly — silence here recreates the bug.
      this.log.warn("ticket update dropped — no origin channel on ticket (was it filed without --channel?)", {
        ticket: ticket.identifier,
      });
      return null;
    }
    return (
      `SYSTEM (automated ticket update — NOT a message from a user; do not reply to this turn as if a person typed it):\n` +
      `Ticket ${ticket.identifier} "${ticket.title}" has an update:\n\n${detail}\n\n` +
      `If this is worth telling the person who asked for it, send them a short note IN YOUR VOICE by ` +
      `running this from your Bash tool:\n` +
      `  beckett discord reply --channel ${channel} "<your message>"\n` +
      `Paraphrase — don't dump the raw status. If it's routine or not worth a ping, do nothing.`
    );
  }

  /**
   * Handle one inbound Discord message. We only engage when addressed (an @mention or a DM —
   * the gateway folds both into `mentionsBot`); ambient chatter is left alone here. Failures
   * are isolated so a bad turn can never take down the gateway.
   */
  private async onMessage(m: IncomingMessage): Promise<void> {
    if (!m.mentionsBot) return;
    const content = m.content.trim();
    if (!content) return;

    let keepTyping = true;
    const typing = setInterval(() => {
      if (keepTyping) void this.gateway.sendTyping(m.channelId);
    }, TYPING_INTERVAL_MS);
    void this.gateway.sendTyping(m.channelId);

    try {
      const reply = await this.session.ask(frameUserTurn(m.channelId, content));
      keepTyping = false;
      clearInterval(typing);
      const text = reply.trim();
      if (text) {
        await this.gateway.post(m.channelId, text, { replyToMessageId: m.messageId });
      }
    } catch (err) {
      keepTyping = false;
      clearInterval(typing);
      this.log.error("concierge turn failed", { messageId: m.messageId, err: String(err) });
      await this.gateway
        .post(m.channelId, "Something broke on my end — try me again in a sec.", {
          replyToMessageId: m.messageId,
        })
        .catch(() => undefined);
    }
  }
}

/** Factory: build a Concierge from options (mirrors the repo's `createX` convention). */
export function createConcierge(opts: ConciergeOptions = {}): Concierge {
  return new Concierge(opts);
}

// =======================================================================================
// helpers
// =======================================================================================

/** Repo root = two levels up from `src/concierge/` (matches the `site` group in beckett.ts). */
function defaultRepoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

/** Read the sibling `concierge.md` doctrine as the session's appended system prompt. */
function defaultSystemPrompt(): string {
  return readFileSync(join(import.meta.dir, "concierge.md"), "utf8");
}

/**
 * Prefix a Discord turn with its channel id so the Concierge can stamp `--channel <id>` onto any
 * ticket it files (the routing key that lets updates flow back here — see `concierge.md`). Kept
 * to one terse line so it doesn't crowd the actual message or bleed into the Concierge's voice.
 */
function frameUserTurn(channelId: string, content: string): string {
  return `[channel:${channelId}]\n${content}`;
}

/** The marker the dispatcher prepends to its own Plane comments (mirrors `BECKETT_COMMENT_MARKER`). */
const DISPATCHER_COMMENT_PREFIX = "<!-- beckett";

/** True when a comment was authored by Beckett's machinery (a milestone/error narration), not a human. */
function isDispatcherComment(comment: PlaneComment): boolean {
  return comment.body.trimStart().startsWith(DISPATCHER_COMMENT_PREFIX);
}

/** Drop the leading `<!-- beckett… -->` marker line so the Concierge paraphrases just the prose. */
function stripCommentMarker(body: string): string {
  return body.replace(/^\s*<!--\s*beckett[^>]*-->\s*/i, "").trim();
}

// Run standalone: `bun src/concierge/index.ts` brings the Concierge online.
if (import.meta.main) {
  const concierge = createConcierge();
  concierge.start().catch((err) => {
    rootLog.child("concierge").error("concierge failed to start", { err: String(err) });
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void concierge.stop().finally(() => process.exit(0));
    });
  }
}
