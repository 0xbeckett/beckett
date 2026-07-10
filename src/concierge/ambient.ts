import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccessLevel } from "../discord/access.ts";
import { buildPaths } from "../paths.ts";
import type { Config, IncomingMessage, Logger, ProactivityMode } from "../types.ts";
import type { TriageFn, TriageMessage, TriageVerdict } from "./triage.ts";

export interface AmbientTranscriptMessage extends TriageMessage {
  userId: string;
  messageId: string;
}

export interface PendingOffer {
  offerMessageId: string;
  offerText: string;
  sourceUserId: string;
  summary: string;
  mode: Exclude<ProactivityMode, "off">;
  expiresAt: number;
}

export interface PendingOfferRecord extends PendingOffer {
  channelId: string;
}

export type AmbientTurn =
  | {
      kind: "candidate";
      channelId: string;
      burst: AmbientTranscriptMessage[];
      transcript: AmbientTranscriptMessage[];
      verdict: TriageVerdict;
      /**
       * True when the burst arrived inside the engaged window (Beckett spoke here moments ago):
       * this is people responding to Beckett, not chatter it's eavesdropping on — no triage ran,
       * no caps applied, and the frame tells the session it's mid-conversation.
       */
      engaged?: boolean;
    }
  | {
      kind: "consent";
      channelId: string;
      offer: PendingOffer;
      message: IncomingMessage;
      transcript: AmbientTranscriptMessage[];
    }
  | {
      kind: "timeout";
      channelId: string;
      offer: PendingOffer;
      transcript: AmbientTranscriptMessage[];
    };

export interface AmbientClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CreateAmbientCoordinatorDeps {
  config: Config;
  logger: Logger;
  clock?: AmbientClock;
  triage: TriageFn;
  engage: (turn: AmbientTurn) => Promise<string>;
  storageFile?: string;
  /**
   * OPS-80: when set, the coordinator stops keeping its own per-channel ring buffers and reads
   * transcripts from here (the Concierge maps its shared channel-context store into this shape).
   * Absent (shared_context disabled, or older tests), the legacy in-memory ring buffer is used —
   * byte-identical to the pre-OPS-80 behavior. `proactivity.transcript_window` bounds what this
   * returns in BOTH modes: it is the burst-assembly context window, not the store's bound.
   */
  transcriptSource?: (channelId: string) => AmbientTranscriptMessage[];
}

export interface AmbientCoordinator {
  observe(message: IncomingMessage, accessLevel: AccessLevel): void;
  noteMention(channelId: string): void;
  /** Beckett just posted in this channel (any path) — opens/refreshes the engaged window. */
  noteBeckettPost(channelId: string): void;
  recordOffer(channelId: string, offer: Omit<PendingOffer, "expiresAt"> & { expiresAt?: number }): PendingOffer;
  clearOffer(channelId: string): void;
  getPendingOffer(channelId: string): PendingOffer | undefined;
  getTranscript(channelId: string): AmbientTranscriptMessage[];
  effectiveMode(channelId: string): ProactivityMode;
  stop(): void;
}

const realClock: AmbientClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The sentinel that suppresses an ambient post: `PASS` alone on the first line. */
export function isAmbientPass(text: string): boolean {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() === "PASS";
}

function asTranscriptMessage(m: IncomingMessage): AmbientTranscriptMessage {
  return {
    userId: m.userId,
    messageId: m.messageId,
    authorDisplayName: m.authorDisplayName?.trim() || m.userId,
    content: m.content,
    ts: m.createdAt,
  };
}

function serializeOffers(offers: Map<string, PendingOffer>): { offers: PendingOfferRecord[] } {
  return {
    offers: [...offers.entries()].map(([channelId, offer]) => ({ channelId, ...offer })),
  };
}

function parseOffers(raw: unknown): PendingOfferRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const offers = (raw as { offers?: unknown }).offers;
  if (!Array.isArray(offers)) return [];
  return offers.filter((o): o is PendingOfferRecord => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    return (
      typeof r.channelId === "string" &&
      typeof r.offerMessageId === "string" &&
      typeof r.offerText === "string" &&
      typeof r.sourceUserId === "string" &&
      typeof r.summary === "string" &&
      (r.mode === "suggest" || r.mode === "auto") &&
      typeof r.expiresAt === "number"
    );
  });
}

