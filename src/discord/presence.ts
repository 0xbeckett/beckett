/**
 * Beckett — Discord presence deriver (`src/discord/presence.ts`)
 * =======================================================================================
 * Turns the live board into a one-line "what Beckett is doing right now", so anyone in the
 * server can read the state of the board from the bot's presence without asking (#132).
 *
 * ONE deriver, TWO sinks:
 *   1. the gateway bot presence (discord.js `client.user.setPresence`), and
 *   2. `~/.beckett/rpc-status.json` in the `{ details, state }` shape the existing desktop RPC
 *      daemon (`src/rpc/daemon.ts`) already parses — so that daemon needs NO change.
 *
 * The inputs come from the existing 60-second status-snapshot tick (see `shell/main.ts`); this
 * module never polls anything itself. Rate safety is the one real risk: Discord allows ~5 presence
 * updates per 20s per connection, so {@link PresenceController} only emits when the derived line
 * actually changes AND never faster than one send per {@link PresenceControllerOptions.minSendIntervalMs}
 * (default 15s). Every failure — deriving or either sink — is caught and logged; presence is a
 * read-out, never a reason to take down the gateway or the daemon.
 */

import { ActivityType, type PresenceData } from "discord.js";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";

/**
 * The live board facts a presence line is derived from. Assembled once per status-snapshot tick;
 * this module treats them as a pure input — it does not read them itself.
 */
export interface PresenceInputs {
  /** A core operation is unreachable / the daemon is degraded (highest priority). */
  degraded: boolean;
  /** A deploy is currently in flight. */
  deployInFlight: boolean;
  /** At least one background browser run is live. */
  browserRunLive: boolean;
  /** How many branch builds are in flight right now (clamped to >= 0). */
  branchesInFlight: number;
}

export type PresenceStatus = "online" | "idle" | "dnd";

export interface DerivedPresence {
  status: PresenceStatus;
  /** Discord activity type — only `Playing` or `Watching` are used here. */
  activityType: ActivityType;
  /** The activity name Discord renders after the verb, e.g. `3 branches build`. */
  text: string;
  /** The full rendered line (`Watching 3 branches build`) — the RPC detail line + the change anchor. */
  line: string;
}

/** Human verb Discord prefixes an activity with, mirrored into the RPC detail line. */
function verbFor(type: ActivityType): string {
  return type === ActivityType.Playing ? "Playing" : "Watching";
}

function make(activityType: ActivityType, text: string, status: PresenceStatus): DerivedPresence {
  return { status, activityType, text, line: `${verbFor(activityType)} ${text}` };
}

/**
 * Highest-priority matching board state wins. The strings and (type, status) pairs are the frozen
 * contract from #132 — do not paraphrase them. Plural is correct at N=1 (`1 branch build`) and
 * N>1 (`3 branches build`).
 */
export function derivePresence(inputs: PresenceInputs): DerivedPresence {
  if (inputs.degraded) return make(ActivityType.Watching, "something break", "dnd");
  if (inputs.deployInFlight) return make(ActivityType.Playing, "a deploy", "online");
  if (inputs.browserRunLive) return make(ActivityType.Watching, "a browser run", "online");
  const branches = Math.max(0, Math.floor(inputs.branchesInFlight));
  if (branches >= 1) {
    const noun = branches === 1 ? "branch" : "branches";
    return make(ActivityType.Watching, `${branches} ${noun} build`, "online");
  }
  return make(ActivityType.Watching, "an empty board", "idle");
}

/** The change anchor: two derived presences are "the same" iff status, type, and text all match. */
export function presenceKey(derived: DerivedPresence): string {
  return `${derived.status}|${derived.activityType}|${derived.text}`;
}

/** The discord.js payload for a derived presence. */
export function toPresenceData(derived: DerivedPresence): PresenceData {
  return { status: derived.status, activities: [{ type: derived.activityType, name: derived.text }] };
}

/**
 * The static presence Discord shows the instant the bot connects, before the first snapshot tick
 * has run. Deliberately equal to the "nothing running" state so connect → first tick is seamless.
 */
export function initialPresenceData(): PresenceData {
  return toPresenceData(
    derivePresence({ degraded: false, deployInFlight: false, browserRunLive: false, branchesInFlight: 0 }),
  );
}

/** The two places a derived presence is written. Each is called independently and may throw. */
export interface PresenceSinks {
  /** Push presence to the gateway bot user (discord.js `setPresence`). */
  setPresence: (data: PresenceData) => void | Promise<void>;
  /** Persist the RPC status file consumed by `src/rpc/daemon.ts`'s `readStatus()`. */
  writeStatus: (payload: { details: string; state: string }) => void | Promise<void>;
}

export interface PresenceControllerOptions {
  sinks: PresenceSinks;
  logger?: Logger;
  now?: () => number;
  /** Hard floor between presence sends (Discord ~5 updates / 20s). Default 15_000. */
  minSendIntervalMs?: number;
  /** The RPC `state` line (the app subtitle under the detail line). Default "beckett". */
  rpcState?: string;
}

/**
 * Owns the send decision. Fed the current board on every snapshot tick, it emits to both sinks ONLY
 * when the derived line actually changes from the last one sent, and never more often than
 * `minSendIntervalMs`. When a change is rate-floored it is simply retried on the next tick (the
 * snapshot cadence is 60s, comfortably above the floor). Never throws.
 */
export class PresenceController {
  private readonly sinks: PresenceSinks;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minSendIntervalMs: number;
  private readonly rpcState: string;
  private lastKey: string | null = null;
  private lastSentAt: number | null = null;

  constructor(opts: PresenceControllerOptions) {
    this.sinks = opts.sinks;
    this.logger = opts.logger ?? rootLog.child("discord.presence");
    this.now = opts.now ?? Date.now;
    this.minSendIntervalMs = opts.minSendIntervalMs ?? 15_000;
    this.rpcState = opts.rpcState ?? "beckett";
  }

  /**
   * Derive from the current board and, only on a real change within the rate floor, push to both
   * sinks. A derive failure, or either sink throwing, is caught and logged — the tick, the gateway,
   * and the RPC daemon all carry on unaffected.
   */
  async update(inputs: PresenceInputs): Promise<void> {
    try {
      const derived = derivePresence(inputs);
      const key = presenceKey(derived);
      if (key === this.lastKey) return; // unchanged — no send, no write
      const now = this.now();
      if (this.lastSentAt !== null && now - this.lastSentAt < this.minSendIntervalMs) {
        // Rate-floored: leave lastKey untouched so the next tick re-attempts this pending change.
        return;
      }
      await this.emit(derived);
      this.lastKey = key;
      this.lastSentAt = now;
    } catch (err) {
      this.logger.warn("presence update failed; carrying on", { error: String(err) });
    }
  }

  /** Write both sinks; each is isolated so one failing never blocks the other or the caller. */
  private async emit(derived: DerivedPresence): Promise<void> {
    try {
      await this.sinks.setPresence(toPresenceData(derived));
    } catch (err) {
      this.logger.warn("presence: setPresence sink failed", { line: derived.line, error: String(err) });
    }
    try {
      await this.sinks.writeStatus({ details: derived.line, state: this.rpcState });
    } catch (err) {
      this.logger.warn("presence: rpc-status write failed", { line: derived.line, error: String(err) });
    }
  }
}
