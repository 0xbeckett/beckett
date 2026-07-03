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
import type { Config, IncomingMessage, Logger, ProactivityMode } from "../types.ts";
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
import { setChannelModeOverride, setEnabledOverride } from "./proactivity-store.ts";
import { readPersistedOffers } from "./ambient.ts";
import { classify, loadAccess, type AccessLevel } from "../discord/access.ts";
import { childEnv as strippedChildEnv } from "../env.ts";
import {
  createAmbientCoordinator,
  isAmbientPass,
  type AmbientClock,
  type AmbientCoordinator,
  type AmbientTranscriptMessage,
  type AmbientTurn,
} from "./ambient.ts";
import { createTriageClassifier, type TriageFn, type TriageVerdict } from "./triage.ts";

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

/** After a FAILED rotation, wait this long before re-paying the (expensive) handoff turn. */
const ROTATE_RETRY_COOLDOWN_MS = 10 * 60_000;

/** Consecutive child crashes before the ops channel is alerted (bad auth/config, issue #24). */
const CRASH_LOOP_THRESHOLD = 3;

/** The immediate "you're seen" reply when a mention lands behind a busy session (issue #24). */
const FAST_ACK_TEXT = "On it — I'm mid-task right now, you're next in line.";

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

/** A turn admitted by {@link ConciergeSession.ask} and awaiting its slot in the pump. */
interface QueuedTurn {
  message: TurnMessage;
  meta?: unknown;
  /** Priority turns (person mentions) jump ahead of queued update turns (issue #25). */
  priority: boolean;
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
}

export interface ConciergeSessionOptions {
  config: Config;
  logger?: Logger;
  /** cwd for the claude process (so its Bash `beckett ...` calls run at the repo root). */
  cwd?: string;
  /** Override the system prompt (defaults to the sibling `concierge.md`). */
  systemPrompt?: string;
  /** Fired when the child has crashed {@link CRASH_LOOP_THRESHOLD}+ times in a row (issue #24). */
  onCrashLoop?: (info: { count: number; code: number }) => void;
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
  /**
   * Serializes turns (claude sees one input at a time) as a REAL queue, not a promise chain, so
   * person mentions can jump ahead of queued update turns (issue #25).
   */
  private readonly turnQueue: QueuedTurn[] = [];
  /** True while the pump is draining {@link turnQueue} (at most one turn runs at a time). */
  private pumping = false;
  private stopped = false;
  /** Latest summed input-token count (input + cache_creation + cache_read) — the live context size. */
  private lastContextTokens = 0;
  /** True while we're deliberately swapping the child for a rotation/reload — suppresses onExit's relaunch. */
  private rotating = false;
  /** Set by {@link requestReload} when the persona file changed; applied at the next turn boundary. */
  private reloadPending = false;

  // ── restart persistence + crash handling (issue #24) ────────────────────────────────────
  /** Whether the most recent launch used `--resume` (feeds the unresumable-session fallback). */
  private lastLaunchWasResume = false;
  /** Force the next (re)launch to start a FRESH session (set when a resume proved unresumable). */
  private freshNextLaunch = false;
  /** A handoff note to fold into the head of the next turn (fresh-session re-grounding). */
  private seedPending: string | null = null;
  /** The most recent rotation handoff note — persisted so a failed resume can still re-ground. */
  private lastHandoff = "";
  /** Consecutive unexpected child exits with no successful turn in between (crash-loop alarm). */
  private consecutiveCrashes = 0;
  /** Completed rotations (auto-compaction + persona reloads) this process — `beckett status`. */
  private rotations = 0;
  /** When the last rotation attempt failed — gates the retry so we don't re-pay the handoff turn. */
  private rotateFailedAt = 0;
  /** Alerted when the child crash-loops (wired by the Concierge to the ops channel). */
  private readonly onCrashLoop?: (info: { count: number; code: number }) => void;

