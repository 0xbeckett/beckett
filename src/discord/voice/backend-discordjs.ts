/**
 * Beckett — @discordjs/voice backend adapter (`src/discord/voice/backend-discordjs.ts`)
 * =======================================================================================
 * The real network implementation of {@link VoiceBackend}. Everything below the {@link VoiceBackend}
 * seam lives here: joining the UDP voice connection, subscribing to each speaker's Opus stream,
 * DECODING Opus → PCM and downmixing to mono, and encoding/pacing playback back out.
 *
 * Receive segmentation uses Discord's OWN silence detection: each speaking-start opens an
 * `EndBehaviorType.AfterSilence` subscription whose stream ENDS after {@link DEFAULT_SILENCE_MS}
 * of quiet — that stream end is the "speaking stop" the session segments on. One subscription
 * lifecycle == one utterance, and subscriptions are per-user, so overlapping speakers decode on
 * independent streams and never merge.
 *
 * This module is imported LAZILY by the daemon (dynamic import), so a box missing the optional
 * native/opus/encryption deps degrades to "voice disabled" instead of failing the whole boot.
 * The pure pipeline (segmenter/session/gateway) never imports it.
 */

import { Readable } from "node:stream";
import {
  joinVoiceChannel,
  entersState,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import prism from "prism-media";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { Logger } from "../../types.ts";
import { log as rootLog } from "../../log.ts";
import type { VoiceBackend } from "./types.ts";
import {
  DEFAULT_SILENCE_MS,
  DISCORD_CHANNELS,
  DISCORD_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
} from "./types.ts";
import { monoToStereo, stereoToMono } from "./pcm.ts";
import type { VoiceBackendFactory } from "./gateway.ts";

/** One pending playback promise, tagged so a stale player transition can't settle the wrong one. */
interface PendingPlay {
  resolve: () => void;
}

/** Live `@discordjs/voice` implementation of {@link VoiceBackend}. */
export class DiscordJsVoiceBackend implements VoiceBackend {
  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly log: Logger;
  private readonly silenceMs: number;
  private readonly speakingStartCbs: Array<(userId: string) => void> = [];
  private readonly speakingEndCbs: Array<(userId: string) => void> = [];
  private readonly pcmCbs: Array<(userId: string, pcm: Buffer) => void> = [];
  /** Users with a live decode subscription — guards against Discord's repeated 'start' events. */
  private readonly decoding = new Set<string>();
  private pending: PendingPlay | undefined;
  private closed = false;

  constructor(connection: VoiceConnection, opts: { logger?: Logger; silenceMs?: number } = {}) {
    this.connection = connection;
    this.log = opts.logger ?? rootLog.child("voice.backend");
    this.silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(this.player);

    // A stop() transitions the player to Idle synchronously, so the pending promise for a
    // superseded/cancelled playback settles before the next play() is issued — no cross-talk.
    this.player.on(AudioPlayerStatus.Idle, () => this.settlePlay());
    this.player.on("error", (err) => {
      this.log.warn("voice player error", { error: String(err) });
      this.settlePlay();
    });

    this.wireReceiver();
    this.wireConnectionLifecycle();
  }

  onSpeakingStart(cb: (userId: string) => void): void {
    this.speakingStartCbs.push(cb);
  }
  onSpeakingEnd(cb: (userId: string) => void): void {
    this.speakingEndCbs.push(cb);
  }
  onPcm(cb: (userId: string, pcm: Buffer) => void): void {
    this.pcmCbs.push(cb);
  }

  async play(pcm: Buffer): Promise<void> {
    if (this.closed || pcm.length === 0) return;
    // Supersede any prior pending promise before starting a new resource.
    this.settlePlay();
    const stereo = monoToStereo(pcm);
    const resource = createAudioResource(Readable.from(stereo), { inputType: StreamType.Raw });
    await new Promise<void>((resolve) => {
      this.pending = { resolve };
      this.player.play(resource);
    });
  }

  stopPlayback(): void {
    // stop(true) forces an immediate Idle transition (synchronous), settling the pending promise.
    this.player.stop(true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settlePlay();
    try {
      this.player.stop(true);
    } catch {
      /* already stopped */
    }
    try {
      this.connection.destroy();
    } catch {
      /* already destroyed */
    }
  }

  /** Resolve and clear the current playback promise, if any. Idempotent. */
  private settlePlay(): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve();
  }

  private emitSpeakingStart(userId: string): void {
    for (const cb of this.speakingStartCbs) safe(this.log, () => cb(userId));
  }
  private emitSpeakingEnd(userId: string): void {
    for (const cb of this.speakingEndCbs) safe(this.log, () => cb(userId));
  }
  private emitPcm(userId: string, pcm: Buffer): void {
    for (const cb of this.pcmCbs) safe(this.log, () => cb(userId, pcm));
  }

  /** Subscribe to each speaker on 'start', decode Opus→mono PCM, end the turn on silence. */
  private wireReceiver(): void {
    const receiver = this.connection.receiver;
    receiver.speaking.on("start", (userId: string) => {
      if (this.decoding.has(userId)) return; // already decoding this speaker's current turn
      this.decoding.add(userId);
      this.emitSpeakingStart(userId);

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
      });
      const decoder = new prism.opus.Decoder({
        rate: DISCORD_SAMPLE_RATE,
        channels: DISCORD_CHANNELS,
        frameSize: VOICE_FRAME_SAMPLES,
      });

      decoder.on("data", (stereoFrame: Buffer) => {
        // Downmix to mono at the frame — the only per-frame transform we do (see pcm.ts).
        this.emitPcm(userId, stereoToMono(stereoFrame));
      });
      decoder.on("error", (err: unknown) =>
        this.log.debug("opus decode error", { userId, error: String(err) }),
      );

      const finish = (): void => {
        if (!this.decoding.delete(userId)) return; // finish once
        this.emitSpeakingEnd(userId);
      };
      // The Opus stream ends after AfterSilence — that is Discord's speaking-stop signal.
      opusStream.on("end", finish);
      opusStream.on("close", finish);
      opusStream.on("error", (err: unknown) => {
        this.log.debug("voice receive stream error", { userId, error: String(err) });
        finish();
      });
      opusStream.pipe(decoder);
    });
  }

  /** Best-effort reconnect handling; a terminal disconnect tears the backend down cleanly. */
  private wireConnectionLifecycle(): void {
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Recovering — discord.js will resume.
      } catch {
        this.log.warn("voice connection lost; destroying", {});
        void this.close();
      }
    });
  }
}

