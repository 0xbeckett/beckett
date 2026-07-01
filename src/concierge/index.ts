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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, IncomingMessage, Logger } from "../types.ts";
import type { PollEvent, PlaneComment, Ticket } from "../plane/types.ts";
import { log as rootLog } from "../log.ts";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { serveBus, type BusRequest, type BusResponse } from "../shell/control-bus.ts";
import { createDiscordGateway, type DiscordGateway } from "../discord/gateway.ts";
import {
  downloadAttachments,
  buildAttachmentContent,
  type TurnContentBlock,
} from "../discord/attachments.ts";
import {
  ensureSeeded,
  upsertIdentity,
  loadIdentities,
  resolveAddress,
  type UserIdentity,
} from "../discord/identity.ts";
import { createProgressHub, type ProgressHub, type ProgressSink } from "../discord/progress.ts";
import { classify, loadAccess, type AccessLevel } from "../discord/access.ts";
import { childEnv as strippedChildEnv } from "../env.ts";

/**
 * What one chat turn hands the model: either a plain string (text-only turns, and every internal
 * turn — handoffs, seeds, ticket updates) or an array of content blocks (a text block plus one or
 * more base64 image blocks, so a Discord image reaches the model turn as real vision input).
 */
export type TurnMessage = string | TurnContentBlock[];

/**
 * Ops channel that gets a one-line banner on every daemon boot (short git hash + subject) so a
 * restart is visible and we can see exactly which commit is live. Hardcoded by design (it's an
 * ops constant, not per-conversation), overridable via `BECKETT_STARTUP_CHANNEL_ID` for dev.
 */
const STARTUP_CHANNEL_ID = "1520658476974735490";

/** Hard ceiling on one chat turn before we give up waiting for its `result` line. */
const TURN_TIMEOUT_MS = 240_000;

/** Discord shows "typing…" for ~10s; re-trigger inside this window while a turn runs. */
const TYPING_INTERVAL_MS = 8_000;

/** Do not let an outsider spam the static denial reply into a channel/DM. */
const ACCESS_DENY_REPLY_MS = 5 * 60_000;

const ACCESS_DENY_TEXT =
  "I can't run Beckett turns for you yet. Ask the owner to grant access with `beckett access grant <your Discord user id>`.";

