import { expect, test } from "bun:test";
import { monoToStereo, stereoToMono, pcmDurationMs } from "./pcm.ts";
import { VOICE_SAMPLE_RATE } from "./types.ts";

/** Build a mono s16le buffer from sample values. */
function mono(...samples: number[]): Buffer {
  const b = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

test("monoToStereo duplicates each sample into both channels", () => {
  const stereo = monoToStereo(mono(100, -200, 32767));
  expect(stereo.length).toBe(3 * 4);
  expect(stereo.readInt16LE(0)).toBe(100);
  expect(stereo.readInt16LE(2)).toBe(100);
  expect(stereo.readInt16LE(4)).toBe(-200);
  expect(stereo.readInt16LE(6)).toBe(-200);
  expect(stereo.readInt16LE(8)).toBe(32767);
  expect(stereo.readInt16LE(10)).toBe(32767);
});

test("mono → stereo → mono is exact (playback preserves the recorded signal)", () => {
  const source = mono(0, 1, -1, 500, -500, 32767, -32768, 12345);
  const round = stereoToMono(monoToStereo(source));
  expect(round.equals(source)).toBe(true);
});

test("stereoToMono averages the two channels without clipping the extremes", () => {
  // L/R interleaved: (32767,32767) and (-32768,-32768) — averages stay in range.
  const stereo = Buffer.allocUnsafe(2 * 4);
  stereo.writeInt16LE(32767, 0);
  stereo.writeInt16LE(32767, 2);
  stereo.writeInt16LE(-32768, 4);
  stereo.writeInt16LE(-32768, 6);
  const m = stereoToMono(stereo);
  expect(m.readInt16LE(0)).toBe(32767);
  expect(m.readInt16LE(2)).toBe(-32768);
});

test("stereoToMono drops a torn trailing sample rather than reading past the buffer", () => {
  const stereo = Buffer.alloc(4 + 3); // one whole stereo frame + a torn 3 bytes
  expect(stereoToMono(stereo).length).toBe(2);
});

test("pcmDurationMs matches the 48kHz mono s16le rate (96 bytes/ms)", () => {
  // one second of mono 48k s16le = 48000 * 2 = 96000 bytes
  expect(pcmDurationMs(96_000)).toBeCloseTo(1000, 6);
  expect(pcmDurationMs(VOICE_SAMPLE_RATE * 2 * 2)).toBeCloseTo(2000, 6);
  expect(pcmDurationMs(0)).toBe(0);
});
