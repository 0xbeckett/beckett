import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bootstrapInbox,
  stripHtml,
  type AgentMailApi,
  type MailMessage,
  type MailMessageItem,
} from "./index.ts";

const MAIL_LISTENER_STATE_VERSION = 1;

interface MailListenerState {
  version: 1;
  inboxId: string;
  initialized: boolean;
  /** Never prune this list: an AgentMail redelivery must never become another turn. */
  seenMessageIds: string[];
}

export interface IncomingMailNotification {
  from: string;
  subject: string;
  snippet: string;
  messageId: string;
}

export interface AgentMailPollerOptions {
  api: AgentMailApi;
  stateFile: string;
  inboxStateFile: string;
  /** Called only after the durable dedupe ledger says this is a new inbound message. */
  onIncomingEmail(notification: IncomingMailNotification): Promise<void>;
  /** Defaults to 30 seconds. Set to 0 in tests to disable the timer. */
  intervalMs?: number;
}

export function defaultMailListenerStateFile(beckettDir: string): string {
  return join(beckettDir, "mail-listener.json");
}

function loadState(file: string): MailListenerState | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !parsed || typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).version !== MAIL_LISTENER_STATE_VERSION ||
      typeof (parsed as Record<string, unknown>).inboxId !== "string" ||
      typeof (parsed as Record<string, unknown>).initialized !== "boolean" ||
      !Array.isArray((parsed as Record<string, unknown>).seenMessageIds) ||
      !(parsed as Record<string, unknown>).seenMessageIds.every((id) => typeof id === "string")
    ) throw new Error("invalid shape");
    return parsed as MailListenerState;
  } catch (err) {
    throw new Error(`invalid mail listener state at ${file}: ${(err as Error).message}`);
  }
}

function saveState(file: string, state: MailListenerState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

function text(value: string | undefined, width: number): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
}

/** A bounded text-first preview suitable for an untrusted-email notification turn. */
export function mailSnippet(message: MailMessage): string {
  return text(
    message.text || message.extractedText || stripHtml(message.html || message.extractedHtml || "") || "(no body)",
    500,
  );
}

function isFromInbox(message: MailMessageItem, address: string): boolean {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[<\\s])${escaped}(?:$|[>\\s])`, "i").test(message.from.trim());
}

/**
 * Poll AgentMail because the Beckett daemon intentionally has no public HTTP listener. The first
 * successful list only establishes a watermark, preventing a deploy from replaying old mail; every
 * later message ID is recorded durably after its turn is accepted, so redelivery/restart cannot
 * emit a second notification.
 */
export class AgentMailPoller {
  private state: MailListenerState | null = null;
  private inbox: { inboxId: string; address: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly opts: AgentMailPollerOptions) {}

  async start(): Promise<void> {
    this.inbox = await bootstrapInbox(this.opts.api, this.opts.inboxStateFile);
    this.state = loadState(this.opts.stateFile);
    if (!this.state || this.state.inboxId !== this.inbox.inboxId) {
      this.state = { version: 1, inboxId: this.inbox.inboxId, initialized: false, seenMessageIds: [] };
    }
    await this.pollNow();
    const intervalMs = this.opts.intervalMs ?? 30_000;
    if (intervalMs > 0) this.timer = setInterval(() => void this.pollNow(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for deterministic tests and a future on-demand health check. */
  async pollNow(): Promise<void> {
    if (this.polling) return;
    if (!this.inbox || !this.state) throw new Error("mail poller has not started");
    this.polling = true;
    try {
      const listed = await this.opts.api.inboxes.messages.list(this.inbox.inboxId, { limit: 100 });
      const seen = new Set(this.state.seenMessageIds);
      if (!this.state.initialized) {
        // Baseline all mail visible at startup. This is intentionally silent: only mail that arrives
        // while the daemon is listening should produce a turn.
        for (const message of listed.messages) seen.add(message.messageId);
        this.state.seenMessageIds = [...seen];
        this.state.initialized = true;
        saveState(this.opts.stateFile, this.state);
        return;
      }

      // AgentMail returns recent-first; turn it around so several messages are presented oldest-first.
      const fresh = listed.messages.filter((message) => !seen.has(message.messageId)).reverse();
      for (const item of fresh) {
        if (isFromInbox(item, this.inbox.address)) {
          seen.add(item.messageId); // outgoing mail is not an inbound notification
          this.state.seenMessageIds = [...seen];
          saveState(this.opts.stateFile, this.state);
          continue;
        }
        const message = await this.opts.api.inboxes.messages.get(this.inbox.inboxId, item.messageId);
        await this.opts.onIncomingEmail({
          from: text(message.from, 500) || "(unknown sender)",
          subject: text(message.subject, 500) || "(no subject)",
          snippet: mailSnippet(message),
          messageId: message.messageId,
        });
        // Persist only once the Concierge accepted the turn. A later redelivery sees this ID and is silent.
        seen.add(item.messageId);
        this.state.seenMessageIds = [...seen];
        saveState(this.opts.stateFile, this.state);
      }
    } finally {
      this.polling = false;
    }
  }
}

export function createAgentMailPoller(opts: AgentMailPollerOptions): AgentMailPoller {
  return new AgentMailPoller(opts);
}
