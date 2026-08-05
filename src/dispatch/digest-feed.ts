/**
 * The dispatch feed's Discord side (#4): one self-editing digest message per ticket episode.
 *
 * {@link ../dispatch/digest.ts DispatchDigest} decides WHAT to say; this decides where it lands.
 * The first sentence of an episode posts a message and remembers its id; every sentence after that
 * edits that same message, so a ticket's whole run is one thing a person can read at a glance
 * instead of a dozen pings. A genuine failure (and the first line after a long quiet period) posts
 * fresh, so it surfaces at the bottom of the channel rather than as a silent edit far above.
 *
 * Failure policy mirrors {@link ../task/card.ts TaskCardService}: a deleted target is the one
 * repost path, everything else (offline, rate limited, permissions) is skipped and self-heals —
 * every update carries the FULL body, so the next one shows what a dropped one would have.
 */
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { DispatchDigest, type DispatchDigestOptions } from "./digest.ts";
import type { DispatchEvent } from "./events.ts";

export interface DispatchDigestFeedOptions {
  gateway: Pick<DiscordGateway, "post" | "editMessage">;
  channelId: string;
  digest?: DispatchDigest;
  digestOptions?: DispatchDigestOptions;
  logger?: Logger;
}

export class DispatchDigestFeed {
  private readonly digest: DispatchDigest;
  private readonly logger: Logger;
  /** Ticket key → the message being edited for this episode. */
  private readonly anchors = new Map<string, string>();
  /** Per-ticket serialization: a post must persist its id before the next edit reads it. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly opts: DispatchDigestFeedOptions) {
    this.digest = opts.digest ?? new DispatchDigest(opts.digestOptions);
    this.logger = opts.logger ?? rootLog.child("dispatch.digest");
  }

  /**
   * Relay one dispatch event. Never throws: this is the event bus's best-effort live sink, and the
   * durable timeline is the JSONL the bus already wrote.
   */
  post(event: DispatchEvent): Promise<void> {
    const update = this.digest.observe(event);
    if (!update) return Promise.resolve();
    const key = update.key;
    const prior = this.inflight.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.deliver(key, update.text, update.fresh));
    this.inflight.set(key, next);
    void next.finally(() => {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    });
    return next;
  }

  private async deliver(key: string, text: string, fresh: boolean): Promise<void> {
    const anchor = fresh ? undefined : this.anchors.get(key);
    if (anchor) {
      try {
        await this.opts.gateway.editMessage(this.opts.channelId, anchor, { content: text });
        return;
      } catch (error) {
        if (!(error instanceof DiscordUnknownMessageError)) {
          // Offline / rate limited / permissions: skip this tick. The next update carries these
          // same sentences, so nothing is lost by staying quiet here.
          this.logger.debug("dispatch digest edit failed; folding into the next update", {
            ticket: key,
            error: String(error),
          });
          return;
        }
        this.logger.debug("dispatch digest message was deleted; posting a replacement", { ticket: key });
        this.anchors.delete(key);
      }
    }
    try {
      const messageId = await this.opts.gateway.post(this.opts.channelId, text, {
        singleMessage: true,
        // The durable timeline is the bus's JSONL. Never grow an unbounded Discord queue during an
        // outage, and never make the sink a recovery dependency.
        queueIfOffline: false,
      });
      this.anchors.set(key, messageId);
    } catch (error) {
      this.anchors.delete(key); // no anchor to edit — the next update posts fresh
      this.logger.debug("dispatch digest post failed", { ticket: key, error: String(error) });
    }
  }
}
