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
}

export interface AmbientCoordinator {
  observe(message: IncomingMessage, accessLevel: AccessLevel): void;
  noteMention(channelId: string): void;
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

function isPass(text: string): boolean {
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
  private readonly transcripts = new Map<string, AmbientTranscriptMessage[]>();
  private readonly bursts = new Map<string, AmbientTranscriptMessage[]>();
  private readonly debounceTimers = new Map<string, unknown>();
  private readonly offers = new Map<string, PendingOffer>();
  private readonly offerTimers = new Map<string, unknown>();
  private readonly lastInterjectionAt = new Map<string, number>();
  private interjectionTimes: number[] = [];

  constructor(deps: CreateAmbientCoordinatorDeps) {
    this.config = deps.config.proactivity;
    this.logger = deps.logger;
    this.clock = deps.clock ?? realClock;
    this.triage = deps.triage;
    this.engage = deps.engage;
    this.storageFile = deps.storageFile ?? join(buildPaths(deps.config).beckettDir, "pending-offers.json");
    this.loadOffers();
  }

  observe(message: IncomingMessage, accessLevel: AccessLevel): void {
    try {
      if (accessLevel === "outsider") return;
      const tm = asTranscriptMessage(message);
      this.appendTranscript(message.channelId, tm);

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
    const timer = this.clock.setTimeout(() => {
      this.debounceTimers.delete(channelId);
      void this.flushBurst(channelId);
    }, this.config.burst_quiet_secs * 1000);
    this.debounceTimers.set(channelId, timer);
  }

  private async flushBurst(channelId: string): Promise<void> {
    try {
      const burst = this.bursts.get(channelId) ?? [];
      this.bursts.delete(channelId);
      if (burst.length === 0) return;
      if (this.effectiveMode(channelId) === "off") return;
      if (this.isCapped(channelId)) return;

      const transcript = this.getTranscript(channelId);
      const verdict = await this.triage(burst, transcript, { channelId });
      if (!verdict.interject || verdict.confidence < this.config.triage_threshold) return;
      if (this.isCapped(channelId)) return;

      const reply = await this.engage({ kind: "candidate", channelId, burst, transcript, verdict });
      if (!isPass(reply)) this.markInterjection(channelId);
    } catch (err) {
      this.logger.warn("ambient burst flush failed", { channel: channelId, error: (err as Error).message });
    }
  }

  private async runConsentTurn(channelId: string, offer: PendingOffer, message: IncomingMessage): Promise<void> {
    try {
      await this.engage({
        kind: "consent",
        channelId,
        offer,
        message,
        transcript: this.getTranscript(channelId),
      });
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
      if (!isPass(reply)) this.markInterjection(channelId);
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
