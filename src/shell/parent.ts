/**
 * Beckett v2 — parent supervisor (`src/shell/parent.ts`)
 * =======================================================================================
 * Spawns and keeps alive the long-lived `claude -p` PARENT agent — Beckett's brain (Spec 01
 * §3). Streaming-input mode: the shell writes user-message NDJSON lines on stdin (Discord
 * mentions + watcher signals + check-ins) and the parent reasons, using its skills + the
 * `beckett` CLI to act. We persist the session id and `--resume` on crash (≤1 turn lost).
 *
 * The parent posts its own user-facing replies via `beckett discord reply` (→ control bus →
 * gateway), so we do not parse stdout for replies; we read it only for the session id, light
 * liveness/telemetry, and to surface assistant text in logs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../types.ts";

export interface ParentOptions {
  bin: string; // claude binary (BECKETT_CLAUDE_BIN or config)
  model: string; // parent model (e.g. claude-opus-4-8)
  cwd: string; // repo root, so .claude/skills + hooks load (NOT --bare)
  doctrine: string; // contents of .claude/parent-doctrine.md (system prompt)
  sessionFile: string; // where to persist the parent session id
  logger: Logger;
  env?: Record<string, string | undefined>;
}

interface ParentLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: unknown };
  [k: string]: unknown;
}

export class ParentSupervisor {
  private proc?: ReturnType<typeof Bun.spawn>;
  private sessionId: string;
  private buf = "";
  private shuttingDown = false;
  private restarts = 0;

  constructor(private readonly opts: ParentOptions) {
    this.sessionId = this.loadSession() ?? randomUUID();
  }

  /** Persisted session id (for inspection / recovery). */
  get session(): string {
    return this.sessionId;
  }

  async start(): Promise<void> {
    const resuming = existsSync(this.opts.sessionFile);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--model",
      this.opts.model,
      "--permission-mode",
      "bypassPermissions", // the parent is Beckett itself — fully trusted (non-root user)
      "--append-system-prompt",
      this.opts.doctrine,
    ];
    if (resuming) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);

    this.opts.logger.info("spawning parent agent", {
      model: this.opts.model,
      resuming,
      session: this.sessionId,
    });

    this.proc = Bun.spawn([this.opts.bin, ...args], {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // surface parent errors in the shell log; avoids an undrained pipe
      env: { ...process.env, ...this.opts.env },
    });

    void this.pump();
    void this.watchExit();
  }

  /** Inject a user message (a Discord mention, a watcher signal, a check-in) into the parent. */
  inject(text: string): void {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    const stdin = this.proc?.stdin;
    if (!stdin) {
      this.opts.logger.warn("inject dropped — parent not running", { len: text.length });
      return;
    }
    (stdin as { write: (s: string) => void }).write(line + "\n");
    (stdin as { flush?: () => void }).flush?.();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    try {
      this.proc?.stdin && (this.proc.stdin as { end?: () => void }).end?.();
    } catch {
      /* best-effort */
    }
    try {
      this.proc?.kill();
    } catch {
      /* best-effort */
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout) return;
    try {
      for await (const chunk of stdout as AsyncIterable<Uint8Array>) {
        this.buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const raw = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (raw) this.onLine(raw);
        }
      }
    } catch (err) {
      this.opts.logger.debug("parent stdout pump ended", { error: String(err) });
    }
  }

  private onLine(raw: string): void {
    let msg: ParentLine;
    try {
      msg = JSON.parse(raw) as ParentLine;
    } catch {
      return; // forward-compat: skip non-JSON
    }
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      if (msg.session_id !== this.sessionId) this.sessionId = msg.session_id;
      this.saveSession();
      this.opts.logger.info("parent ready", { session: this.sessionId });
    } else if (msg.type === "assistant") {
      const text = extractText(msg.message?.content);
      if (text) this.opts.logger.debug("parent says", { text: text.slice(0, 200) });
    } else if (msg.type === "result") {
      this.opts.logger.debug("parent turn complete", { subtype: msg.subtype });
    }
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    if (this.shuttingDown) return;
    this.restarts++;
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
    this.opts.logger.warn("parent exited — resuming", { code, restarts: this.restarts, backoff });
    setTimeout(() => void this.start(), backoff);
  }

  private loadSession(): string | undefined {
    try {
      return readFileSync(this.opts.sessionFile, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private saveSession(): void {
    try {
      mkdirSync(dirname(this.opts.sessionFile), { recursive: true });
      writeFileSync(this.opts.sessionFile, this.sessionId);
    } catch (err) {
      this.opts.logger.warn("could not persist parent session", { error: String(err) });
    }
  }
}

/** Pull text out of an assistant message's content (string or content-block array). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}
