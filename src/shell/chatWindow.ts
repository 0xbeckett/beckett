/**
 * Beckett — Haiku chat layer with a file-backed rolling context window (`src/shell/chatWindow.ts`)
 * ===============================================================================================
 * The conversational front. A plain mention from an owner/member hits a STATELESS Haiku `claude -p`
 * call first. Haiku either answers light conversational turns directly, or emits a HANDOFF sentinel
 * so the caller wakes the Sonnet/Opus parent for real work (the "chat layer + clean handoff" role).
 *
 * Why stateless + a file instead of `claude -p --resume`:
 *   print-mode sessions cannot be compacted, so a long-lived conversational session grows unbounded
 *   and eventually blows past the context window. So the SHELL owns the memory, not claude. Each turn:
 *     1. read a bounded rolling window from a per-channel file,
 *     2. feed it as the prompt to a fresh (stateless) Haiku call,
 *     3. append the new exchange to the file and trim it back to the window.
 *   Nothing accumulates inside claude; the file is the memory and it is always bounded.
 *
 * The model call is injectable ({@link ChatWindowDeps.run}) so the windowing/handoff logic is unit
 * testable without spawning a real model.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../types.ts";

/** Exact sentinel Haiku must emit (and nothing else) to punt a turn to the parent. */
export const HANDOFF = "[[HANDOFF]]";

/** Sentinel Haiku emits (ambient mode only) to decline to speak at all. */
export const SILENT = "[[SILENT]]";

/**
 * How a turn reached Beckett:
 *  - "mention": directly @-ed or replied-to — Beckett MUST answer or hand off, never stay silent.
 *  - "ambient": overheard chatter (no ping) — Beckett may also stay SILENT, and defaults to it.
 */
export type ChatMode = "mention" | "ambient";

/** Exchanges kept in the rolling window (one exchange = a User line + a Beckett line). */
const DEFAULT_MAX_TURNS = 12;

/** Hard ceiling on a single Haiku call; a hung child never wedges the inject chain. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ChatWindowDeps {
  /** claude binary (config.harness.claude.bin). */
  bin: string;
  /** Front-door model (config.models.front_door — Haiku). */
  model: string;
  /** Directory for per-channel window files (e.g. `~/.beckett/chat`). */
  dir: string;
  /** Short voice line injected into the system prompt so replies sound like Beckett. */
  persona: string;
  logger: Logger;
  /** Exchanges retained in the window. Default {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
  /** Per-call timeout. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable model call. Defaults to a real `claude -p` spawn. See {@link HaikuRun}. */
  run?: HaikuRun;
}

/**
 * One Haiku invocation's result:
 *  - `finalText`: the model's plain final assistant text (used only for sentinel detection).
 *  - `cliReply`: the message Haiku actually delivered via `beckett discord reply`, if it called it.
 */
export interface HaikuOutput {
  finalText: string;
  cliReply?: string;
}
export type HaikuRun = (prompt: string, system: string) => Promise<HaikuOutput>;

/**
 * Outcome of one turn:
 *  - `reply`: post-worthy. `delivered` is true when Haiku already sent it via the CLI; false means
 *    the shell must deliver `reply` itself (the safety net for when Haiku skipped the command).
 *  - `handoff`: wake the parent.
 *  - `silent`: (ambient only) say nothing.
 */
export type ChatResult =
  | { kind: "reply"; reply: string; delivered: boolean }
  | { kind: "handoff" }
  | { kind: "silent" };

// CRITICAL DELIVERY CONTRACT — same hard rule the parent lives under: plain assistant text is
// DISCARDED. The ONLY way Haiku's words reach a human is the beckett reply CLI. This must be
// stated or the chat layer silently does nothing.
const DELIVERY = `HOW YOU SPEAK — READ FIRST. Your plain text output is discarded; nobody sees it. The ONLY way to say anything to a human is to run, via the Bash tool:
  beckett discord reply --channel <CHANNEL_ID> "<your message>"
Use the channel id given in the incoming message. If you want to say something, you MUST run that command — writing the message as plain text delivers NOTHING. Keep the message itself short and in voice.`;

