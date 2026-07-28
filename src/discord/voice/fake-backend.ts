/**
 * Beckett — in-memory voice backend for tests (`src/discord/voice/fake-backend.ts`)
 * =======================================================================================
 * A {@link VoiceBackend} with no network and no native deps. Tests drive the receive side by
 * calling {@link emitSpeakingStart}/{@link emitPcm}/{@link emitSpeakingEnd}, and inspect the
 * playback side via {@link played}. This is the seam that lets the whole transport pipeline —
 * segmentation, playback, barge-in, and the end-to-end loopback — be proven deterministically.
 *
 * It is intentionally shipped (not a `.test.ts`) so the next branch can reuse it too.
 */

import type { VoiceBackend } from "./types.ts";

export class FakeVoiceBackend implements VoiceBackend {
  private readonly startCbs: Array<(userId: string) => void> = [];
  private readonly endCbs: Array<(userId: string) => void> = [];
  private readonly pcmCbs: Array<(userId: string, pcm: Buffer) => void> = [];

  /** Every buffer handed to {@link play}, in order — the "what got spoken" record. */
  readonly played: Buffer[] = [];
  /** True while a play() promise is outstanding (not yet finished or interrupted). */
  playing = false;
  closed = false;
  /** Count of stopPlayback() calls — lets tests assert a barge-in actually interrupted. */
  stopCount = 0;
  private resolveCurrent: (() => void) | undefined;

  // ── receive side: tests call these to simulate speakers ──────────────────────────────
  emitSpeakingStart(userId: string): void {
    for (const cb of this.startCbs) cb(userId);
  }
  emitPcm(userId: string, pcm: Buffer): void {
    for (const cb of this.pcmCbs) cb(userId, pcm);
  }
  emitSpeakingEnd(userId: string): void {
    for (const cb of this.endCbs) cb(userId);
  }
  /** Simulate playback finishing naturally (resolves the outstanding play() promise). */
  finishPlayback(): void {
    const r = this.resolveCurrent;
    this.resolveCurrent = undefined;
    this.playing = false;
    r?.();
  }

  // ── VoiceBackend contract ────────────────────────────────────────────────────────────
  onSpeakingStart(cb: (userId: string) => void): void {
    this.startCbs.push(cb);
  }
  onSpeakingEnd(cb: (userId: string) => void): void {
    this.endCbs.push(cb);
  }
  onPcm(cb: (userId: string, pcm: Buffer) => void): void {
    this.pcmCbs.push(cb);
  }
  async play(pcm: Buffer): Promise<void> {
    // supersede any prior outstanding playback (mirrors the real backend)
    this.finishPlayback();
    this.played.push(pcm);
    this.playing = true;
    await new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
    });
  }
  stopPlayback(): void {
    this.stopCount++;
    this.finishPlayback();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.finishPlayback();
  }
}