  // ── turn bookkeeping (issue #24) ─────────────────────────────────────────────────────────
  /** Caller-supplied metadata of the CURRENTLY EXECUTING turn (reply-claim correlation). */
  private currentMeta: unknown = null;

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
    this.onCrashLoop = opts.onCrashLoop;
    this.sessionId = crypto.randomUUID();
  }

  /**
   * Launch the claude process. A deploy restart must NOT wipe the conversation (issue #24): when
   * a persisted session exists, resume it; if that resume proves unresumable the exit handler
   * falls back to a fresh session seeded with the last handoff note.
   */
  async start(): Promise<void> {
    const persisted = this.loadSessionState();
    if (persisted) {
      this.sessionId = persisted.sessionId;
      this.lastHandoff = persisted.handoff;
      this.log.info("resuming persisted concierge session across restart", {
        sessionId: this.sessionId,
      });
      await this.launch(/*resume*/ true);
    } else {
      await this.launch(/*resume*/ false);
    }
    this.persistSessionState();
  }

  /**
   * Run one chat turn. Writes the message as a user line and resolves with the assistant's
   * reply text once claude emits the turn's `result`. Single-flight via the internal queue.
   * `meta` identifies the caller's turn (e.g. the @mention being answered) — exposed via
   * {@link getCurrentMeta} while THIS turn executes, so a CLI reply can be correlated to the
   * turn that issued it (issue #24 reply-claim race). `opts.priority` turns (person mentions)
   * jump ahead of queued update turns (issue #25) but never pre-empt a RUNNING turn.
   */
  ask(message: TurnMessage, meta?: unknown, opts?: { priority?: boolean }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const entry: QueuedTurn = { message, meta, priority: opts?.priority === true, resolve, reject };
      if (entry.priority) {
        const firstNormal = this.turnQueue.findIndex((t) => !t.priority);
        if (firstNormal >= 0) this.turnQueue.splice(firstNormal, 0, entry);
        else this.turnQueue.push(entry);
      } else {
        this.turnQueue.push(entry);
      }
      void this.pump();
    });
  }

  /**
   * Drain the turn queue one turn at a time. Rotation (auto-compaction / persona reload) runs
   * between turns — never mid-turn. A rejected turn never wedges the pump.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.turnQueue.length > 0) {
        const entry = this.turnQueue.shift()!;
        try {
          entry.resolve(await this.runTurn(entry.message, entry.meta));
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
        await this.maybeRotate();
      }
    } finally {
      this.pumping = false;
    }
    // An entry admitted in the teardown gap re-arms the pump (belt-and-suspenders).
    if (this.turnQueue.length > 0) void this.pump();
  }

  /** Turns queued or in flight right now — the Concierge's fast-ack signal (issue #24). */
  queueDepth(): number {
    return this.turnQueue.length + (this.pumping ? 1 : 0);
  }

  /** The `meta` of the turn currently executing (null between turns). See {@link ask}. */
  getCurrentMeta(): unknown {
    return this.currentMeta;
  }

  /** Stop the session and reject any in-flight or queued turn. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("concierge session stopped"));
      this.pending = null;
    }
    for (const entry of this.turnQueue.splice(0, this.turnQueue.length)) {
      entry.reject(new Error("concierge session stopped"));
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

  private async runTurn(message: TurnMessage, meta?: unknown): Promise<string> {
    if (this.stopped) throw new Error("concierge session stopped");
    if (!this.child) await this.relaunch();
    const child = this.child;
    if (!child) throw new Error("concierge session has no live process");
    this.currentMeta = meta ?? null;
    const outbound = this.consumeSeed(message);

    const turn = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) {
          const acc = this.pending.parts.join("\n\n").trim();
          this.pending = null;
          // The turn is dead but the child may still be streaming into it. Treat the child as
          // compromised (issue #24): kill it so late output can never contaminate the NEXT turn,
          // and so a genuinely hung child doesn't turn every future turn into a timeout. The next
          // ask() resumes the same session — context intact.
          this.recycleChild("turn timeout");
          // Don't hang the human forever — return whatever we have (or a soft nudge).
          resolve(acc || TURN_TIMEOUT_FALLBACK);
        }
      }, TURN_TIMEOUT_MS);
      this.pending = { parts: [], resolve, reject, timer };
      try {
        this.writeUserLine(outbound);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return turn.finally(() => {
      if (this.currentMeta === meta) this.currentMeta = null;
    });
  }

  /**
   * Bring a dead child back mid-life: resume the same session (context intact), unless a failed
   * boot-resume demoted us to a fresh session (then the seed note re-grounds the first turn).
   */
  private async relaunch(): Promise<void> {
    const fresh = this.freshNextLaunch;
    this.freshNextLaunch = false;
    await this.launch(/*resume*/ !fresh);
    this.persistSessionState();
  }

  /** Fold a pending handoff seed into the head of the next outbound turn (fresh-session boot). */
  private consumeSeed(message: TurnMessage): TurnMessage {
    const seed = this.seedPending;
    if (!seed) return message;
    this.seedPending = null;
    const framed = seedFromHandoff(seed);
    if (typeof message === "string") return `${framed}\n\n---\n\n${message}`;
    return [{ type: "text", text: framed }, ...message];
  }

  /** Kill the current child (its session lives on) so the next ask() relaunches with --resume. */
  private recycleChild(reason: string): void {
    const old = this.child;
    this.child = null;
    if (!old) return;
    this.log.warn("recycling concierge child process", { reason, sessionId: this.sessionId });
    try {
      old.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private async launch(isResume: boolean): Promise<void> {
    const bin = this.config.harness.claude.bin;
    const args = this.buildArgs(isResume);
    this.initSeen = false;
    this.lastLaunchWasResume = isResume;

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
    void child.exited.then((code) => this.onExit(code, child));

    // Do NOT await `system/init` here — this claude build emits it only after the first stdin
    // line, so the session is "ready" once spawned. The first ask() writes a line which triggers
    // init + the turn; a dead launch (bad bin/auth) surfaces as that first turn failing.
  }

  // NOTE: the Concierge session stays MCP-free ON PURPOSE (OPS-43): every capability it needs is
  // a `beckett …` CLI command through its Bash tool, which keeps the tool surface auditable and
  // the context lean. Do not add `--mcp-config` here.
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
    // Reasoning effort for the chat seat (issue #25) — a config knob; empty = CLI default.
    const effort = this.config.concierge.effort?.trim();
    if (effort) args.push("--effort", effort);
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

  private async onExit(code: number, exited: Child): Promise<void> {
    // During a rotation we kill the old child on purpose and immediately relaunch under a fresh
    // session id; let rotate() own the child handle so this exit is not mistaken for a crash.
    if (this.rotating) {
      this.log.debug("concierge process exited during rotation (expected)", { code });
      return;
    }
    // A superseded child (timeout recycle, stop, already replaced) — its exit is not ours, and
    // clearing `this.child` here would tear down the CURRENT process (issue #24).
    if (this.child !== exited) {
      this.log.debug("superseded concierge child exited (ignored)", { code });
      return;
    }
    this.child = null;
    if (this.stopped) return;
    this.log.warn("concierge claude process exited", { code, sessionId: this.sessionId });

    // Crash-loop visibility (issue #24): a repeating crash (bad auth, broken config) must reach
    // the ops channel instead of surfacing only as per-message generic failures.
    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes >= CRASH_LOOP_THRESHOLD) {
      this.onCrashLoop?.({ count: this.consecutiveCrashes, code });
    }

    // A `--resume` launch that died before ever initializing means the persisted session is
    // unresumable (deleted transcript, harness drift). Fall back to a FRESH session seeded with
    // the last handoff note — the user re-explains nothing (issue #24).
    if (this.lastLaunchWasResume && !this.initSeen) {
      this.sessionId = crypto.randomUUID();
      this.freshNextLaunch = true;
      if (this.lastHandoff) this.seedPending = this.lastHandoff;
      this.persistSessionState();
      this.log.warn("session resume failed before init — next launch starts fresh, seeded with the last handoff note", {
        newSessionId: this.sessionId,
        hasHandoff: Boolean(this.lastHandoff),
      });
    }

    // The current process is gone; the next ask() relaunches (resume or seeded-fresh). Any
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
          if (line.trim()) this.handleLine(line, child);
        }
      }
      const tail = buf.trim();
      if (tail) this.handleLine(tail, child);
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
  private handleLine(line: string, from: Child): void {
    // Output from a superseded child (a timed-out turn's process still draining) must never
    // touch the CURRENT turn — this was the cross-turn contamination bug (issue #24).
    if (from !== this.child) return;
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
    this.consecutiveCrashes = 0; // a completed turn = the child is healthy again
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
    // Idle → rotate promptly (nothing else will pump the boundary check). Busy → the pump's
    // between-turns maybeRotate picks it up; rotation must never run mid-turn.
    if (!this.pumping && this.turnQueue.length === 0) {
      void this.rotateWhileIdle();
    }
  }

  /** Run the boundary rotation check while the pump is idle (guards against a racing ask()). */
  private async rotateWhileIdle(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.maybeRotate();
    } finally {
      this.pumping = false;
    }
    if (this.turnQueue.length > 0) void this.pump();
  }

  /**
   * Between turns: rotate to a fresh session when EITHER the context crossed the ceiling
   * (auto-compaction, issue #5) OR a persona reload was requested. Both re-read the persona on
   * relaunch; reload is the manual, retune-now trigger.
   */
  private async maybeRotate(): Promise<void> {
    if (this.stopped || this.rotating) return;
    const reload = this.reloadPending;
    if (!reload) {
      if (this.lastContextTokens < this.rotateAtTokens) return;
      // A rotation just failed — don't re-pay the expensive handoff turn after EVERY subsequent
      // turn while over the ceiling; retry after a cooldown (issue #24).
      if (Date.now() - this.rotateFailedAt < ROTATE_RETRY_COOLDOWN_MS) return;
    }
    this.reloadPending = false;
    try {
      await this.rotate(reload ? "persona reload" : "context ceiling");
      this.rotateFailedAt = 0;
    } catch (err) {
      // A failed rotation must not wedge the session — keep serving on the old session.
      this.rotateFailedAt = Date.now();
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
    // Persist the new identity + handoff so a deploy right after this rotation still resumes —
    // and if the resume fails, the fresh session re-grounds from this same note (issue #24).
    if (summary) this.lastHandoff = summary;
    this.rotations += 1;
    this.persistSessionState();
    this.log.info("concierge re-grounding complete", { reason, from: oldSession, to: this.sessionId });
  }

  /** Session health for `beckett status` (issue #30): identity, context pressure, crash/rotation counts. */
  stats(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      model: this.model,
      contextTokens: this.lastContextTokens,
      rotateAtTokens: this.rotateAtTokens,
      rotations: this.rotations,
      queueDepth: this.queueDepth(),
      consecutiveCrashes: this.consecutiveCrashes,
    };
  }

  // ── restart persistence (issue #24) ─────────────────────────────────────────────────────

  /** Where the session identity + last handoff live (`~/.beckett/concierge-session.json`). */
  private sessionStateFile(): string {
    return join(buildPaths(this.config).beckettDir, "concierge-session.json");
  }

  private loadSessionState(): { sessionId: string; handoff: string } | null {
    try {
      const raw = readFileSync(this.sessionStateFile(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.sessionId === "string" && parsed.sessionId.trim()) {
        return {
          sessionId: parsed.sessionId.trim(),
          handoff: typeof parsed.handoff === "string" ? parsed.handoff : "",
        };
      }
    } catch {
      /* first boot / unreadable — start fresh */
    }
    return null;
  }

  private persistSessionState(): void {
    try {
      const file = this.sessionStateFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ sessionId: this.sessionId, handoff: this.lastHandoff, savedAt: Date.now() }, null, 2),
      );
    } catch (err) {
      this.log.warn("concierge session state write failed", { err: String(err) });
    }
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
  /** Plane read access for milestone enrichment (issue #21) — the shared PlaneClient in prod. */
  plane?: { listComments(ticketId: string): Promise<PlaneComment[]> };
  /** Inject the ambient triage classifier (tests); defaults to the real one-shot Haiku classifier. */
  ambientTriage?: TriageFn;
  /** Inject the ambient clock (tests); defaults to the coordinator's real-timer clock. */
  ambientClock?: AmbientClock;
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
   * Dispatcher levers wired in AFTER construction (v3-main creates the Concierge first so its
   * progress sink can feed the dispatcher). Serves `beckett ticket restaff` from the control bus
   * (issue #21). Null until wired — the bus op then answers with a clear "not available" error.
   */
  private dispatcherOps: {
    restaff(id: string, harness?: string): Promise<{ ticket: string; stage: string; harness?: string }>;
  } | null = null;
  /**
   * Daemon-wide status assembler wired in by v3-main (issue #30): answers the `status` bus command
   * with poller/dispatcher/Plane health the Concierge can't see itself. Null until wired — the bus
   * command then answers with the Concierge-local half only.
   */
  private statusProvider: (() => Record<string, unknown> | Promise<Record<string, unknown>>) | null = null;
  /**
   * Fired on every `ticket.filed` bus ping (issue #33): v3-main wires this to `poller.poke()` so a
   * freshly-filed `in_progress` ticket is staffed in well under a second instead of waiting out
   * the 0–5s poll gap. Best-effort — filing never depends on it.
   */
  private ticketFiledListener: (() => void) | null = null;
  /**
   * Plane read access for milestone enrichment (issue #21): the poller stops collecting comments
   * on terminal tickets, so the `done` ping fetches the dispatcher's done comment here to carry
   * the artifact/PR link. Optional — absent (tests), the ping falls back to the ticket URL only.
   */
  private readonly plane: { listComments(ticketId: string): Promise<PlaneComment[]> } | null;
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
    /** True iff the speaker on THIS turn is the owner — the code-side gate for `proactivity set … auto`. */
    isOwner: boolean;
    repliedViaCli: boolean;
    /** Id of the ack message the Concierge posted this turn — the thread anchor (null until posted). */
    ackMessageId: string | null;
    /** Tickets filed during this turn (via `beckett ticket create`/`plan`), awaiting a thread anchor. */
    pendingTickets: { identifier: string; title: string }[];
    /** True for an ambient (un-addressed) turn: a CLI reply posts plainly, never as a native reply. */
    ambient?: boolean;
  } | null = null;
  /** Last static denial by channel+user, so denied DMs/mentions cannot spam Discord. */
  private readonly accessDenyAt = new Map<string, number>();
  /**
   * The ambient-interjection coordinator (proposal §4). Owns per-channel ring buffers, debounce,
   * cooldowns, and the offer ledger; calls back into {@link runAmbientTurn} to run a session turn.
   * Undefined when `config.proactivity` is absent (partial test configs) — every use is guarded.
   */
  private readonly ambient?: AmbientCoordinator;
  /**
   * Per-channel watermark: the id of the last ring-buffer message already surfaced to the session
   * (via a mention-turn prepend or an ambient turn), so a later mention doesn't re-show it.
   */
  private readonly ambientSeen = new Map<string, string>();

  constructor(opts: ConciergeOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.log = (opts.logger ?? rootLog).child("concierge");
    this.gateway = opts.gateway ?? createDiscordGateway({ config: this.config, logger: this.log });
    this.session =
      opts.session ??
      new ConciergeSession({
        config: this.config,
        logger: this.log,
        // Crash-loop alarm (issue #24): a repeating child crash (bad auth/config) pings the ops
        // channel instead of surfacing only as per-message "something broke" replies.
        onCrashLoop: (info) => {
          void this.gateway
            .post(
              process.env.BECKETT_STARTUP_CHANNEL_ID?.trim() || STARTUP_CHANNEL_ID,
              `⚠️ My chat session has crashed ${info.count}× in a row (last exit code ${info.code}). ` +
                `Probably auth or config — check \`journalctl --user -u beckett-v3\`.`,
            )
            .catch(() => undefined);
        },
      });
    this.plane = opts.plane ?? null;
    this.progress = createProgressHub(this.gateway, this.log, {
      stateFile: progressStateFile(this.config, this.log),
    });
    // Ambient interjection (proposal §4). Only wired when the config carries a `[proactivity]`
    // block; ships with `enabled=false`, so the coordinator records ring buffers but never triages.
    if (this.config.proactivity) {
      this.ambient = createAmbientCoordinator({
        config: this.config,
        logger: this.log.child("ambient"),
        clock: opts.ambientClock,
        triage:
          opts.ambientTriage ??
          createTriageClassifier({
            model: this.config.proactivity.triage_model,
            logger: this.log.child("triage"),
          }),
        engage: (turn) => this.runAmbientTurn(turn),
      });
    }
  }

  /** Wire the dispatcher levers (v3-main, after the dispatcher exists). See {@link dispatcherOps}. */
  setDispatcherOps(ops: NonNullable<Concierge["dispatcherOps"]>): void {
    this.dispatcherOps = ops;
  }

  /** Wire the daemon-wide status assembler (v3-main, issue #30). See {@link statusProvider}. */
  setStatusProvider(fn: NonNullable<Concierge["statusProvider"]>): void {
    this.statusProvider = fn;
  }

  /** Wire the instant-tick hook for freshly-filed tickets (v3-main, issue #33). See {@link ticketFiledListener}. */
  setTicketFiledListener(fn: NonNullable<Concierge["ticketFiledListener"]>): void {
    this.ticketFiledListener = fn;
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
    this.ambient?.stop();
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
    const active = this.currentMention();
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
   * The mention whose session turn is EXECUTING RIGHT NOW (issue #24): CLI replies and
   * `ticket.filed` signals are correlated to the turn that issued them, not to whichever mention
   * most recently overwrote a shared slot. Sourced from the session's turn meta; falls back to
   * {@link activeMention} for injected fake sessions that don't track meta.
   */
  private currentMention(): NonNullable<Concierge["activeMention"]> | null {
    const meta = this.session.getCurrentMeta?.() as Concierge["activeMention"] | undefined;
    if (meta && typeof meta.channelId === "string" && typeof meta.messageId === "string") {
      return meta;
    }
    if (typeof this.session.getCurrentMeta === "function") return null; // real session, no mention turn running
    return this.activeMention;
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
      // Instant tick (issue #33): the dispatcher staffs the fresh ticket now, not in ≤5s.
      try {
        this.ticketFiledListener?.();
      } catch {
        /* best-effort — filing never depends on the poke */
      }
      return { ok: true, data: { tracked: true } };
    }
    if (req.cmd === "status") {
      // "Is prod healthy and what is it doing right now?" in one bus round-trip (issue #30). The
      // daemon-wide half (uptime/version/poller/workers/Plane) comes from the provider v3-main
      // wires in; the Concierge adds the halves only it can see (Discord gateway, its session).
      try {
        const base = this.statusProvider ? await this.statusProvider() : {};
        return {
          ok: true,
          data: {
            ...base,
            discord: {
              connected: this.gateway.isConnected(),
              lastEventAgeMs: this.gateway.lastEventAgeMs(),
            },
            concierge: this.session.stats(),
          },
        };
      } catch (err) {
        return { ok: false, error: `status assembly failed: ${(err as Error).message}` };
      }
    }
    if (req.cmd === "ticket.restaff") {
      // Operator lever (issue #21): abort a ticket's worker (WIP committed) and spawn a fresh one,
      // optionally on a different harness. Routed to the dispatcher wired in by v3-main.
      if (!this.dispatcherOps) {
        return { ok: false, error: "restaff unavailable — the dispatcher is not wired (v3 daemon only)" };
      }
      const id = typeof req.args.id === "string" ? req.args.id.trim() : "";
      if (!id) return { ok: false, error: "usage: beckett ticket restaff <id> [--harness claude|codex|pi]" };
      const harness = typeof req.args.harness === "string" && req.args.harness.trim()
        ? req.args.harness.trim()
        : undefined;
      try {
        const r = await this.dispatcherOps.restaff(id, harness);
        return { ok: true, data: r };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    if (req.cmd === "proactivity.status") {
      // "What's my ambient-interjection posture right now?" — effective per-channel mode, the
      // hard caps, and any live offers awaiting consent (§4.6). Pure read; never mutates.
      return { ok: true, data: this.proactivityStatus() };
    }
    if (req.cmd === "proactivity.set") {
      const channelId = typeof req.args.channelId === "string" ? req.args.channelId.trim() : "";
      const mode = typeof req.args.mode === "string" ? req.args.mode.trim() : "";
      if (!channelId || (mode !== "off" && mode !== "suggest" && mode !== "auto")) {
        return { ok: false, error: "usage: beckett proactivity set <channel-id> off|suggest|auto" };
      }
      // Owner gate on `auto` (proceed-on-silence) — enforced HERE in code, never left to the model
      // (§4.6). It requires the speaker on the requesting turn to be the owner; a turn issued by
      // anyone else (or a manual CLI call with no live turn) can flip a channel off/suggest but not auto.
      if (mode === "auto" && !this.currentMention()?.isOwner) {
        return {
          ok: false,
          error: "auto (proceed-on-silence) is owner-only — only the owner can arm it on a channel",
        };
      }
      const overrideFile = join(buildPaths(this.config).beckettDir, "proactivity.json");
      try {
        setChannelModeOverride(overrideFile, channelId, mode as ProactivityMode);
      } catch (err) {
        return { ok: false, error: `failed to persist proactivity override: ${(err as Error).message}` };
      }
      // Mutate the in-memory config IN PLACE. The coordinator (once wired) holds a reference to this
      // very `proactivity` object, so the change takes effect live — no reload, no restart.
      this.config.proactivity.channels[channelId] = mode as ProactivityMode;
      return { ok: true, data: { channelId, mode, effective: this.effectiveProactivityMode(channelId) } };
    }
    if (req.cmd === "proactivity.off") {
      // The global kill switch: flip runtime `enabled` false, silencing every channel at once.
      const overrideFile = join(buildPaths(this.config).beckettDir, "proactivity.json");
      try {
        setEnabledOverride(overrideFile, false);
      } catch (err) {
        return { ok: false, error: `failed to persist proactivity kill switch: ${(err as Error).message}` };
      }
      this.config.proactivity.enabled = false;
      return { ok: true, data: { enabled: false, killed: true } };
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
      // If this reply is issued BY the @mention turn it's answering, claim that turn: post it as a
      // native reply to the originating message and mark the turn handled so onMessage won't also
      // auto-post the turn text (the duplicate-message bug). Correlated to the turn EXECUTING now
      // (issue #24) — a queued second mention or a notify() update turn can never steal the claim.
      const active = this.currentMention();
      const claimsActiveTurn = !!active && active.channelId === channelId;
      const opts = {
        // A native reply is right for an @mention (answering THAT message), but an ambient turn
        // posts plainly — replying-to an un-addressed message reads as surveillance (§4.4).
        ...(claimsActiveTurn && !active!.ambient ? { replyToMessageId: active!.messageId } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      // A long reply may land as several human-cadence messages (OPS-62); `post` returns the FIRST
      // message id (the reply-correlation anchor), so `data.messageId` keeps its single-id contract.
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

  /** The effective ambient mode for a channel: `off` whenever proactivity is disabled globally,
   *  else the per-channel override, else the default. Mirrors `AmbientCoordinator.effectiveMode`
   *  but reads the Concierge's own config so `status` works whether or not the coordinator is wired. */
  private effectiveProactivityMode(channelId: string): ProactivityMode {
    const p = this.config.proactivity;
    if (!p.enabled) return "off";
    return p.channels[channelId] ?? p.default_mode;
  }

  /** Assemble the `beckett proactivity status` payload: master switch, per-channel effective modes,
   *  the hard caps, and the live offers awaiting consent (read from the persisted ledger). */
  private proactivityStatus(): Record<string, unknown> {
    const p = this.config.proactivity;
    const now = Date.now();
    const offersFile = join(buildPaths(this.config).beckettDir, "pending-offers.json");
    const liveOffers = readPersistedOffers(offersFile)
      .filter((o) => o.expiresAt > now)
      .map((o) => ({
        channelId: o.channelId,
        summary: o.summary,
        mode: o.mode,
        expiresInSecs: Math.max(0, Math.round((o.expiresAt - now) / 1000)),
      }));
    return {
      enabled: p.enabled,
      defaultMode: p.default_mode,
      channels: Object.entries(p.channels).map(([channelId, mode]) => ({
        channelId,
        mode,
        effective: this.effectiveProactivityMode(channelId),
      })),
      caps: {
        triageModel: p.triage_model,
        triageThreshold: p.triage_threshold,
        burstQuietSecs: p.burst_quiet_secs,
        channelCooldownSecs: p.channel_cooldown_secs,
        maxInterjectionsPerHour: p.max_interjections_per_hour,
        offerTtlSecs: p.offer_ttl_secs,
        transcriptWindow: p.transcript_window,
      },
      liveOffers,
    };
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
    // Frame every worth-surfacing event first (`done` frames async — it fetches the artifact
    // link, issue #21), then fold the whole poll batch into ONE session turn (issue #25): a DAG
    // wave of milestones costs one full-context turn, not one per event.
    const frames: Promise<string | null>[] = [];
    const idents: string[] = [];
    for (const event of batch) {
      if (event.kind === "state_changed" && event.to === "done") {
        frames.push(
          this.buildDoneUpdate(event.ticket).catch((err) => {
            this.log.warn("done-update framing failed (skipped)", { err: String(err) });
            return null;
          }),
        );
        idents.push(event.ticket.identifier);
        continue;
      }
      const framed = this.frameUpdate(event);
      if (!framed) continue; // not worth surfacing, or no channel to route back to
      frames.push(Promise.resolve(framed));
      idents.push(event.ticket.identifier);
    }
    if (frames.length === 0) return;
    void Promise.all(frames).then((resolved) => {
      const updates = resolved.filter((u): u is string => Boolean(u));
      if (updates.length === 0) return;
      const combined = updates.length === 1 ? updates[0]! : combineUpdateTurns(updates);
      this.askUpdate(combined, idents.join(","));
    });
  }

  /**
   * Run one update turn without blocking the poll loop; retry ONCE on failure, then log loudly
   * with the ticket id (issue #24 — a silently dropped milestone breaks the closed loop).
   */
  private askUpdate(framed: string, ticketIdent: string): void {
    void this.session.ask(framed).catch(() =>
      this.session.ask(framed).catch((err) =>
        this.log.warn("concierge update turn dropped after retry", {
          ticket: ticketIdent,
          err: String(err),
        }),
      ),
    );
  }

  /**
   * Frame the `done` milestone WITH the artifact link (issue #21): the poller stops collecting
   * comments on terminal tickets, so the dispatcher's own done comment (which carries the
   * "Shipped:"/"PR opened:" URL) never arrives as a comment event. Fetch it here so the payoff
   * message of the whole pipeline is "done: <link>", not a bare "done". Best-effort: without a
   * Plane client (tests) or a parseable link, degrade to the plain done ping + ticket URL.
   */
  private async buildDoneUpdate(ticket: Ticket): Promise<string | null> {
    let detail = `Review passed — ticket is **done**.`;
    try {
      const comments = (await this.plane?.listComments(ticket.id)) ?? [];
      const doneComment = [...comments].reverse().find((c) => isDispatcherComment(c));
      const link = doneComment ? artifactLinkFrom(stripCommentMarker(doneComment.body)) : null;
      if (link) detail += `\nArtifact: ${link}`;
    } catch (err) {
      this.log.debug("done-link fetch failed (plain done ping)", { err: String(err) });
    }
    if (ticket.url) detail += `\nTicket: ${ticket.url}`;
    detail += `\nInclude the artifact link in your reply so the person can click straight through.`;
    return this.updateTurn(ticket, detail);
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
      // Known-noise shapes (issue #25): a full Opus turn concluding "do nothing" is a waste —
      // pre-filter cheaply, but log so nothing is invisibly dropped.
      if (isRoutineNoiseComment(body)) {
        this.log.debug("routine dispatcher comment not surfaced", {
          ticket: event.ticket.identifier,
          head: body.slice(0, 80),
        });
        return null;
      }
      return this.updateTurn(event.ticket, body);
    }
    if (event.kind === "cancelled") {
      return this.updateTurn(event.ticket, `Ticket was cancelled.`);
    }
    // Boot recovery (issue #21): the poller's prime emits `from: null` for tickets that were
    // mid-flight when the daemon went down and are being re-staffed. Tell the person instead of
    // leaving it a journal-only warning — but let the Concierge judge (a routine redeploy restart
    // doesn't need a ping per ticket).
    if (
      event.kind === "state_changed" &&
      event.from === null &&
      (event.to === "in_progress" || event.to === "in_review")
    ) {
      const stage = event.to === "in_review" ? "review" : "implementation";
      return this.updateTurn(
        event.ticket,
        `The daemon restarted while this ticket was mid-${stage}; I'm re-staffing it so the work ` +
          `continues from its committed progress. If you've already told this channel about this ` +
          `restart (or it was a routine redeploy), skip the ping.`,
      );
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
   * Handle one inbound Discord message. A message that addresses us (an @mention or a DM — the
   * gateway folds both into `mentionsBot`) runs a session turn. Everything else is *ambient*: it
   * flows to the {@link ambient} coordinator (ring buffer + debounce + triage), never awaited into
   * the mention path and never able to throw out of it (`observe` swallows its own errors). A
   * mention also cancels any pending burst flush for its channel so we can't double-respond — the
   * mention turn already carries the transcript (§4.4). Failures are isolated so a bad turn can
   * never take down the gateway. Public: it is an external entrypoint (the gateway calls it) and is
   * exercised directly in tests.
   */
  async onMessage(m: IncomingMessage): Promise<void> {
    if (!m.mentionsBot) {
      this.ambient?.observe(m, this.accessLevelFor(m.userId));
      return;
    }
    this.ambient?.noteMention(m.channelId);
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
      isOwner: this.ownerId() !== undefined && m.userId === this.ownerId(),
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

    // Fast ack (issue #24): the session is single-flight, so a mention landing while a turn is
    // running (or queued) would sit for minutes behind only a typing indicator. Acknowledge
    // within seconds — code-level, no model turn.
    if ((this.session.queueDepth?.() ?? 0) > 0) {
      void this.gateway
        .post(m.channelId, FAST_ACK_TEXT, { replyToMessageId: m.messageId })
        .catch(() => undefined);
    }

    try {
      const turn = await this.buildTurn(m, content);
      // The mention rides as the turn's meta so CLI replies correlate to THIS turn (issue #24);
      // person turns take PRIORITY over queued ticket-update turns (issue #25).
      const reply = await this.session.ask(turn, mention, { priority: true });
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
    // Mention-path win (§4.4): a mention like "do that" after five un-mentioned messages is a riddle
    // unless the session sees the lead-up. Prepend the channel's ring-buffer excerpt the session
    // hasn't seen yet (a free UX win even in `off`-mode channels — the buffer fills regardless).
    const prefix = this.ambientContextPrefix(m.channelId);
    if (m.attachments.length === 0)
      return prefix + frameUserTurn(m.channelId, speaker, m.messageId, content);
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
    const framed = prefix + frameUserTurn(m.channelId, speaker, m.messageId, body);
    // No inlinable image → the turn is a plain string, byte-for-byte as text-only turns always were.
    if (images.length === 0) return framed;
    // Otherwise: a text block (framed message + any non-image manifest) followed by the image blocks.
    return [{ type: "text", text: framed }, ...images];
  }

  /**
   * Run one ambient (un-addressed) session turn — the `engage` callback the {@link ambient}
   * coordinator invokes for a candidate/consent/timeout (proposal §4.4). It differs from the
   * mention path deliberately: NO typing indicator and NO fast-ack (Beckett doesn't telegraph that
   * it's "considering" speaking), and the turn is queued NON-priority so real mentions and ticket
   * updates jump ahead. The reply is auto-posted as a PLAIN message (no `replyToMessageId`) UNLESS
   * the model returns the `PASS` sentinel — then nothing is posted and the cooldown is left
   * unconsumed (the coordinator inspects the returned text). On a real post for a candidate we arm
   * the offer ledger via {@link AmbientCoordinator.recordOffer} (TTL + cooldown); a consent turn
   * that actually replies closes its offer window. The returned string is what the coordinator sees
   * (so `PASS` must survive verbatim). If the model answered via `beckett discord reply` instead,
   * the reply-claim below suppresses the auto-post exactly as it does for a mention.
   */
  private async runAmbientTurn(turn: AmbientTurn): Promise<string> {
    const framed = this.frameAmbientTurn(turn);
    // These messages are now in front of the session — don't re-prepend them on the next mention.
    this.markAmbientSeen(turn.channelId, turn.transcript);
    const claim = {
      channelId: turn.channelId,
      messageId: ambientAnchorId(turn),
      repliedViaCli: false,
      ackMessageId: null as string | null,
      pendingTickets: [] as { identifier: string; title: string }[],
      ambient: true,
    };
    this.activeMention = claim;
    try {
      const reply = (await this.session.ask(framed, claim, { priority: false })).trim();
      // PASS (alone, first line) → post nothing, consume no cooldown. Return it verbatim so the
      // coordinator sees the sentinel and skips its own cooldown stamp.
      if (isAmbientPass(reply)) return reply;
      // The model may have already posted via the CLI (consent turns are told to ack that way); the
      // reply-claim marked `repliedViaCli` and captured the message id — don't post a second time.
      const postedId = claim.repliedViaCli
        ? claim.ackMessageId
        : reply
          ? await this.gateway.post(turn.channelId, reply)
          : null;
      if (turn.kind === "candidate") {
        this.armAmbientOffer(turn, postedId, reply);
      } else if (turn.kind === "consent" && !isAmbientPass(reply)) {
        // A real answer to a consent prompt resolves the offer — close the window (accept or
        // decline). An unrelated/ambiguous message would have been a PASS and kept it open.
        this.ambient?.clearOffer(turn.channelId);
      }
      return reply;
    } finally {
      if (this.activeMention === claim) this.activeMention = null;
    }
  }

  /** Arm the offer ledger for a candidate turn that actually posted (TTL + channel cooldown). */
  private armAmbientOffer(
    turn: Extract<AmbientTurn, { kind: "candidate" }>,
    postedId: string | null,
    reply: string,
  ): void {
    if (!this.ambient) return;
    const source = turn.burst[turn.burst.length - 1] ?? turn.transcript[turn.transcript.length - 1];
    const mode = this.ambient.effectiveMode(turn.channelId);
    this.ambient.recordOffer(turn.channelId, {
      offerMessageId: postedId ?? source?.messageId ?? "",
      offerText: reply,
      sourceUserId: source?.userId ?? "",
      summary: turn.verdict.reason || reply.slice(0, 200),
      mode: mode === "auto" ? "auto" : "suggest",
    });
  }

  /** Build the SYSTEM frame for an ambient turn (candidate / consent follow-up / silence timeout). */
  private frameAmbientTurn(turn: AmbientTurn): string {
    const ttlSecs = this.config.proactivity?.offer_ttl_secs ?? 600;
    switch (turn.kind) {
      case "candidate":
        return frameAmbientCandidate(turn.channelId, turn.transcript, turn.verdict);
      case "consent": {
        const speaker = this.resolveSpeaker(turn.message);
        const userFrame = frameUserTurn(
          turn.channelId,
          speaker,
          turn.message.messageId,
          turn.message.content.trim(),
        );
        const elapsedSecs = Math.max(0, Math.round(ttlSecs - (turn.offer.expiresAt - Date.now()) / 1000));
        return frameAmbientConsent(turn.offer.offerText, userFrame, elapsedSecs);
      }
      case "timeout":
        return frameAmbientTimeout(turn.channelId, turn.offer.offerText, ttlSecs);
    }
  }

  /**
   * The ring-buffer excerpt to prepend to a mention turn: the messages in this channel the session
   * hasn't seen yet (advancing the per-channel watermark). Empty string when there's nothing new
   * (or no coordinator), so the mention turn is byte-for-byte unchanged.
   */
  private ambientContextPrefix(channelId: string): string {
    const unseen = this.takeUnseenAmbient(channelId);
    if (unseen.length === 0) return "";
    return (
      `SYSTEM (context — recent messages in this channel you haven't seen):\n` +
      `[channel:${channelId}]\n${ambientTranscriptLines(unseen)}\n\n`
    );
  }

  /** Ring-buffer entries after the seen-watermark; advances the watermark to the newest entry. */
  private takeUnseenAmbient(channelId: string): AmbientTranscriptMessage[] {
    if (!this.ambient) return [];
    const transcript = this.ambient.getTranscript(channelId);
    if (transcript.length === 0) return [];
    const watermark = this.ambientSeen.get(channelId);
    let start = 0;
    if (watermark) {
      const idx = transcript.findIndex((mm) => mm.messageId === watermark);
      // Watermark aged out of the ring → everything is unseen; else start just past it.
      start = idx >= 0 ? idx + 1 : 0;
    }
    this.ambientSeen.set(channelId, transcript[transcript.length - 1]!.messageId);
    return transcript.slice(start);
  }

  /** Advance the seen-watermark to the newest entry that was just surfaced to the session. */
  private markAmbientSeen(channelId: string, transcript: AmbientTranscriptMessage[]): void {
    const last = transcript[transcript.length - 1];
    if (last) this.ambientSeen.set(channelId, last.messageId);
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

/** `HH:MM` (UTC) for an ambient transcript stamp — matches the triage classifier's time format. */
function hhmm(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** Render a ring-buffer excerpt as indented `[HH:MM] Name: text` lines for a SYSTEM frame. */
function ambientTranscriptLines(transcript: AmbientTranscriptMessage[]): string {
  if (transcript.length === 0) return "  (no recent messages)";
  return transcript.map((m) => `  [${hhmm(m.ts)}] ${m.authorDisplayName}: ${m.content}`).join("\n");
}

/** Best-effort correlation anchor for an ambient turn's reply-claim (never a native reply target). */
function ambientAnchorId(turn: AmbientTurn): string {
  if (turn.kind === "consent") return turn.message.messageId;
  if (turn.kind === "timeout") return turn.offer.offerMessageId;
  return turn.burst[turn.burst.length - 1]?.messageId ?? turn.channelId;
}

/**
 * The ambient-candidate frame (§4.5): overheard chatter Beckett is *choosing* whether to speak to.
 * PASS-by-default; a reply is ONE line offering concrete work or a concrete answer, never a ticket.
 */
function frameAmbientCandidate(
  channelId: string,
  transcript: AmbientTranscriptMessage[],
  verdict: TriageVerdict,
): string {
  return (
    `SYSTEM (ambient — nobody addressed you; you are choosing whether to speak):\n` +
    `[channel:${channelId}] recent conversation:\n${ambientTranscriptLines(transcript)}\n` +
    `Triage says: ${verdict.kind} (confidence ${verdict.confidence.toFixed(2)}).\n` +
    `If you have a CONCRETE offer or answer, reply with ONE short message in your voice.\n` +
    `If not — and when in doubt — reply with exactly: PASS\n` +
    `Do not file a ticket yet. An offer is a question, not a commitment.`
  );
}

/**
 * The consent follow-up frame (§4.5): a new message arrived in a channel with a live offer. The
 * model judges whether it accepts (ack + file the ticket), declines/unrelated (PASS), or is a
 * fresh ambient candidate on its own.
 */
function frameAmbientConsent(offerText: string, userFrame: string, elapsedSecs: number): string {
  return (
    `SYSTEM (ambient follow-up): you offered in this channel ${elapsedSecs}s ago:\n` +
    `  "${offerText}"\n` +
    `${userFrame}\n` +
    `If this accepts your offer: ack via \`beckett discord reply\`, then file the ticket exactly as\n` +
    `you would for a direct request (--channel stamped). If it declines or is unrelated to your\n` +
    `offer: reply PASS. If it's unrelated but ambient-worthy on its own, treat it as a fresh\n` +
    `candidate.`
  );
}

/**
 * The silence-consent frame (§4.5, `auto` mode only): an offer aged out with no reply in a
 * proceed-on-silence channel. Post a one-line heads-up and file the ticket, or PASS if stale.
 */
function frameAmbientTimeout(channelId: string, offerText: string, ttlSecs: number): string {
  const mins = Math.max(1, Math.round(ttlSecs / 60));
  return (
    `SYSTEM (ambient timeout): your offer "${offerText}" in [channel:${channelId}] got no reply in ${mins} minutes.\n` +
    `This channel is set to proceed-on-silence. If the work is still sensible, post a one-line\n` +
    `heads-up ("no objection, so I'm running with the CSV export thing") and file the ticket.\n` +
    `If the moment has passed, PASS.`
  );
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
 * Fold several already-framed update turns into ONE session turn (issue #25). Each frame carries
 * its own ticket/channel/reply instructions; the wrapper tells the model to handle them together
 * and group same-channel notes into one message.
 */
function combineUpdateTurns(updates: string[]): string {
  const items = updates.map((u, i) => `--- update ${i + 1} of ${updates.length} ---\n${u}`).join("\n\n");
  return (
    `SYSTEM (automated ticket updates — ${updates.length} in this batch; NOT from a user):\n` +
    `Handle ALL of the following in this one turn. Group updates for the same channel into a ` +
    `single message; skip the routine ones; reply via \`beckett discord reply\` per the ` +
    `instructions inside each update.\n\n${items}`
  );
}

/**
 * Pull the artifact/PR link out of a dispatcher done comment (issue #21). The comment says
 * "Shipped: <url>" or "PR opened (needs your merge): <url>"; prefer a GitHub URL over any other
 * (a public site URL may also appear), else take the first URL. Null when the comment has none.
 */
export function artifactLinkFrom(body: string): string | null {
  const urls = body.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
  if (urls.length === 0) return null;
  return urls.find((u) => u.includes("github.com")) ?? urls[0]!;
}

/**
 * True for the dispatcher's "Implementation complete → in_review" advance — the intermediate step we
 * deliberately don't ping the person about (they already have an ack; `done` pings next). Keyed on
 * the `→ in_review` transition ARROW so it never matches the rework-cap human-handoff ("leaving this
 * in in_review for a human", no arrow) or the "→ done"/"→ in_progress" comments, which must surface.
 */
/**
 * Routine dispatcher narration that never needs a person's attention (issue #25): a DAG node
 * starting because its blockers cleared, and bounded retry heartbeats. The interesting outcomes
 * (verdicts, parks, errors, stalls, done) still surface.
 */
export function isRoutineNoiseComment(body: string): boolean {
  return (
    /all blockers done.*starting now/i.test(body) ||
    /retrying\s*(?:in \d+\w*\s*)?\(attempt \d+\/\d+\)/i.test(body)
  );
}

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