class Coordinator implements AmbientCoordinator {
  private readonly config: Config["proactivity"];
  private readonly logger: Logger;
  private readonly clock: AmbientClock;
  private readonly triage: TriageFn;
  private readonly engage: (turn: AmbientTurn) => Promise<string>;
  private readonly storageFile: string;
  private readonly transcriptSource?: (channelId: string) => AmbientTranscriptMessage[];
  /** Legacy ring buffer — used only when no {@link transcriptSource} is injected (OPS-80). */
  private readonly transcripts = new Map<string, AmbientTranscriptMessage[]>();
  private readonly bursts = new Map<string, AmbientTranscriptMessage[]>();
  private readonly debounceTimers = new Map<string, unknown>();
  private readonly offers = new Map<string, PendingOffer>();
  private readonly offerTimers = new Map<string, unknown>();
  private readonly lastInterjectionAt = new Map<string, number>();
  /** When Beckett last SPOKE per channel (any path) — anchors the engaged window. */
  private readonly lastBeckettPostAt = new Map<string, number>();
  private interjectionTimes: number[] = [];

  constructor(deps: CreateAmbientCoordinatorDeps) {
    this.config = deps.config.proactivity;
    this.logger = deps.logger;
    this.clock = deps.clock ?? realClock;
    this.triage = deps.triage;
    this.engage = deps.engage;
    this.transcriptSource = deps.transcriptSource;
    this.storageFile = deps.storageFile ?? join(buildPaths(deps.config).beckettDir, "pending-offers.json");
    this.loadOffers();
  }

  observe(message: IncomingMessage, accessLevel: AccessLevel): void {
    try {
      if (accessLevel === "outsider") return;
      const tm = asTranscriptMessage(message);
      // OPS-80: with a shared store injected, capture happens in Concierge.onMessage — appending
      // here too would double-record. The legacy ring buffer fills only when no store exists.
      if (!this.transcriptSource) this.appendTranscript(message.channelId, tm);

      if (!this.config.enabled) return;

      const liveOffer = this.offers.get(message.channelId);
      if (liveOffer) {
        void this.runConsentTurn(message.channelId, liveOffer, message);
        return;
      }

      const mode = this.effectiveMode(message.channelId);
      if (mode === "off") return;
      this.appendBurst(message.channelId, tm);
      this.armDebounce(message.channelId);
    } catch (err) {
      this.logger.warn("ambient observe failed", { error: (err as Error).message });
    }
  }

  noteMention(channelId: string): void {
    const timer = this.debounceTimers.get(channelId);
    if (timer) this.clock.clearTimeout(timer);
    this.debounceTimers.delete(channelId);
    this.bursts.delete(channelId);
  }

  noteBeckettPost(channelId: string): void {
    this.lastBeckettPostAt.set(channelId, this.clock.now());
  }

  /** Inside the window after Beckett spoke here, chatter is a continuation, not an interjection. */
  private isEngaged(channelId: string): boolean {
    const windowSecs = this.config.engaged_window_secs ?? 180;
    if (windowSecs <= 0) return false;
    const last = this.lastBeckettPostAt.get(channelId);
    return last !== undefined && this.clock.now() - last < windowSecs * 1000;
  }

  recordOffer(channelId: string, offer: Omit<PendingOffer, "expiresAt"> & { expiresAt?: number }): PendingOffer {
    this.clearOfferTimer(channelId);
    const pending: PendingOffer = {
      ...offer,
      expiresAt: offer.expiresAt ?? this.clock.now() + this.config.offer_ttl_secs * 1000,
    };
    this.offers.set(channelId, pending);
    this.armOfferTimer(channelId, pending);
    this.markInterjection(channelId);
    this.persistOffers();
    return pending;
  }

  clearOffer(channelId: string): void {
    this.clearOfferTimer(channelId);
    if (this.offers.delete(channelId)) this.persistOffers();
  }

  getPendingOffer(channelId: string): PendingOffer | undefined {
    return this.offers.get(channelId);
  }

