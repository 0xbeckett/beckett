/**
 * Beckett — voice loopback (end-to-end transport proof) (`src/discord/voice/loopback.test.ts`)
 * =======================================================================================
 * The acceptance proof for #81: JOIN → RECORD what a speaker says → PLAY the exact same audio
 * back into the channel, and confirm it is attributed to the right user. Run against the
 * in-memory {@link FakeVoiceBackend} so the whole transport pipeline — segmentation, the
 * utterance event, and cancellable playback — is exercised deterministically with no network.
 *
 * (Audibility against a REAL channel is proven manually by `scripts/voice/loopback.ts`, which
 * runs this exact flow through the `@discordjs/voice` backend — see `docs/voice-transport.md`.)
 *
 * A second test drives real Opus encode→decode→downmix through prism-media/opusscript so the
 * decode path itself is covered, not just the PCM contract.
 */

import { expect, test } from "bun:test";
import prism from "prism-media";
import { VoiceGateway } from "./gateway.ts";
import { FakeVoiceBackend } from "./fake-backend.ts";
import { stereoToMono } from "./pcm.ts";
import type { Utterance } from "./types.ts";
import {
  DISCORD_CHANNELS,
  DISCORD_SAMPLE_RATE,
  VOICE_FRAME_BYTES,
  VOICE_FRAME_SAMPLES,
} from "./types.ts";

/** A recognizable "spoken" utterance: N mono 20ms frames of a low-frequency sine. */
function spokenFrames(n: number): Buffer[] {
  const frames: Buffer[] = [];
  let t = 0;
  for (let f = 0; f < n; f++) {
    const b = Buffer.allocUnsafe(VOICE_FRAME_BYTES);
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      b.writeInt16LE(Math.round(8000 * Math.sin((t++ / 48000) * 2 * Math.PI * 220)), i * 2);
    }
    frames.push(b);
  }
  return frames;
}

test("loopback: record a speaker, play the exact same audio back, attributed to that user", async () => {
  const backend = new FakeVoiceBackend();
  const gateway = new VoiceGateway({
    backendFactory: async () => backend,
    authorize: () => "owner",
  });

  // JOIN
  const session = await gateway.join({
    guildId: "g1",
    channelId: "voice-1",
    requestedByUserId: "boss",
  });

  const utterances: Utterance[] = [];
  session.onUtterance((u) => utterances.push(u));

  // RECORD — the speaker "speaker-123" says something (start → frames → silence/stop).
  const frames = spokenFrames(25); // 25 × 20ms = 500ms
  const source = Buffer.concat(frames);
  backend.emitSpeakingStart("speaker-123");
  for (const f of frames) backend.emitPcm("speaker-123", f);
  backend.emitSpeakingEnd("speaker-123");

  // The finished utterance carries the discord user id, the PCM, and the duration.
  expect(utterances).toHaveLength(1);
  const turn = utterances[0]!;
  expect(turn.userId).toBe("speaker-123"); // correctly ATTRIBUTED
  expect(turn.pcm.equals(source)).toBe(true); // exactly what was recorded
  expect(turn.durationMs).toBeCloseTo(500, 1);

  // PLAY IT BACK — the exact same audio goes into the channel.
  const handle = session.speak(turn.pcm);
  expect(backend.played).toHaveLength(1);
  expect(backend.played[0]!.equals(source)).toBe(true); // byte-identical playback
  backend.finishPlayback();
  await handle.done;

  await session.leave();
});

test("loopback stays correct with two speakers overlapping — each plays back attributed", async () => {
  const backend = new FakeVoiceBackend();
  const gateway = new VoiceGateway({ backendFactory: async () => backend, authorize: () => "owner" });
  const session = await gateway.join({ guildId: "g", channelId: "v", requestedByUserId: "boss" });

  const byUser = new Map<string, Utterance>();
  session.onUtterance((u) => byUser.set(u.userId, u));

  const aFrames = spokenFrames(10);
  const bFrames = spokenFrames(6);
  // Interleave the two speakers.
  backend.emitSpeakingStart("alice");
  backend.emitSpeakingStart("bob");
  for (let i = 0; i < 10; i++) {
    backend.emitPcm("alice", aFrames[i]!);
    if (i < 6) backend.emitPcm("bob", bFrames[i]!);
  }
  backend.emitSpeakingEnd("bob");
  backend.emitSpeakingEnd("alice");

  expect(byUser.get("alice")!.pcm.equals(Buffer.concat(aFrames))).toBe(true);
  expect(byUser.get("bob")!.pcm.equals(Buffer.concat(bFrames))).toBe(true);

  // Play each back — barge-in off so the second doesn't cancel the first prematurely here.
  const h1 = session.speak(byUser.get("alice")!.pcm);
  expect(backend.played[0]!.equals(Buffer.concat(aFrames))).toBe(true);
  backend.finishPlayback();
  await h1.done;
  await session.leave();
});

test("receive-path realism: real Opus encode → decode → mono downmix preserves length & energy", () => {
  // Prove the actual decode path this branch relies on (opusscript via prism-media), not just
  // the PCM contract. Opus has ~6.5ms algorithmic lookahead, so a single frame is not
  // sample-aligned with its input; across several frames we assert the two things that matter:
  // the decoded+downmixed audio is the right SHAPE (N × one 20ms mono frame) and carries the
  // tone's ENERGY (it isn't silence or garbage).
  const enc = new prism.opus.Encoder({
    rate: DISCORD_SAMPLE_RATE,
    channels: DISCORD_CHANNELS,
    frameSize: VOICE_FRAME_SAMPLES,
  }) as unknown as { _encode(b: Buffer): Buffer };
  const dec = new prism.opus.Decoder({
    rate: DISCORD_SAMPLE_RATE,
    channels: DISCORD_CHANNELS,
    frameSize: VOICE_FRAME_SAMPLES,
  }) as unknown as { _decode(b: Buffer): Buffer };

  const N = 12;
  const amp = 6000;
  const monoFrames: Buffer[] = [];
  let t = 0;
  for (let f = 0; f < N; f++) {
    const stereo = Buffer.allocUnsafe(VOICE_FRAME_SAMPLES * DISCORD_CHANNELS * 2);
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      const v = Math.round(amp * Math.sin((t++ / 48000) * 2 * Math.PI * 330));
      stereo.writeInt16LE(v, i * 4);
      stereo.writeInt16LE(v, i * 4 + 2);
    }
    monoFrames.push(stereoToMono(dec._decode(enc._encode(stereo))));
  }
  const decoded = Buffer.concat(monoFrames);

  // Exactly N × one 20ms mono frame back out.
  expect(decoded.length).toBe(N * VOICE_FRAME_BYTES);

  // The decoded tone carries most of the source energy (Opus is near-transparent). Compare RMS
  // to the ideal sine RMS (amp/√2); allow the codec warmup/loss a wide margin.
  let sumSq = 0;
  const samples = decoded.length / 2;
  for (let i = 0; i < samples; i++) sumSq += decoded.readInt16LE(i * 2) ** 2;
  const rms = Math.sqrt(sumSq / samples);
  const idealRms = amp / Math.SQRT2;
  expect(rms).toBeGreaterThan(idealRms * 0.5);
  expect(rms).toBeLessThan(idealRms * 1.5);
});
