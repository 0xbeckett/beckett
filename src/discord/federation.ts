/**
 * Beckett — Federation gateway primitive (`src/discord/federation.ts`)
 * =======================================================================================
 * People fork Beckett, rename it, give it its own personality — so there can be many
 * Becketts. For them to talk, one Beckett has to STOP ignoring another. Discord itself
 * lets a bot see other bots' messages; the thing that silences them is Beckett's own
 * loop-guard in the gateway (`if (msg.author.bot) return`), which exists to stop the
 * daemon reacting to its own posts and amplifying into a feedback loop.
 *
 * This module is the narrow, pure exemption to that guard: a message from a bot whose id
 * is on the trusted-peer allowlist is let through; every other bot (and ALWAYS the daemon
 * itself) stays dropped. It ships inert — an empty allowlist reproduces today's behavior
 * byte-for-byte.
 *
 * It is deliberately just the *primitive*. The conversation protocol on top — how two
 * Becketts address each other, when to stop, what a "peer" message even means — is still
 * an open design question. The one piece of that we can't responsibly ship without is a
 * runaway backstop, so a {@link PeerBurstLimiter} caps how many peer messages a channel
 * will process per minute. Both pieces are pure (injectable clock) so they unit-test
 * without a live gateway.
 */

/**
 * Should the gateway process this bot message? True only when the author is a *listed*
 * peer AND is not us. The daemon's own id is rejected even if a fork mistakenly lists it,
 * because reacting to our own posts is the exact feedback loop the bot-filter prevents.
 *
 * @param authorId  Discord user id of the message author (a bot).
 * @param ownId     This daemon's own bot user id (from `ClientReady`), or undefined pre-ready.
 * @param peers     Trusted peer bot ids (config `federation.peers`).
 */
export function isFederatedPeer(
  authorId: string,
  ownId: string | undefined,
  peers: ReadonlySet<string>,
): boolean {
  if (ownId !== undefined && authorId === ownId) return false; // never react to ourselves
  return peers.has(authorId);
}

/**
 * Per-channel rolling-window rate cap on peer-bot messages. Two Becketts that each reply to
 * the other's @mention would otherwise ping-pong forever; until the protocol adds real loop
 * control, this bounds the blast radius: at most `limit` peer messages are processed per
 * channel per `windowMs`. It counts only messages that already passed {@link isFederatedPeer}
 * — human traffic is never rate-limited here.
 *
 * The clock is injectable so tests are deterministic (no reliance on wall time / sleeps).
 */
export class PeerBurstLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record + test one peer message in `channelId`. Returns true if it is within budget (the
   * caller should process it) or false if the channel has hit its cap for the current window
   * (the caller should drop it). Prunes timestamps older than the window on every call.
   */
  allow(channelId: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(channelId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(channelId, recent); // persist the pruned list; do NOT add this (dropped) hit
      return false;
    }
    recent.push(t);
    this.hits.set(channelId, recent);
    return true;
  }
}
