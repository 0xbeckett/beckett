/**
 * Beckett — Discord voice transport: the internal contract (`src/discord/voice/types.ts`)
 * =======================================================================================
 * This branch (#81) is TRANSPORT ONLY — join a voice channel, receive per-speaker audio,
 * play audio back. There is deliberately NO speech recognition and NO synthesis here; those
 * are the next branch, which consumes exactly the small interface defined in this file:
 *
 *   - an {@link Utterance} event per finished turn — (discord user id, PCM, duration), and
 *   - a cancellable {@link VoiceSession.speak} call that speaks PCM into the channel.
 *
 * ── PCM format, and why (read `bench/voice-stack/RESULTS.md` first) ──────────────────────
 * Discord's voice wire format is 48 kHz, 2-channel, signed-16-bit-LE Opus in 20 ms frames
 * (960 samples/channel). RESULTS.md measured the whole point of this project's constraint:
 * on the target 2014 Haswell (4 cores, only ~2 free under worker load) the *future* STT+TTS
 * stack already blows a ~1.5 s budget by 4×. CPU is the entire constraint. So the transport
 * layer does the CHEAPEST correct transform and nothing speculative:
 *
 *   decode Opus → 48 kHz s16le PCM   (unavoidable), then downmix stereo → MONO (one add+shift
 *   per sample). We do NOT resample 48 k → 16 k here.
 *
 * Reasoning, point by point:
 *   • No resample in the hot path. A 48→16 kHz resample every 20 ms frame would burn cycles
 *     the STT/TTS halves cannot spare (RESULTS: each half alone already exceeds the budget).
 *     Whatever rate a future STT wants, it can resample once per finished utterance — batched,
 *     off the frame path — not 50×/second in the receive loop.
 *   • Mono halves every downstream buffer (Kokoro alone is ~1.3 GB RSS in RESULTS; memory is
 *     real budget too) and mono is already what an STT wants.
 *   • Staying at Discord's native 48 kHz keeps playback EXACT: mono → stereo re-expansion is
 *     lossless channel duplication, so "play the exact same audio back" is faithful.
 *
 * Frames are 20 ms (= {@link VOICE_FRAME_SAMPLES}); per-utterance memory is bounded by
 * {@link DEFAULT_MAX_UTTERANCE_MS} so an open mic can never grow a buffer without limit.
 */

import type { AccessLevel } from "../access.ts";

/** Sample rate of decoded PCM — Discord-native; never resampled in this layer. */
export const VOICE_SAMPLE_RATE = 48_000;
/** Decoded PCM is downmixed to a single channel (see file header for the rationale). */
export const VOICE_CHANNELS = 1;
/** signed 16-bit little-endian. */
export const VOICE_BYTES_PER_SAMPLE = 2;
/** Samples per 20 ms Opus frame, per channel (48000 × 0.02). */
export const VOICE_FRAME_SAMPLES = 960;
/** Bytes in one 20 ms MONO frame of decoded PCM (960 × 2). */
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * VOICE_BYTES_PER_SAMPLE;

/** Discord's on-the-wire audio is always 48 kHz STEREO; the real backend decodes/encodes it. */
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;

/**
 * How long a speaker must be silent before their turn is considered finished. Discord's own
 * receiver ends an `AfterSilence` subscription at this boundary — that IS the "speaking stop"
 * signal we segment on. 800 ms is long enough to ride over natural mid-sentence pauses without
 * splitting one utterance in two, short enough that a turn surfaces promptly.
 */
export const DEFAULT_SILENCE_MS = 800;

/**
 * Hard cap on a single utterance's audio. A stuck-open mic (or someone who simply never stops)
 * must not grow an unbounded buffer on a memory-tight box. At the cap the current segment is
 * finalized and emitted, and a fresh segment continues — the audio is chunked, never dropped.
 * 30 s is far above the 3–10 s turns RESULTS.md benchmarks; it is a safety bound, not a target.
 */
export const DEFAULT_MAX_UTTERANCE_MS = 30_000;