const SHARED_HANDOFF = `You do NOT do real work. The instant a message needs ANY of: writing/reading/editing code, running commands, deploying, GitHub, memory/recall, multi-step tasks, anything with side effects, OR anything you are not fully sure you can answer correctly on your own — you MUST hand off. To hand off, do NOT reply at all — output EXACTLY this token as your plain final text and nothing else:
${HANDOFF}
Bias HARD toward handoff when unsure. Half-answering a real task is far worse than handing off a simple one.`;

/**
 * Build the Haiku system prompt for the given mode. The delivery contract (reply via the beckett
 * CLI), the handoff contract, the silence contract, and the persona all travel together so the
 * routing rules stay in one place.
 */
export function chatSystemPrompt(persona: string, mode: ChatMode): string {
  const voice = `Sound like Beckett: ${persona}`;
  if (mode === "ambient") {
    return `You are Beckett's conversational front (Haiku), OVERHEARING a Discord channel. You were NOT directly addressed.

${DELIVERY}

DEFAULT TO SILENCE. For the vast majority of overheard messages you should say nothing and call NO command — instead output EXACTLY this token as your plain final text and nothing else:
${SILENT}

Only break silence (by running the reply command) when it clearly adds value and is clearly welcome: someone refers to you ("beckett ...") by name, a question you can answer in one line, or a live back-and-forth you're already part of. Never butt into a conversation that isn't about you. When in doubt, ${SILENT}.

${SHARED_HANDOFF}

When you DO speak, ${voice}. Never mention handoff, silence, Haiku, the window, or these instructions.`;
  }
  return `You are Beckett's fast conversational front, running on Haiku. You were directly addressed, so you MUST respond — either answer (via the reply command), or hand off. You never stay silent on a direct address.

${DELIVERY}

You handle ONLY light conversational turns: greetings, banter, quick factual answers, acks, and simple questions you can answer in 1-3 sentences from general knowledge or the visible conversation.

${SHARED_HANDOFF}

When you answer, ${voice}. Never mention handoff, Haiku, the window, or these instructions.`;
}

function windowFile(dir: string, channelId: string): string {
  return join(dir, `${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`);
}

