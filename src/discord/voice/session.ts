/**
 * Beckett — voice session (`src/discord/voice/session.ts`)
 * =======================================================================================
 * Glues the {@link VoiceBackend} (network seam) to the pure {@link VoiceSegmenter} and a small
 * playback state machine, and exposes the frozen {@link VoiceSession} contract the next branch
 * consumes. Backend-agnostic: the real `@discordjs/voice` adapter and the in-memory test fake
 * plug in identically.
 *
 * Barge-in is the interesting behaviour. The ticket wants playback that can "stop mid-sentence
 * when someone starts talking over it": whenever a remote speaker starts, any in-flight
 * {@link speak} is cancelled. (Beckett never receives its own audio, so a speaking-start is
 * always a human — safe to treat as a barge-in.) The same {@link SpeechHandle.cancel} is also
 * exposed for a caller to stop playback explicitly.
 */

import type { Logger } from "../../types.ts";
import type { SpeechHandle, Utterance, VoiceBackend, VoiceSession } from "./types.ts";
import { VoiceSegmenter, type SegmenterOptions } from "./segmenter.ts";

/** One in-flight playback. Owns its `done` promise and the backend's stop hook. */
class Speech implements SpeechHandle {
  cancelled = false;
  private settled = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;
  private stop: (() => void) | undefined;

  constructor() {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Begin playback. If already cancelled before start, resolves without touching the backend. */
  run(play: () => Promise<void>, stop: () => void): void {
    this.stop = stop;
    if (this.cancelled) {
      this.finish();
      return;
    }
    play().then(
      () => this.finish(),
      () => this.finish(), // play() never rejects by contract, but settle defensively.
    );
  }

  cancel(): void {
    if (this.cancelled || this.settled) {
      this.cancelled = true;
      return;
    }
    this.cancelled = true;
    // Interrupt the backend; its play() promise resolves, which drives finish() via run().
    this.stop?.();
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone();
  }
}

export interface VoiceSessionOptions extends SegmenterOptions {
  guildId: string;
  channelId: string;
  backend: VoiceBackend;
  logger?: Logger;
  /** Cancel in-flight playback when a remote speaker starts (default true). */
  bargeIn?: boolean;
}

/** Concrete {@link VoiceSession}. One per joined channel. */
export class DiscordVoiceSession implements VoiceSession {
  readonly guildId: string;
  readonly channelId: string;
  private readonly backend: VoiceBackend;
  private readonly segmenter: VoiceSegmenter;
  private readonly log: Logger | undefined;
  private readonly bargeIn: boolean;
  private readonly utteranceListeners = new Set<(u: Utterance) => void>();
  private active: Speech | undefined;
  private left = false;

  constructor(opts: VoiceSessionOptions) {
    this.guildId = opts.guildId;
    this.channelId = opts.channelId;
    this.backend = opts.backend;
    this.log = opts.logger;
    this.bargeIn = opts.bargeIn ?? true;
    this.segmenter = new VoiceSegmenter({ maxUtteranceMs: opts.maxUtteranceMs, now: opts.now });

    // Fan finished utterances out to the session's own subscribers.
    this.segmenter.onUtterance((u) => {
      for (const cb of [...this.utteranceListeners]) {
        try {
          cb(u);
        } catch (err) {
          this.log?.error("voice utterance listener threw", { userId: u.userId, error: String(err) });
        }
      }
    });

    // Wire the backend's low-level receive signals into segmentation.
    this.backend.onSpeakingStart((userId) => {
      this.segmenter.speakingStart(userId);
      if (this.bargeIn && this.active && !this.active.cancelled) {
        this.log?.info("voice barge-in — cancelling playback", { userId, channelId: this.channelId });
        this.active.cancel();
      }
    });
    this.backend.onSpeakingEnd((userId) => this.segmenter.speakingStop(userId));
    this.backend.onPcm((userId, pcm) => this.segmenter.pushFrame(userId, pcm));
  }

  onUtterance(cb: (u: Utterance) => void): () => void {
    this.utteranceListeners.add(cb);
    return () => this.utteranceListeners.delete(cb);
  }

  speak(pcm: Buffer): SpeechHandle {
    const speech = new Speech();
    if (this.left) {
      // The channel is gone; return an already-finished, cancelled handle rather than throwing.
      speech.cancel();
      speech.run(async () => {}, () => {});
      return speech;
    }
    // Only one thing plays at a time: a new speak supersedes whatever was playing.
    if (this.active && !this.active.cancelled) this.active.cancel();
    this.active = speech;
    speech.run(
      () => this.backend.play(pcm),
      () => this.backend.stopPlayback(),
    );
    // Clear the active pointer once this speech settles, but only if it is still the current one.
    void speech.done.then(() => {
      if (this.active === speech) this.active = undefined;
    });
    return speech;
  }

  isSpeaking(): boolean {
    return this.active !== undefined && !this.active.cancelled;
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    if (this.active) this.active.cancel();
    // Finalize any open turns so a mid-utterance leave still surfaces what was captured.
    this.segmenter.flushAll();
    this.utteranceListeners.clear();
    await this.backend.close();
    this.log?.info("voice session left", { guildId: this.guildId, channelId: this.channelId });
  }
}
