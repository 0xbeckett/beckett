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
import { log as rootLog } from "../log.ts";
import { loadConfig } from "../config.ts";
import { createDiscordGateway, type DiscordGateway } from "../discord/gateway.ts";

/** The same env keys the worker driver strips — subscription auth only (Spec 00 §4). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** How long spawn() waits for the first `system/init` before failing the launch. */
const INIT_TIMEOUT_MS = 60_000;

/** Hard ceiling on one chat turn before we give up waiting for its `result` line. */
const TURN_TIMEOUT_MS = 240_000;

/** Discord shows "typing…" for ~10s; re-trigger inside this window while a turn runs. */
const TYPING_INTERVAL_MS = 8_000;

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
  private readonly sessionId: string;

  private child: Child | null = null;
  private pending: PendingTurn | null = null;
  /** Serializes turns: each `ask` chains onto the previous so claude sees one input at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  // launch plumbing
  private resolveInit: (() => void) | null = null;
  private rejectInit: ((e: Error) => void) | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  private initSeen = false;

  constructor(opts: ConciergeSessionOptions) {
    this.config = opts.config;
    this.log = (opts.logger ?? rootLog).child("concierge.session");
    this.cwd = opts.cwd ?? defaultRepoRoot();
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt();
    this.model = opts.config.concierge.model;
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
    this.queue = run.catch(() => undefined);
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
          resolve(acc || "Still chewing on that one — give me a sec and ask again.");
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

    const ready = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });

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
      const e = new Error(`concierge: failed to spawn ${bin} — ${(err as Error).message}`);
      this.rejectInit?.(e);
      throw e;
    }
    this.child = child;

    this.initTimer = setTimeout(() => {
      this.rejectInit?.(new Error(`concierge: no system/init within ${INIT_TIMEOUT_MS}ms`));
    }, INIT_TIMEOUT_MS);

    void this.consumeStdout(child).catch((err) =>
      this.log.error("concierge stdout loop crashed", { err: String(err) }),
    );
    void this.drainStderr(child);
    void child.exited.then((code) => this.onExit(code));

    await ready;
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
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    // Died before init → fail the pending launch.
    if (!this.initSeen) this.rejectInit?.(new Error(`concierge: claude exited (code ${code}) before init`));
    this.resolveInit = null;
    this.rejectInit = null;
    if (this.stopped) return;
    this.log.warn("concierge claude process exited", { code, sessionId: this.sessionId });
    // The current process is gone; the next ask() will relaunch with --resume (context intact).
    this.child = null;
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
          this.onAssistant(obj);
          break;
        case "result":
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
    this.initSeen = true;
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    this.resolveInit?.();
    this.resolveInit = null;
    this.rejectInit = null;
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
    this.log.info("concierge online", { model: this.config.concierge.model });
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
    await this.session.stop();
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
      const reply = await this.session.ask(content);
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