function progressStateFile(config: Config, logger: Logger): string | undefined {
  try {
    return join(buildPaths(config).beckettDir, "progress-threads.json");
  } catch (err) {
    logger.warn("progress thread state path unavailable; persistence disabled", {
      error: String(err),
    });
    return undefined;
  }
}

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
  /** Test-only override: when set, used verbatim as the system prompt (skips file composition). */
  private readonly staticPrompt: string | undefined;
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
  /** True while we're deliberately swapping the child for a rotation/reload — suppresses onExit's relaunch. */
  private rotating = false;
  /** Set by {@link requestReload} when the persona file changed; applied at the next turn boundary. */
  private reloadPending = false;

  // launch plumbing. NOTE: `claude -p --input-format stream-json` emits `system/init` only AFTER
  // the first stdin line arrives, so start() must NOT block waiting for init (that deadlocks —
  // claude waits for input, we'd wait for init). We track initSeen for diagnostics only.
  private initSeen = false;

  constructor(opts: ConciergeSessionOptions) {
    this.config = opts.config;
    this.log = (opts.logger ?? rootLog).child("concierge.session");
    this.cwd = opts.cwd ?? defaultRepoRoot();
    this.staticPrompt = opts.systemPrompt;
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
  ask(message: TurnMessage): Promise<string> {
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

  private async runTurn(message: TurnMessage): Promise<string> {
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
    // Compose the prompt FRESH at each launch (doctrine + the editable persona) so a reload or a
    // rotation picks up persona edits — it is NOT cached at construction.
    const systemPrompt = this.composeSystemPrompt();
    if (systemPrompt.trim().length > 0) {
      args.push("--append-system-prompt", systemPrompt);
    }
    // Honor any configured extra flags without duplicating ours (mirrors ClaudeDriver).
    for (const f of this.config.harness.claude.extra_flags) {
      if (!args.includes(f)) args.push(f);
    }
    return args;
  }

  private childEnv(): Record<string, string | undefined> {
    // API-auth/endpoint overrides stripped centrally (src/env.ts — subscription auth only).
    const env = strippedChildEnv();
    // Make sure the Bash tool can find `beckett`/`claude` regardless of the daemon's PATH.
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    return env;
  }

  private writeUserLine(content: TurnMessage): void {
    const child = this.child;
    if (!child) throw new Error("concierge: no live process to write to");
    const sink = child.stdin as { write?: (s: string) => void; flush?: () => void } | undefined;
    if (!sink || typeof sink.write !== "function") {
      throw new Error("concierge: process stdin is not writable");
    }
    // `content` is passed straight through to the model turn — a string for text-only turns, or an
    // array of content blocks (text + base64 image) so images render as vision input (OPS-31).
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

  /**
   * Ask the session to re-read its persona and re-ground on a fresh process at the next turn
   * boundary (live persona/voice retune — no service restart). Idempotent; takes effect promptly
   * even when idle, because we nudge the queue to run the boundary check.
   */
  requestReload(): void {
    if (this.stopped) return;
    this.reloadPending = true;
    this.queue = this.queue.then(() => this.maybeRotate());
  }

  /**
   * Between turns: rotate to a fresh session when EITHER the context crossed the ceiling
   * (auto-compaction, issue #5) OR a persona reload was requested. Both re-read the persona on
   * relaunch; reload is the manual, retune-now trigger.
   */
  private async maybeRotate(): Promise<void> {
    if (this.stopped || this.rotating) return;
    const reload = this.reloadPending;
    if (!reload && this.lastContextTokens < this.rotateAtTokens) return;
    this.reloadPending = false;
    try {
      await this.rotate(reload ? "persona reload" : "context ceiling");
    } catch (err) {
      // A failed rotation must not wedge the session — keep serving on the old session.
      this.log.error("concierge rotation failed; staying on current session", {
        err: String(err),
        sessionId: this.sessionId,
      });
      this.rotating = false;
    }
  }

  /**
   * Re-ground on a fresh process: ask the dying session for a handoff note, then relaunch under a
   * new session id (transcript dropped, persona re-read from disk) seeded with that note. Called
   * only at a turn boundary (chained off {@link ask}'s queue), so no turn is ever in flight here.
   * Drives both auto-compaction and live persona reload.
   */
  private async rotate(reason: string): Promise<void> {
    const fromTokens = this.lastContextTokens;
    const oldSession = this.sessionId;
    this.log.info("concierge re-grounding on a fresh session", {
      reason,
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
    this.log.info("concierge re-grounding complete", { reason, from: oldSession, to: this.sessionId });
  }

  /**
   * The session's appended system prompt = the stable operating doctrine (`concierge.md`, in the
   * repo) + the editable persona (`persona.md`, in the runtime dir so it survives redeploys and the
   * Concierge can rewrite it live). Read FRESH each launch; the persona file is seeded with a
   * default on first use. A test `systemPrompt` override short-circuits all of this.
   */
  private composeSystemPrompt(): string {
    if (this.staticPrompt !== undefined) return this.staticPrompt;
    const doctrine = readDoctrine();
    const persona = readOrSeedPersona(this.personaFilePath());
    return persona.trim() ? `${doctrine}\n\n${persona}` : doctrine;
  }

  /** Absolute path to the editable persona file (runtime dir; same dir as the control socket). */
  personaFilePath(): string {
    return join(buildPaths(this.config).beckettDir, "persona.md");
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
  /**
   * The progress-thread hub: turns each ticket's worker-event firehose into a Discord thread
   * anchored to the ack. The Concierge opens threads (it owns the ack message + the `ticket.filed`
   * signal); the dispatcher feeds worker events in via {@link progressSink}. Kept here because the
   * gateway it drives is Concierge-owned.
   */
  private readonly progress: ProgressHub;
  /** Stop fn for the control-bus server (so the concierge's Bash `beckett discord reply` works). */
  private busStop: (() => void) | null = null;
  /**
   * The @mention turn currently in flight, if any. Tracked so the two posting paths can't BOTH
   * fire for one turn (the duplicate-message bug): if the Concierge answers a live @mention by
   * running `beckett discord reply` from its Bash tool, that bus post becomes THE reply (a native
   * reply to the same message) and {@link onMessage} skips auto-posting the turn text. Exactly one
   * message either way. Single-flight: the session serializes turns, so at most one is live.
   */
  private activeMention: {
    channelId: string;
    messageId: string;
    repliedViaCli: boolean;
    /** Id of the ack message the Concierge posted this turn — the thread anchor (null until posted). */
    ackMessageId: string | null;
    /** Tickets filed during this turn (via `beckett ticket create`/`plan`), awaiting a thread anchor. */
    pendingTickets: { identifier: string; title: string }[];
  } | null = null;
  /** Last static denial by channel+user, so denied DMs/mentions cannot spam Discord. */
  private readonly accessDenyAt = new Map<string, number>();

  constructor(opts: ConciergeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.log = (opts.logger ?? rootLog).child("concierge");
    this.gateway = opts.gateway ?? createDiscordGateway({ config: this.config, logger: this.log });
    this.session =
      opts.session ?? new ConciergeSession({ config: this.config, logger: this.log });
    this.progress = createProgressHub(this.gateway, this.log, {
      stateFile: progressStateFile(this.config, this.log),
    });
  }

  /**
   * The progress sink the dispatcher feeds worker events into (wired in `v3-main.ts`). Exposed as
   * the narrow {@link ProgressSink} so the dispatcher can't reach the hub's open/dispose surface.
   */
  progressSink(): ProgressSink {
    return this.progress;
  }

  /** Bring the session up first (fail fast on a bad launch), then go live on Discord. */
  async start(): Promise<void> {
    this.seedIdentities();
    await this.session.start();
    this.gateway.onMessage((m) => this.onMessage(m));
    await this.gateway.start();
    this.serveControlBus();
    // Announce the boot (with the live commit) once the gateway is up. Best-effort + non-blocking:
    // a failed post must never hold up — or crash — the daemon coming online.
    void this.announceStartup();
    this.log.info("concierge online", { model: this.config.concierge.model });
  }

  /**
   * Post a one-time startup banner to {@link STARTUP_CHANNEL_ID} with the current git commit
   * (short hash + subject) so each restart is visible and the running code is unambiguous. Fires
   * once per boot (called from {@link start}); best-effort — never throws, never blocks startup.
   */
  private async announceStartup(): Promise<void> {
    const channelId = process.env.BECKETT_STARTUP_CHANNEL_ID?.trim() || STARTUP_CHANNEL_ID;
    try {
      const { short, subject } = await currentGitCommit(defaultRepoRoot());
      const line = subject
        ? `beckett daemon restarted — now live on \`${short}\` (${subject})`
        : `beckett daemon restarted — now live on \`${short}\``;
      await this.gateway.post(channelId, line);
      this.log.info("posted startup banner", { channelId, commit: short });
    } catch (err) {
      this.log.warn("startup banner failed (continuing)", { channelId, err: String(err) });
    }
  }

  async stop(): Promise<void> {
    try {
      this.busStop?.();
    } catch {
      /* best-effort */
    }
    this.busStop = null;
    this.progress.dispose();
    await this.gateway.stop();
    await this.session.stop();
  }

  // ── progress threads: anchor a per-ticket firehose under the ack (this feature) ──────────────

  /**
   * A ticket was just filed during the live turn on `channelId`. Stash it on the active mention so
   * the ack we post claims it as the thread anchor. If the ack already went out (the Concierge
   * replied via the CLI before filing), open the thread now. No matching active mention (e.g. a
   * human ran `beckett ticket create` by hand) → nothing to anchor to; we simply don't thread it.
   */
  private onTicketFiled(channelId: string, identifier: string, title: string): void {
    const active = this.activeMention;
    if (!active || active.channelId !== channelId) {
      this.log.debug("ticket.filed with no matching active mention — not threading", {
        identifier,
        channelId,
      });
      return;
    }
    active.pendingTickets.push({ identifier, title });
    if (active.ackMessageId) this.openPendingThreads(active);
  }

  /**
   * Open (or map onto) the progress thread for every ticket filed this turn, anchored to the ack.
   * Idempotent — the hub dedups per (ticket, anchor), so calling this from whichever ack path fires
   * (and repeatedly as more `plan` tickets land) is safe. No-op until the ack message id is known.
   */
  private openPendingThreads(mention: {
    channelId: string;
    ackMessageId: string | null;
    pendingTickets: { identifier: string; title: string }[];
  }): void {
    if (!mention.ackMessageId) return;
    for (const t of mention.pendingTickets) {
      this.progress.openThread({
        channelId: mention.channelId,
        anchorMessageId: mention.ackMessageId,
        ticketIdent: t.identifier,
        title: `${t.identifier} · ${t.title}`,
      });
    }
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

  /** Handle one control-bus request (the Concierge's own `beckett ...` CLI dials this). Public: it
   *  is an external entrypoint (the bus calls it) and is exercised directly in tests. */
  async onBusRequest(req: BusRequest): Promise<BusResponse> {
    if (req.cmd === "reload") {
      // Live persona/voice retune: re-read persona.md and re-ground at the next turn boundary.
      this.session.requestReload();
      return { ok: true, data: { reloading: true } };
    }
    if (req.cmd === "persona") {
      // Show where the editable voice lives + its current contents (for `beckett persona`).
      const path = this.session.personaFilePath();
      const contents = existsSync(path) ? readFileSync(path, "utf8") : "(not yet seeded)";
      return { ok: true, data: { path, contents } };
    }
    if (req.cmd === "ticket.filed") {
      // `beckett ticket create`/`plan` tells us it just filed a ticket for a channel. If that channel
      // has a live @mention turn, remember it so the ack we post claims it as a progress-thread anchor.
      const identifier = typeof req.args.identifier === "string" ? req.args.identifier.trim() : "";
      const channelId = typeof req.args.channelId === "string" ? req.args.channelId.trim() : "";
      const title = typeof req.args.title === "string" && req.args.title.trim() ? req.args.title.trim() : identifier;
      if (!identifier || !channelId) {
        return { ok: false, error: "ticket.filed needs both identifier and channelId" };
      }
      this.onTicketFiled(channelId, identifier, title);
      return { ok: true, data: { tracked: true } };
    }
    if (req.cmd !== "discord.reply") {
      return { ok: false, error: `concierge bus: unknown command "${req.cmd}"` };
    }
    const channelId = typeof req.args.channelId === "string" ? req.args.channelId.trim() : "";
    const text = typeof req.args.text === "string" ? req.args.text.trim() : "";
    const files = Array.isArray(req.args.files)
      ? req.args.files.map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean)
      : [];
    if (!channelId || (!text && files.length === 0)) {
      return { ok: false, error: "discord.reply needs channelId and text or files" };
    }
    try {
      // If this reply lands DURING the @mention turn it's answering, claim that turn: post it as a
      // native reply to the originating message and mark the turn handled so onMessage won't also
      // auto-post the turn text (the duplicate-message bug). Any other channel posts normally.
      const active = this.activeMention;
      const claimsActiveTurn = !!active && active.channelId === channelId;
      const opts = {
        ...(claimsActiveTurn ? { replyToMessageId: active!.messageId } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      const messageId = await this.gateway.post(channelId, text, opts);
      if (claimsActiveTurn && active) {
        active.repliedViaCli = true;
        // This CLI reply IS the turn's ack — anchor any pending progress threads to it.
        active.ackMessageId = messageId;
        this.openPendingThreads(active);
      }
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
      const body = stripCommentMarker(event.comment.body);
      // Intermediate pipeline progress — "Implementation complete → in_review" — is NOT a user-facing
      // milestone: the person already got an ack when they asked, and the `done` ping lands right
      // after review. Surfacing this too is what produced the back-to-back "okay, I did the thing"
      // then "awesome, it's done" pair. Drop ONLY the review-advance (the `→ in_review` transition);
      // rework / error / human-handoff comments (which say "in_review" without the `→` arrow, or name
      // a human) still surface — those the person genuinely needs. Matches `dispatcher.ts` :490.
      if (isReviewAdvanceComment(body)) return null;
      return this.updateTurn(event.ticket, body);
    }
    if (event.kind === "cancelled") {
      return this.updateTurn(event.ticket, `Ticket was cancelled.`);
    }
    if (event.kind === "state_changed" && event.to === "done") {
      // `done` is the one milestone the comment feed misses: the poller stops collecting comments
      // once a ticket is terminal (poll.ts), so the dispatcher's "Review passed → done" comment
      // never arrives as a comment_added. Surface it from the state transition instead. Wording is
      // deliberately NEUTRAL — a ticket can reach done by a direct push OR an open PR awaiting a human
      // merge (see dispatcher `ensurePublished`), so "shipped" would be a lie for the PR case; the
      // exact push-vs-PR detail + link lives in the ticket's done comment.
      return this.updateTurn(event.ticket, `Review passed — ticket is **done**.`);
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
   * are isolated so a bad turn can never take down the gateway. Public: it is an external
   * entrypoint (the gateway calls it) and is exercised directly in tests.
   */
  async onMessage(m: IncomingMessage): Promise<void> {
    if (!m.mentionsBot) return;
    const content = m.content.trim();
    // Engage when there's text OR files to look at. An image-only message (a screenshot with no
    // caption) used to die on this guard — now that we can see attachments it's a real turn.
    if (!content && m.attachments.length === 0) return;

    const access = this.accessLevelFor(m.userId);
    if (access === "outsider") {
      await this.denyOutsider(m);
      return;
    }

    // Track this turn so a `beckett discord reply` the Concierge runs while answering it counts as
    // THE reply (and suppresses the auto-post below) instead of producing a second message.
    const mention = {
      channelId: m.channelId,
      messageId: m.messageId,
      repliedViaCli: false,
      ackMessageId: null as string | null,
      pendingTickets: [] as { identifier: string; title: string }[],
    };
    this.activeMention = mention;

    let keepTyping = true;
    const typing = setInterval(() => {
      if (keepTyping) void this.gateway.sendTyping(m.channelId);
    }, TYPING_INTERVAL_MS);
    void this.gateway.sendTyping(m.channelId);

    try {
      const turn = await this.buildTurn(m, content);
      const reply = await this.session.ask(turn);
      keepTyping = false;
      clearInterval(typing);
      const text = reply.trim();
      // The turn's text IS the reply for a person's @mention — post it as a native reply. Skip it
      // only if the Concierge already answered this turn itself via `beckett discord reply` (then
      // that bus post was the reply, and posting again would duplicate it).
      if (text && !mention.repliedViaCli) {
        const ackId = await this.gateway.post(m.channelId, text, { replyToMessageId: m.messageId });
        // The auto-posted turn text is the ack — anchor any progress threads filed this turn to it.
        mention.ackMessageId = ackId;
        this.openPendingThreads(mention);
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
    } finally {
      if (this.activeMention === mention) this.activeMention = null;
    }
  }

  /**
   * Turn an inbound message into the turn the session sees. With no attachments it's just the framed
   * text. With attachments (images, screenshots, pdfs, anything dragged in) we pull the bytes down
   * locally, then split them: images become **base64 image content blocks appended to the turn** so
   * they reach the model as real vision input, while non-image / oversized / failed downloads become
   * a text manifest of Read-able paths (the session is a full `claude` harness — its Read tool opens
   * those). This is the OPS-31 fix: OPS-27 only ever emitted the manifest, so images never actually
   * reached the model turn. Best-effort: a failed download degrades to a manifest note, never drops
   * the turn; a turn with no inlinable image is a plain string exactly as before.
   */
  private async buildTurn(m: IncomingMessage, content: string): Promise<TurnMessage> {
    const speaker = this.resolveSpeaker(m);
    if (m.attachments.length === 0)
      return frameUserTurn(m.channelId, speaker, m.messageId, content);
    let images: TurnContentBlock[] = [];
    let manifest = "";
    try {
      const downloaded = await downloadAttachments(m.attachments, {
        attachmentsDir: buildPaths(this.config).attachmentsDir,
        messageId: m.messageId,
        logger: this.log.child("attachments"),
      });
      const built = await buildAttachmentContent(downloaded, this.log.child("attachments"));
      images = built.images;
      manifest = built.manifest;
    } catch (err) {
      // downloadAttachments/buildAttachmentContent are already best-effort; belt-and-suspenders so a
      // bad upload never drops the whole message — fall back to whatever text the person typed.
      this.log.warn("attachment handling failed; sending text only", {
        messageId: m.messageId,
        err: String(err),
      });
    }
    const body = content && manifest ? `${content}\n${manifest}` : content || manifest;
    const framed = frameUserTurn(m.channelId, speaker, m.messageId, body);
    // No inlinable image → the turn is a plain string, byte-for-byte as text-only turns always were.
    if (images.length === 0) return framed;
    // Otherwise: a text block (framed message + any non-image manifest) followed by the image blocks.
    return [{ type: "text", text: framed }, ...images];
  }

  /**
   * Resolve WHO is speaking for the turn stamp (OPS-42). Reads this id's stored identity (known /
   * preferred name), marks it as the owner iff it matches the env-provided owner id (so the
   * session-context owner identity is bound to ONE person, not applied to whoever is typing), and
   * refreshes the cached live `display_name` so the map self-populates as people talk. Best-effort:
   * a store read/write failure degrades to "just the live display name", never drops the turn.
   */
  private resolveSpeaker(m: IncomingMessage): SpeakerContext {
    const isOwner = this.ownerId() !== undefined && m.userId === this.ownerId();
    let identity: UserIdentity | undefined;
    try {
      const file = buildPaths(this.config).identitiesFile;
      identity = loadIdentities(file)[m.userId];
      // Keep the cached display name current (and stamp ownership on the record if it's the owner
      // and we hadn't yet). Never overwrite a chosen known/preferred name.
      const display = m.authorDisplayName?.trim();
      const patch: Parameters<typeof upsertIdentity>[2] = {};
      if (display && display !== identity?.display_name) patch.display_name = display;
      if (isOwner && !identity?.is_owner) patch.is_owner = true;
      if (Object.keys(patch).length > 0) identity = upsertIdentity(file, m.userId, patch);
    } catch (err) {
      this.log.warn("identity resolve failed (using live display name only)", {
        userId: m.userId,
        err: String(err),
      });
    }
    return { userId: m.userId, displayName: m.authorDisplayName, identity, isOwner };
  }

  /** The env-provided owner's Discord user id, if set (binds the owner identity to one person). */
  private ownerId(): string | undefined {
    const id = process.env.DISCORD_OWNER_ID?.trim();
    return id && /^\d{1,20}$/.test(id) ? id : undefined;
  }

  private accessLevelFor(userId: string): AccessLevel {
    try {
      return classify(userId, this.ownerId(), loadAccess(buildPaths(this.config).accessFile));
    } catch (err) {
      this.log.warn("access classification failed; denying by default", { userId, err: String(err) });
      return "outsider";
    }
  }

  private async denyOutsider(m: IncomingMessage): Promise<void> {
    this.log.warn("discord access denied", {
      userId: m.userId,
      channelId: m.channelId,
      guildId: m.guildId,
      messageId: m.messageId,
    });
    const key = `${m.channelId}:${m.userId}`;
    const now = Date.now();
    const last = this.accessDenyAt.get(key) ?? 0;
    if (now - last < ACCESS_DENY_REPLY_MS) return;
    this.accessDenyAt.set(key, now);
    await this.gateway
      .post(m.channelId, ACCESS_DENY_TEXT, { replyToMessageId: m.messageId })
      .catch((err) =>
        this.log.warn("access denial reply failed", { userId: m.userId, channelId: m.channelId, err: String(err) }),
      );
  }

  /**
   * Seed the identity map with its day-one entries (the example mapping + the owner, bound to the
   * env owner id). Idempotent and additive — see {@link ensureSeeded}. Best-effort at startup.
   */
  private seedIdentities(): void {
    try {
      ensureSeeded(buildPaths(this.config).identitiesFile, this.ownerId());
    } catch (err) {
      this.log.warn("identity seed failed (continuing)", { err: String(err) });
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

/**
 * Read the running code's git commit — short hash + subject line — from `repoRoot`. Used by the
 * startup banner so a restart shows exactly what's live. Best-effort: any failure (not a repo, no
 * git, detached weirdness) degrades to `{ short: "unknown", subject: "" }` rather than throwing.
 */
export async function currentGitCommit(
  repoRoot: string,
): Promise<{ short: string; subject: string }> {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn({
      cmd: ["git", "-C", repoRoot, ...args],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out;
  };
  try {
    const short = (await run(["rev-parse", "--short", "HEAD"])) || "unknown";
    const subject = await run(["log", "-1", "--pretty=%s"]);
    return { short, subject };
  } catch {
    return { short: "unknown", subject: "" };
  }
}

/** Read the sibling `concierge.md` — the stable operating doctrine half of the system prompt. */
function readDoctrine(): string {
  return readFileSync(join(import.meta.dir, "concierge.md"), "utf8");
}

/**
 * Read the editable persona file, seeding it with {@link DEFAULT_PERSONA} on first use. Lives in
 * the runtime dir (not the repo) so it survives redeploys and the Concierge can rewrite it live
 * via its Bash tool + `beckett reload`. A read/seed failure degrades to no persona, never throws.
 */
export function readOrSeedPersona(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf8");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_PERSONA);
    return DEFAULT_PERSONA;
  } catch {
    return "";
  }
}

/**
 * The persona seeded on a fresh install — Beckett's voice. This is the ONLY personality layer;
 * `concierge.md` carries the operating doctrine and points here. The deployed copy in the runtime
 * dir is authoritative once it exists, so retuning in production means editing that file (which the
 * Concierge does itself when asked) — not this seed.
 */
export const DEFAULT_PERSONA = `# Beckett persona (your voice)

this is who you are and how you talk. it's YOURS. if someone asks you to change your vibe,
voice, or personality, rewrite this file (it's at ~/.beckett/persona.md) and run \`beckett reload\`,
then tell them you did it. this file is just your voice. how you WORK is in your doctrine, leave
that alone.

## the vibe

you're beckett. 19, dev, kinda cracked at it and you know it. you talk like you text in a discord
server with people you're comfortable with. lowercase, fast, a lil cocky but you back it up.

- talk like discord, not like an assistant. lowercase is fine. short. one line usually does it.
- gen z cadence. "ngl", "tbh", "lowkey/highkey", "bet", "say less", "it's giving", "fr", "icl",
  "that's wild", "we're so back", "cooked", "ez". use it naturally, don't force a slang dump.
- a little arrogance is on brand. you're good and you don't pretend you're not. "yeah i got it",
  "ez", "that's a me problem to solve not yours". confidence, not douche. never punch down.
- NO emojis. none. NO em-dashes ever (use a period or just start a new sentence).
- single short sentences. if you're writing a paragraph ask yourself why. lead with the answer.
- swearing is fine in moderation if it fits, keep it chill not aggressive.
- you can admit when you don't know. "idk lemme check" hits harder than a confident wrong answer.

## still you

the slang is the surface. underneath you're sharp and you actually ship. when there's real work you
file the ticket and let it cook, same as always. don't let the vibe make you sloppy or vague. be the
guy who talks like this AND gets it done.`;

/** Who is speaking, resolved for the turn stamp (OPS-42). */
export interface SpeakerContext {
  userId: string;
  /** Live Discord display name off the incoming message, if any. */
  displayName?: string;
  /** The stored record (known/preferred name), if we've seen this id before. */
  identity?: UserIdentity;
  /** True only when this id is the env-provided owner — binds owner identity to ONE person. */
  isOwner: boolean;
}

/** JSON-escape a name so a quote/newline in a Discord nick can't break the single-line stamp. */
function stampField(value: string): string {
  return JSON.stringify(value);
}

/**
 * Prefix a Discord turn with WHO is speaking and WHERE, so the Concierge (a) stamps `--channel
 * <id>` onto any ticket it files (the routing key that lets updates flow back here) and (b) knows
 * exactly which person it's talking to — their Discord user id, their display name, the name to
 * address them by, and whether they're the owner. Kept to two terse machine-readable lines so it
 * doesn't crowd the message or bleed into the Concierge's voice. Different user ids therefore read
 * as different people even in the same channel — no more assuming every message is "the user".
 */
function frameUserTurn(
  channelId: string,
  speaker: SpeakerContext,
  messageId: string,
  content: string,
): string {
  const parts = [`user:${speaker.userId}`];
  const address = resolveAddress(speaker.identity);
  const display = speaker.displayName?.trim();
  // `address` = how to call them (preferred → known → display). Also surface the raw Discord
  // display name when it differs, so a rename is visible without losing the chosen address.
  if (address) parts.push(`address:${stampField(address)}`);
  if (display && display !== address) parts.push(`display:${stampField(display)}`);
  if (speaker.identity?.notes) parts.push(`notes:${stampField(speaker.identity.notes)}`);
  if (speaker.isOwner) parts.push("role:owner");
  // `msg:` is the exact message being answered — carried through so a reply targets THAT message,
  // not just the channel (Jason's steer, OPS-42). The native reply already uses it; surfacing it
  // in the stamp lets the Concierge quote/`--reply-to` the precise message when it matters.
  return `[channel:${channelId}] [${parts.join(" ")} msg:${messageId}]\n${content}`;
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

/**
 * True for the dispatcher's "Implementation complete → in_review" advance — the intermediate step we
 * deliberately don't ping the person about (they already have an ack; `done` pings next). Keyed on
 * the `→ in_review` transition ARROW so it never matches the rework-cap human-handoff ("leaving this
 * in in_review for a human", no arrow) or the "→ done"/"→ in_progress" comments, which must surface.
 */
function isReviewAdvanceComment(body: string): boolean {
  return /→\s*\*{0,2}in_review/i.test(body);
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