  getTranscript(channelId: string): AmbientTranscriptMessage[] {
    // Store-backed (OPS-80): the shared record is bounded by the store's own count/TTL caps;
    // transcript_window keeps bounding what BURST ASSEMBLY sees, exactly as it bounded the ring.
    if (this.transcriptSource) {
      return this.transcriptSource(channelId).slice(-this.config.transcript_window);
    }
    return [...(this.transcripts.get(channelId) ?? [])];
  }

  effectiveMode(channelId: string): ProactivityMode {
    if (!this.config.enabled) return "off";
    return this.config.channels[channelId] ?? this.config.default_mode;
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) this.clock.clearTimeout(timer);
    for (const timer of this.offerTimers.values()) this.clock.clearTimeout(timer);
    this.debounceTimers.clear();
    this.offerTimers.clear();
  }

  private appendTranscript(channelId: string, msg: AmbientTranscriptMessage): void {
    const buf = this.transcripts.get(channelId) ?? [];
    buf.push(msg);
    while (buf.length > this.config.transcript_window) buf.shift();
    this.transcripts.set(channelId, buf);
  }

  private appendBurst(channelId: string, msg: AmbientTranscriptMessage): void {
    const burst = this.bursts.get(channelId) ?? [];
    burst.push(msg);
    this.bursts.set(channelId, burst);
  }

  private armDebounce(channelId: string): void {
    const prior = this.debounceTimers.get(channelId);
    if (prior) this.clock.clearTimeout(prior);
    // Mid-conversation a short lull IS the turn boundary — holding an engaged reply hostage to
    // the full cold debounce (which every new message resets) is how Beckett "wandered off" at
    // the end of its own conversations (v4.1.2).
    const quietSecs = this.isEngaged(channelId)
      ? (this.config.engaged_quiet_secs ?? 4)
      : this.config.burst_quiet_secs;
    const timer = this.clock.setTimeout(() => {
      this.debounceTimers.delete(channelId);
      void this.flushBurst(channelId);
    }, quietSecs * 1000);
    this.debounceTimers.set(channelId, timer);
  }

  private async flushBurst(channelId: string): Promise<void> {
    try {
      const burst = this.bursts.get(channelId) ?? [];
      this.bursts.delete(channelId);
      if (burst.length === 0) return;
      if (this.effectiveMode(channelId) === "off") return;

      // Engaged continuation (OPS-87 follow-up): Beckett spoke here moments ago, so this burst
      // is people responding to it. Gating that behind the classifier + cooldown is what made
      // Beckett go silent mid-conversation ("adding another voice just crowds the room" — on its
      // OWN thread). Skip both; the session turn still decides (it can PASS a conversation-ender).
      const engaged = this.isEngaged(channelId);
      const transcript = this.getTranscript(channelId);
      let verdict: TriageVerdict;
      if (engaged) {
        verdict = {
          interject: true,
          kind: "none",
          confidence: 1,
          reason: "engaged conversation — the burst responds to something Beckett just said",
          // Engaged by construction means people are talking WITH Beckett (it spoke moments ago),
          // so this is a continuation of a Beckett thread — `beckett-thread`, the addressee read
          // that captures exactly this (OPS-101 / OPS-99 §3.2, sharpened OPS-116). No classifier
          // ran to read it; the engaged frame short-circuits addresseeFrameLine anyway.
          addressee: "beckett-thread",
        };
        this.logger.info("ambient engaged continuation", { channel: channelId, burst: burst.length });
      } else {
        if (this.isCapped(channelId)) return;
        verdict = await this.triage(burst, transcript, { channelId });
        if (!verdict.interject || verdict.confidence < this.config.triage_threshold) return;
        if (this.isCapped(channelId)) return;
      }

      const reply = await this.engage({ kind: "candidate", channelId, burst, transcript, verdict, engaged });
      if (!isAmbientPass(reply)) {
        // Any real post opens/refreshes the engaged window (belt to the Concierge's suspenders —
        // legacy no-store configs never route through recordBeckettPost).
        this.noteBeckettPost(channelId);
        // A real COLD post consumes cooldown. If `engage` already armed an offer for this channel
        // it has called `recordOffer` (which starts the cooldown), so don't double-count; and an
        // engaged continuation never spends the interjection budget — it's one conversation, not
        // N interjections.
        if (!engaged && !this.offers.has(channelId)) this.markInterjection(channelId);
      }
    } catch (err) {
      this.logger.warn("ambient burst flush failed", { channel: channelId, error: (err as Error).message });
    }
  }

  private async runConsentTurn(channelId: string, offer: PendingOffer, message: IncomingMessage): Promise<void> {
    try {
      const reply = await this.engage({
        kind: "consent",
        channelId,
        offer,
        message,
        transcript: this.getTranscript(channelId),
      });
      if (!isAmbientPass(reply)) this.noteBeckettPost(channelId);
    } catch (err) {
      this.logger.warn("ambient consent turn failed", { channel: channelId, error: (err as Error).message });
    }
  }

  private armOfferTimer(channelId: string, offer: PendingOffer): void {
    const delay = Math.max(0, offer.expiresAt - this.clock.now());
    const timer = this.clock.setTimeout(() => {
      this.offerTimers.delete(channelId);
      void this.expireOffer(channelId, offer);
    }, delay);
    this.offerTimers.set(channelId, timer);
  }

  private clearOfferTimer(channelId: string): void {
    const prior = this.offerTimers.get(channelId);
    if (prior) this.clock.clearTimeout(prior);
    this.offerTimers.delete(channelId);
  }

  private async expireOffer(channelId: string, offer: PendingOffer): Promise<void> {
    const current = this.offers.get(channelId);
    if (!current || current.offerMessageId !== offer.offerMessageId) return;
    this.offers.delete(channelId);
    this.persistOffers();
    if (offer.mode !== "auto" || !this.config.enabled) return;
    try {
      const reply = await this.engage({ kind: "timeout", channelId, offer, transcript: this.getTranscript(channelId) });
      if (!isAmbientPass(reply)) {
        this.noteBeckettPost(channelId);
        this.markInterjection(channelId);
      }
    } catch (err) {
      this.logger.warn("ambient timeout turn failed", { channel: channelId, error: (err as Error).message });
    }
  }

  private markInterjection(channelId: string): void {
    const now = this.clock.now();
    this.lastInterjectionAt.set(channelId, now);
    this.interjectionTimes = this.interjectionTimes.filter((t) => now - t < 60 * 60 * 1000);
    this.interjectionTimes.push(now);
  }

  private isCapped(channelId: string): boolean {
    const now = this.clock.now();
    const last = this.lastInterjectionAt.get(channelId);
    if (last !== undefined && now - last < this.config.channel_cooldown_secs * 1000) return true;
    this.interjectionTimes = this.interjectionTimes.filter((t) => now - t < 60 * 60 * 1000);
    return this.config.max_interjections_per_hour > 0 && this.interjectionTimes.length >= this.config.max_interjections_per_hour;
  }

  private loadOffers(): void {
    if (!existsSync(this.storageFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.storageFile, "utf8"));
      let changed = false;
      for (const { channelId, ...offer } of parseOffers(parsed)) {
        if (offer.expiresAt <= this.clock.now()) {
          changed = true;
          continue;
        }
        this.offers.set(channelId, offer);
        this.armOfferTimer(channelId, offer);
      }
      if (changed) this.persistOffers();
    } catch (err) {
      this.logger.warn("ambient offer ledger load failed", { file: this.storageFile, error: (err as Error).message });
    }
  }

  private persistOffers(): void {
    try {
      mkdirSync(dirname(this.storageFile), { recursive: true });
      writeFileSync(this.storageFile, JSON.stringify(serializeOffers(this.offers), null, 2) + "\n", "utf8");
    } catch (err) {
      this.logger.warn("ambient offer ledger persist failed", { file: this.storageFile, error: (err as Error).message });
    }
  }
}

export function createAmbientCoordinator(deps: CreateAmbientCoordinatorDeps): AmbientCoordinator {
  return new Coordinator(deps);
}

/**
 * Read the persisted offer ledger straight off disk (`pending-offers.json`). Lets a reader that
 * doesn't hold the live coordinator — `beckett proactivity status` — surface the current live
 * offers. The file is kept in lockstep with in-memory state on every record/clear/expire, so it
 * is a faithful mirror; callers should still drop entries past `expiresAt`.
 */
export function readPersistedOffers(file: string): PendingOfferRecord[] {
  if (!existsSync(file)) return [];
  try {
    return parseOffers(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}
