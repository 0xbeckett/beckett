/**
 * Beckett — per-speaker utterance segmentation (`src/discord/voice/segmenter.ts`)
 * =======================================================================================
 * Pure, backend-free core of the receive path. It turns a stream of low-level signals —
 * speaking-start, decoded PCM frames, speaking-stop — into one {@link Utterance} per finished
 * turn, keyed by Discord user id.
 *
 * The one invariant that matters: OVERLAPPING SPEAKERS STAY SEPARATE. Everything is keyed by
 * userId, so two people talking at once accumulate into two independent segments and surface as
 * two independent utterances. There is no global "current speaker".
 *
 * Segmentation is driven by Discord's OWN speaking signals (start → open a segment, stop →
 * finalize it), exactly as the ticket requires — this layer never does its own VAD. A safety
 * cap ({@link SegmenterOptions.maxUtteranceMs}) bounds per-turn memory: past the cap the segment
 * is finalized and emitted, and a fresh one continues, so audio is chunked, never dropped.
 */

import {
  DEFAULT_MAX_UTTERANCE_MS,
  VOICE_SAMPLE_RATE,
  VOICE_BYTES_PER_SAMPLE,
  type Utterance,
} from "./types.ts";
import { pcmDurationMs } from "./pcm.ts";

/** Bytes of 48 kHz mono s16le PCM that hold `ms` milliseconds of audio. */
function msToBytes(ms: number): number {
  return Math.floor((ms / 1000) * VOICE_SAMPLE_RATE) * VOICE_BYTES_PER_SAMPLE;
}

export interface SegmenterOptions {
  /** Per-utterance safety cap (default {@link DEFAULT_MAX_UTTERANCE_MS}). */
  maxUtteranceMs?: number;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** One speaker's in-progress turn. */
interface OpenSegment {
  chunks: Buffer[];
  byteLen: number;
  startedAt: number;
}

/**
 * Accumulates decoded PCM frames per speaker between speaking-start and speaking-stop, emitting
 * one {@link Utterance} per finished turn. Fully synchronous and side-effect free apart from the
 * registered {@link onUtterance} callbacks.
 */
export class VoiceSegmenter {
  private readonly open = new Map<string, OpenSegment>();
  private readonly listeners = new Set<(u: Utterance) => void>();
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: SegmenterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxBytes = msToBytes(opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS);
  }

  /** Register an utterance listener. Returns an unsubscribe function. */
  onUtterance(cb: (u: Utterance) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Discord signalled this user started speaking. Opens a fresh segment. If one was somehow
   * already open (a missed stop), it is finalized first so no audio is silently merged across
   * two turns.
   */
  speakingStart(userId: string, at: number = this.now()): void {
    const existing = this.open.get(userId);
    if (existing) this.finalize(userId, existing);
    this.open.set(userId, { chunks: [], byteLen: 0, startedAt: at });
  }

  /**
   * A decoded 48 kHz mono s16le frame for this user. Frames arriving before an explicit
   * speaking-start still open a segment defensively (the decoded stream can lead the speaking
   * event by a frame or two), so no leading audio is lost.
   */
  pushFrame(userId: string, frame: Buffer): void {
    if (frame.length === 0) return;
    let seg = this.open.get(userId);
    if (!seg) {
      seg = { chunks: [], byteLen: 0, startedAt: this.now() };
      this.open.set(userId, seg);
    }
    seg.chunks.push(frame);
    seg.byteLen += frame.length;
    // Safety cap: emit what we have and continue in a fresh segment so a stuck mic can't grow an
    // unbounded buffer. The continuation keeps the audio contiguous, just split across utterances.
    if (seg.byteLen >= this.maxBytes) {
      this.finalize(userId, seg);
      this.open.set(userId, { chunks: [], byteLen: 0, startedAt: this.now() });
    }
  }

  /** Discord signalled this user stopped (silence). Finalizes and emits their turn, if any. */
  speakingStop(userId: string): void {
    const seg = this.open.get(userId);
    if (!seg) return;
    this.finalize(userId, seg);
  }

  /** Finalize every open segment (used on leave/teardown so nothing in flight is dropped). */
  flushAll(): void {
    for (const [userId, seg] of [...this.open]) this.finalize(userId, seg);
  }

  /** How many speakers currently have an open segment (test/introspection aid). */
  openCount(): number {
    return this.open.size;
  }

  private finalize(userId: string, seg: OpenSegment): void {
    this.open.delete(userId);
    if (seg.byteLen === 0) return; // a start with no audio is not an utterance
    const pcm = seg.chunks.length === 1 ? seg.chunks[0]! : Buffer.concat(seg.chunks, seg.byteLen);
    const utterance: Utterance = {
      userId,
      pcm,
      durationMs: pcmDurationMs(pcm.length),
      startedAt: seg.startedAt,
    };
    for (const cb of [...this.listeners]) {
      try {
        cb(utterance);
      } catch {
        // A listener throwing must not corrupt segmentation or drop other listeners.
      }
    }
  }
}
