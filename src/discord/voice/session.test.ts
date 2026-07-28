import { expect, test } from "bun:test";
import { DiscordVoiceSession } from "./session.ts";
import { FakeVoiceBackend } from "./fake-backend.ts";
import { VOICE_FRAME_BYTES } from "./types.ts";

function mkSession(backend: FakeVoiceBackend, opts: { bargeIn?: boolean } = {}) {
  return new DiscordVoiceSession({
    guildId: "g1",
    channelId: "c1",
    backend,
    bargeIn: opts.bargeIn,
  });
}

function frame(sample: number): Buffer {
  const b = Buffer.allocUnsafe(VOICE_FRAME_BYTES);
  for (let i = 0; i < VOICE_FRAME_BYTES; i += 2) b.writeInt16LE(sample, i);
  return b;
}

test("speak plays the exact PCM into the channel", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const pcm = frame(42);
  const handle = session.speak(pcm);
  expect(backend.played).toHaveLength(1);
  expect(backend.played[0]!.equals(pcm)).toBe(true);
  expect(session.isSpeaking()).toBe(true);
  backend.finishPlayback();
  await handle.done;
  expect(session.isSpeaking()).toBe(false);
});

test("cancel stops playback mid-sentence and resolves done", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const handle = session.speak(frame(1));
  expect(session.isSpeaking()).toBe(true);
  handle.cancel();
  expect(handle.cancelled).toBe(true);
  expect(backend.stopCount).toBe(1);
  await handle.done; // resolves without needing finishPlayback
  expect(session.isSpeaking()).toBe(false);
});

test("a remote speaker starting cancels in-flight playback (barge-in)", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const handle = session.speak(frame(1));
  expect(session.isSpeaking()).toBe(true);
  // Someone starts talking over Beckett.
  backend.emitSpeakingStart("human");
  expect(handle.cancelled).toBe(true);
  expect(backend.stopCount).toBe(1);
  await handle.done;
  expect(session.isSpeaking()).toBe(false);
});

test("barge-in can be disabled", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend, { bargeIn: false });
  const handle = session.speak(frame(1));
  backend.emitSpeakingStart("human");
  expect(handle.cancelled).toBe(false);
  expect(session.isSpeaking()).toBe(true);
  handle.cancel();
  await handle.done;
});

test("a new speak supersedes the previous one", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const first = session.speak(frame(1));
  const second = session.speak(frame(2));
  expect(first.cancelled).toBe(true);
  await first.done;
  expect(backend.played).toHaveLength(2);
  expect(session.isSpeaking()).toBe(true);
  backend.finishPlayback();
  await second.done;
});

test("utterances from the receive path reach session subscribers", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const seen: string[] = [];
  session.onUtterance((u) => seen.push(`${u.userId}:${u.pcm.length}`));
  backend.emitSpeakingStart("alice");
  backend.emitPcm("alice", frame(5));
  backend.emitSpeakingEnd("alice");
  expect(seen).toEqual([`alice:${VOICE_FRAME_BYTES}`]);
});

test("leave flushes an open utterance, cancels playback, and closes the backend", async () => {
  const backend = new FakeVoiceBackend();
  const session = mkSession(backend);
  const seen: string[] = [];
  session.onUtterance((u) => seen.push(u.userId));
  const speaking = session.speak(frame(1));
  backend.emitSpeakingStart("alice");
  backend.emitPcm("alice", frame(5));
  // no explicit stop — leave should still surface alice's captured audio
  await session.leave();
  expect(seen).toEqual(["alice"]);
  expect(backend.closed).toBe(true);
  expect(speaking.cancelled).toBe(true);
});
