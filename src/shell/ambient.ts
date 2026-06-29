/**
 * Beckett v2 — ambient Discord pump (`src/shell/ambient.ts`)
 * =======================================================================================
 * Proactive intelligence, the mechanism half. A direct `@beckett` mention is injected into the
 * parent immediately (high priority). But Beckett should also be able to *overhear* — people
 * yapping about an idea in a channel, not pinging it — and occasionally jump in unprompted
 * ("saw you all talking about X, threw together a mockup: …"). Flooding the parent with every
 * line would burn its context and make it twitchy, so ambient chatter is **batched per channel**
 * and handed over as a single digest after the room goes quiet (or after enough lines pile up).
 *
 * The *restraint* half — when to act vs. stay silent — lives in the parent's doctrine + the
 * `proactive` skill. This file only decides *when to surface* the conversation, not what to do
 * about it. Ambient is opt-in (env `BECKETT_AMBIENT=1`) so it stays dark until we flip it on.
 */

export interface AmbientOpts {
  /** Flush a channel's buffer after this much quiet (ms). Default 45s. */
  quietMs?: number;
  /** Flush early once a channel's buffer hits this many lines. Default 10. */
  maxLines?: number;
}

interface Buf {
  lines: string[];
  timer?: ReturnType<typeof setTimeout>;
}

export class AmbientPump {
  private readonly bufs = new Map<string, Buf>();
  private readonly quietMs: number;
  private readonly maxLines: number;

  constructor(
    private readonly inject: (text: string) => void,
    opts: AmbientOpts = {},
  ) {
    this.quietMs = opts.quietMs ?? 45_000;
    this.maxLines = opts.maxLines ?? 10;
  }

  /** Buffer one overheard (non-mention) message; flush on quiet or when the buffer fills. */
  add(channelId: string, userId: string, content: string): void {
    let b = this.bufs.get(channelId);
    if (!b) {
      b = { lines: [] };
      this.bufs.set(channelId, b);
    }
    b.lines.push(`${userId}: ${content}`.replace(/\s+/g, " ").slice(0, 300));
    if (b.timer) clearTimeout(b.timer);
    if (b.lines.length >= this.maxLines) {
      this.flush(channelId);
      return;
    }
    b.timer = setTimeout(() => this.flush(channelId), this.quietMs);
  }

  /** Hand a channel's buffered chatter to the parent as one ambient digest (no-op if empty). */
  flush(channelId: string): void {
    const b = this.bufs.get(channelId);
    if (!b || b.lines.length === 0) {
      if (b?.timer) clearTimeout(b.timer);
      this.bufs.delete(channelId);
      return;
    }
    if (b.timer) clearTimeout(b.timer);
    const { lines } = b;
    this.bufs.delete(channelId);
    this.inject(
      `[ambient channel=${channelId}] overheard — you were NOT @-mentioned; default to staying out, ` +
        `act only if you can add real, specific value (see the proactive skill):\n${lines.join("\n")}`,
    );
  }

  /** Drop all timers (shutdown). */
  stop(): void {
    for (const b of this.bufs.values()) if (b.timer) clearTimeout(b.timer);
    this.bufs.clear();
  }
}