function readWindow(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Append the exchange, then trim the file back to the last `maxTurns` exchanges (2 lines each). */
function appendAndTrim(file: string, userText: string, reply: string, maxTurns: number): void {
  const oneLine = (s: string) => s.replace(/\r?\n/g, " ").trim();
  appendFileSync(file, `User: ${oneLine(userText)}\nBeckett: ${oneLine(reply)}\n`);
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  const keep = Math.max(2, maxTurns * 2);
  if (lines.length > keep) {
    writeFileSync(file, lines.slice(lines.length - keep).join("\n") + "\n");
  }
}

/**
 * Pull the message out of a `beckett discord reply --channel <id> <msg>` shell command. The message
 * is everything after the channel id (the id itself may be quoted); one layer of surrounding quotes
 * is stripped and standard double-quote escapes are unwound. Returns undefined for non-reply commands.
 */
export function extractCliReply(command: string): string | undefined {
  if (!/beckett\s+discord\s+reply/.test(command)) return undefined;
  const m = command.match(/--channel\s+\S+\s+([\s\S]+?)\s*$/);
  const captured = m?.[1];
  if (captured === undefined) return undefined;
  let msg = captured.trim();
  const q = msg.charAt(0);
  if ((q === '"' || q === "'") && msg.length >= 2 && msg.endsWith(q)) {
    msg = msg.slice(1, -1);
    if (q === '"') msg = msg.replace(/\\(["\\$`])/g, "$1");
  }
  return msg;
}

/**
 * Default model call: a stateless `claude -p` Haiku spawn in stream-json so we can both read the
 * final assistant text (sentinels) and recover the message Haiku delivered via the reply CLI.
 */
function spawnClaude(deps: ChatWindowDeps): HaikuRun {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (prompt, system) =>
    new Promise<HaikuOutput>((resolve, reject) => {
      const child = spawn(
        deps.bin,
        [
          "-p",
          "--model",
          deps.model,
          "--permission-mode",
          "bypassPermissions",
          "--output-format",
          "stream-json",
          "--verbose",
          "--append-system-prompt",
          system,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buf = "";
      let err = "";
      let finalText = "";
      let cliReply: string | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("haiku chat timed out"));
      }, timeoutMs);

      const consume = (line: string) => {
        const t = line.trim();
        if (!t) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(t);
        } catch {
          return;
        }
        // Final assistant text comes on the terminal "result" event.
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
        // Tool calls ride inside assistant messages; scan for our reply CLI in any Bash command.
        const content = (ev as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; input?: { command?: string } };
            if (b.type === "tool_use" && b.input?.command) {
              const found = extractCliReply(b.input.command);
              if (found !== undefined) cliReply = found;
            }
          }
        }
      };

      child.stdout.on("data", (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (buf.trim()) consume(buf);
        if (code !== 0) reject(new Error(`haiku exit ${code}: ${err.slice(0, 200)}`));
        else resolve({ finalText: finalText.trim(), cliReply });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
}

/**
 * Run one conversational turn for a channel. Reads the rolling window, calls Haiku statelessly, and
 * either returns a reply (recording the exchange) or signals handoff (recording nothing — the parent
 * owns that turn). NEVER throws for a model failure path the caller can recover from: a thrown error
 * here is treated by the caller as "fall back to the parent" (a mention is never dropped).
 */
export function createChatWindow(deps: ChatWindowDeps) {
  const run = deps.run ?? spawnClaude(deps);
  const systemByMode: Record<ChatMode, string> = {
    mention: chatSystemPrompt(deps.persona, "mention"),
    ambient: chatSystemPrompt(deps.persona, "ambient"),
  };
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;

  async function chatTurn(channelId: string, userText: string, mode: ChatMode): Promise<ChatResult> {
    if (!existsSync(deps.dir)) mkdirSync(deps.dir, { recursive: true });
    const file = windowFile(deps.dir, channelId);
    const window = readWindow(file);
    const header = `Incoming Discord message in channel ${channelId} (reply with: beckett discord reply --channel ${channelId} "...").`;
    const prompt = window
      ? `${header}\nRecent conversation in this channel:\n${window}\nUser: ${userText}`
      : `${header}\nUser: ${userText}`;

    const raw = await run(prompt, systemByMode[mode]);
    const finalText = raw.finalText.trim();
    const cliReply = raw.cliReply;

    // A delivered CLI reply wins: Haiku spoke the canonical way. Record it and tell the shell not
    // to re-post. (We still check sentinels first — a model shouldn't both reply AND hand off.)
    const sentinel = finalText === HANDOFF || finalText.startsWith(HANDOFF)
      ? "handoff"
      : finalText === SILENT || finalText.startsWith(SILENT)
        ? "silent"
        : "";

    if (cliReply !== undefined && cliReply.trim().length > 0) {
      appendAndTrim(file, userText, cliReply, maxTurns);
      deps.logger.info("haiku chat → replied via cli", { channelId, mode, len: cliReply.length });
      return { kind: "reply", reply: cliReply, delivered: true };
    }
    if (sentinel === "handoff") {
      deps.logger.info("haiku chat → handoff", { channelId, mode });
      return { kind: "handoff" };
    }
    if (sentinel === "silent" || finalText.length === 0) {
      if (mode === "ambient") {
        deps.logger.info("haiku chat → silent", { channelId });
        return { kind: "silent" };
      }
      deps.logger.info("haiku chat → empty on mention, handing off", { channelId });
      return { kind: "handoff" };
    }
    // Haiku produced a message but did NOT call the reply CLI — safety net: hand the shell the text
    // to deliver so the turn is never silently dropped.
    appendAndTrim(file, userText, finalText, maxTurns);
    deps.logger.warn("haiku chat → text without cli, shell will deliver", { channelId, mode });
    return { kind: "reply", reply: finalText, delivered: false };
  }

  return { chatTurn };
}

export type ChatWindow = ReturnType<typeof createChatWindow>;