/** The decoded PCM shape every {@link Utterance} and {@link VoiceSession.speak} buffer carries. */
export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
}

/** The canonical decode/playback format for this layer: 48 kHz, mono, s16le. */
export const VOICE_PCM_FORMAT: PcmFormat = {
  sampleRate: VOICE_SAMPLE_RATE,
  channels: VOICE_CHANNELS,
  bytesPerSample: VOICE_BYTES_PER_SAMPLE,
};

/**
 * One finished spoken turn from one person. Overlapping speakers never share an utterance —
 * the segmenter keys everything by {@link userId}, so two people talking at once produce two
 * independent utterances. This is the event the next (STT) branch subscribes to.
 */
export interface Utterance {
  /** Discord user id (snowflake) of the speaker. */
  userId: string;
  /** The turn's audio: 48 kHz mono s16le PCM ({@link VOICE_PCM_FORMAT}). */
  pcm: Buffer;
  /** Duration in milliseconds, derived from the actual decoded byte length (not wall clock). */
  durationMs: number;
  /** Epoch ms when the speaking-start signal opened this turn (for ordering/correlation). */
  startedAt: number;
}

/**
 * A handle to one in-flight {@link VoiceSession.speak} call. The whole reason it exists is
 * barge-in: {@link cancel} stops the audio mid-sentence, so Beckett can shut up the instant a
 * human starts talking over it.
 */
export interface SpeechHandle {
  /** Resolves when playback finishes naturally OR is cancelled. Never rejects. */
  readonly done: Promise<void>;
  /** True once {@link cancel} has been called (or barge-in cancelled it). */
  readonly cancelled: boolean;
  /** Stop this playback immediately. Idempotent; a no-op once already finished/cancelled. */
  cancel(): void;
}

/**
 * A live connection to one voice channel. Created by {@link VoiceGateway.join}. The next branch
 * holds exactly this object: it listens for utterances and speaks replies back.
 */
export interface VoiceSession {
  readonly guildId: string;
  readonly channelId: string;
  /** Subscribe to finished utterances. Returns an unsubscribe function. */
  onUtterance(cb: (u: Utterance) => void): () => void;
  /** Speak a 48 kHz mono s16le PCM buffer into the channel. Cancellable mid-sentence. */
  speak(pcm: Buffer): SpeechHandle;
  /** Whether Beckett is currently speaking. */
  isSpeaking(): boolean;
  /** Leave the channel and release the connection. Any open utterance is flushed first. */
  leave(): Promise<void>;
}

/**
 * The network seam. The pure session (segmentation, playback state machine, barge-in) is
 * written against this interface so it is fully testable with an in-memory fake; the real
 * implementation ({@link ../voice/backend-discordjs.ts}) wraps `@discordjs/voice`.
 *
 * Receive side: the backend emits speaking start/stop plus DECODED mono 48 kHz frames — all
 * Opus decoding and stereo→mono downmix live below this line. Playback side: {@link play}
 * takes mono PCM and handles mono→stereo, Opus encode, and pacing.
 */
export interface VoiceBackend {
  /** A speaker started talking (Discord "speaking start"). */
  onSpeakingStart(cb: (userId: string) => void): void;
  /** A speaker's turn ended after silence (Discord "speaking stop"). */
  onSpeakingEnd(cb: (userId: string) => void): void;
  /** A decoded 48 kHz mono s16le PCM frame arrived for a speaker. */
  onPcm(cb: (userId: string, pcm: Buffer) => void): void;
  /**
   * Play a 48 kHz mono s16le buffer into the channel. Resolves when the audio finishes OR when
   * {@link stopPlayback} interrupts it — never rejects (a playback error is logged and treated
   * as "finished" so a caller's `done` promise always settles).
   */
  play(pcm: Buffer): Promise<void>;
  /** Interrupt whatever is currently playing. Safe to call when nothing is playing. */
  stopPlayback(): void;
  /** Tear down the connection and free resources. */
  close(): Promise<void>;
}

/** Re-export so callers gate on the same access levels the four elevated verbs use. */
export type { AccessLevel };