/** Resolve a voice channel by exact (case-insensitive) name within a guild, or null. */
export async function resolveVoiceChannel(
  client: Client,
  guildId: string,
  channelName: string,
): Promise<VoiceBasedChannel | null> {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const wanted = channelName.trim().toLowerCase();
  for (const channel of channels.values()) {
    if (channel && channel.isVoiceBased() && channel.name.toLowerCase() === wanted) {
      return channel;
    }
  }
  return null;
}

/**
 * Build a {@link VoiceBackendFactory} bound to a live discord.js {@link Client}. The daemon wires
 * this into the {@link ../voice/gateway.ts VoiceGateway}. Requires the `GuildVoiceStates` intent on
 * the client (without it `joinVoiceChannel` never reaches Ready).
 */
export function createDiscordVoiceBackendFactory(
  client: Client,
  opts: { logger?: Logger; silenceMs?: number; readyTimeoutMs?: number } = {},
): VoiceBackendFactory {
  const log = opts.logger ?? rootLog.child("voice.backend");
  return async ({ guildId, channelId }) => {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isVoiceBased()) {
      throw new Error(`channel ${channelId} in guild ${guildId} is not a voice channel`);
    }
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      // We must both hear (receive) and speak, so neither deaf nor mute.
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, opts.readyTimeoutMs ?? 20_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`voice connection to ${channelId} never became ready: ${String(err)}`);
    }
    log.info("voice connection ready", { guildId, channelId, channel: channel.name });
    return new DiscordJsVoiceBackend(connection, { logger: log, silenceMs: opts.silenceMs });
  };
}

/** Run a callback, logging (not throwing) if it fails — receive callbacks must never crash us. */
function safe(log: Logger, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.debug("voice backend callback threw", { error: String(err) });
  }
}
