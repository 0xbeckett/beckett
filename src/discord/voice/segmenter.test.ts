import { expect, test } from "bun:test";
import { VoiceSegmenter } from "./segmenter.ts";
import type { Utterance } from "./types.ts";
import { VOICE_FRAME_BYTES, VOICE_SAMPLE_RATE, VOICE_BYTES_PER_SAMPLE } from "./types.ts";

/** A 20ms mono frame filled with a constant sample so we can identify it later. */
function frame(sample: number): Buffer {
  const b = Buffer.allocUnsafe(VOICE_FRAME_BYTES);
  for (let i = 0; i < VOICE_FRAME_BYTES; i += 2) b.writeInt16LE(sample, i);
  return b;
}

function collect(seg: VoiceSegmenter): Utterance[] {
  const out: Utterance[] = [];
  seg.onUtterance((u) => out.push(u));
  return out;
}

test("start → frames → stop emits one utterance with the right user, pcm and duration", () => {
  const seg = new VoiceSegmenter({ now: () => 1_000 });
  const got = collect(seg);
  seg.speakingStart("alice");
  seg.pushFrame("alice", frame(1));
  seg.pushFrame("alice", frame(2));
  seg.speakingStop("alice");

  expect(got).toHaveLength(1);
  expect(got[0]!.userId).toBe("alice");
  expect(got[0]!.startedAt).toBe(1_000);
  expect(got[0]!.pcm.length).toBe(VOICE_FRAME_BYTES * 2);
  // 2 frames × 20ms = 40ms
  expect(got[0]!.durationMs).toBeCloseTo(40, 5);
  expect(got[0]!.pcm.readInt16LE(0)).toBe(1);
  expect(got[0]!.pcm.readInt16LE(VOICE_FRAME_BYTES)).toBe(2);
});

test("a speaking start with no audio does not emit an utterance", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  seg.speakingStart("bob");
  seg.speakingStop("bob");
  expect(got).toHaveLength(0);
});

test("concurrent speakers stay in separate utterances", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  // Interleave two speakers talking at the same time.
  seg.speakingStart("alice");
  seg.speakingStart("bob");
  seg.pushFrame("alice", frame(10));
  seg.pushFrame("bob", frame(20));
  seg.pushFrame("alice", frame(11));
  seg.speakingStop("bob"); // bob finishes first
  seg.pushFrame("alice", frame(12));
  seg.speakingStop("alice");

  expect(got).toHaveLength(2);
  const bob = got.find((u) => u.userId === "bob")!;
  const alice = got.find((u) => u.userId === "alice")!;
  // Bob's single frame never mixed with Alice's three.
  expect(bob.pcm.length).toBe(VOICE_FRAME_BYTES);
  expect(bob.pcm.readInt16LE(0)).toBe(20);
  expect(alice.pcm.length).toBe(VOICE_FRAME_BYTES * 3);
  expect(alice.pcm.readInt16LE(0)).toBe(10);
});

test("frames arriving before an explicit start still open a segment (no lost leading audio)", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  seg.pushFrame("carol", frame(7)); // decoded stream led the speaking event
  seg.speakingStop("carol");
  expect(got).toHaveLength(1);
  expect(got[0]!.pcm.readInt16LE(0)).toBe(7);
});

test("a second start finalizes a still-open prior turn rather than merging", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  seg.speakingStart("dave");
  seg.pushFrame("dave", frame(1));
  seg.speakingStart("dave"); // missed stop — should flush the first turn
  seg.pushFrame("dave", frame(2));
  seg.speakingStop("dave");
  expect(got).toHaveLength(2);
  expect(got[0]!.pcm.readInt16LE(0)).toBe(1);
  expect(got[1]!.pcm.readInt16LE(0)).toBe(2);
});

test("the max-utterance cap chunks a stuck-open mic instead of growing unbounded", () => {
  // Cap at 40ms = exactly two frames; a third frame forces a flush.
  const seg = new VoiceSegmenter({ maxUtteranceMs: 40 });
  const got = collect(seg);
  seg.speakingStart("eve");
  seg.pushFrame("eve", frame(1));
  seg.pushFrame("eve", frame(2)); // hits the cap → emits
  seg.pushFrame("eve", frame(3)); // continues in a fresh segment
  seg.speakingStop("eve");
  expect(got).toHaveLength(2);
  expect(got[0]!.pcm.length).toBe(VOICE_FRAME_BYTES * 2);
  expect(got[1]!.pcm.length).toBe(VOICE_FRAME_BYTES);
});

test("flushAll finalizes open turns on teardown", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  seg.speakingStart("frank");
  seg.pushFrame("frank", frame(9));
  expect(seg.openCount()).toBe(1);
  seg.flushAll();
  expect(got).toHaveLength(1);
  expect(seg.openCount()).toBe(0);
});

test("duration derives from decoded bytes, not wall clock", () => {
  const seg = new VoiceSegmenter();
  const got = collect(seg);
  const oneSecondBytes = VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE; // 1s mono
  seg.speakingStart("gina");
  seg.pushFrame("gina", Buffer.alloc(oneSecondBytes));
  seg.speakingStop("gina");
  expect(got[0]!.durationMs).toBeCloseTo(1000, 5);
});
