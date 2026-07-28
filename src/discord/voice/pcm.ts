/**
 * Beckett — voice PCM helpers (`src/discord/voice/pcm.ts`)
 * =======================================================================================
 * The two cheap sample-format transforms this transport layer is allowed to do, plus a
 * duration helper. Pure, allocation-honest, and unit-tested. Deliberately NO resampling —
 * see `types.ts` and `bench/voice-stack/RESULTS.md` for why the frame path stays at 48 kHz.
 *
 * All PCM here is signed 16-bit little-endian. "Frame" = interleaved samples.
 */

import { VOICE_SAMPLE_RATE, VOICE_BYTES_PER_SAMPLE, type PcmFormat } from "./types.ts";

/**
 * Downmix interleaved 48 kHz STEREO s16le → MONO by averaging the two channels. One add + one
 * arithmetic shift per output sample — the whole reason we can afford to do it per frame. A
 * trailing odd byte (a torn half-sample) is dropped rather than trusted.
 */
export function stereoToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4); // 2 channels × 2 bytes
  const mono = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    // (l + r) can be up to ±65534; the >>1 keeps it in Int16 range without clipping.
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}

/**
 * Expand MONO s16le → interleaved STEREO by duplicating each sample into both channels.
 * Lossless: the inverse round-trip of {@link stereoToMono} is not bit-exact (averaging is
 * lossy), but mono→stereo→(played) preserves the mono signal perfectly, which is what the
 * loopback "play the exact same audio back" needs.
 */
export function monoToStereo(mono: Buffer): Buffer {
  const samples = Math.floor(mono.length / 2);
  const stereo = Buffer.allocUnsafe(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s = mono.readInt16LE(i * 2);
    stereo.writeInt16LE(s, i * 4);
    stereo.writeInt16LE(s, i * 4 + 2);
  }
  return stereo;
}

/** Milliseconds of audio in a PCM buffer, from its byte length and format. */
export function pcmDurationMs(
  byteLength: number,
  format: PcmFormat = { sampleRate: VOICE_SAMPLE_RATE, channels: 1, bytesPerSample: VOICE_BYTES_PER_SAMPLE },
): number {
  const bytesPerSecond = format.sampleRate * format.channels * format.bytesPerSample;
  if (bytesPerSecond <= 0) return 0;
  return (byteLength / bytesPerSecond) * 1000;
}
