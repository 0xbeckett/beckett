# Discord voice transport (#81)

Transport-only wiring of the Discord voice gateway into the daemon: **join** a voice
channel, **receive** per-speaker audio, **play** audio back. There is deliberately **no
speech recognition and no synthesis** in this branch — those are the next branch, which
consumes exactly the small interface described here.

## The interface the next branch consumes

Everything lives under `src/discord/voice/` and is defined in `types.ts`.

```ts
interface VoiceSession {
  onUtterance(cb: (u: Utterance) => void): () => void; // per finished turn
  speak(pcm: Buffer): SpeechHandle;                    // play PCM in; cancellable
  isSpeaking(): boolean;
  leave(): Promise<void>;
}

interface Utterance {
  userId: string;    // discord snowflake of the speaker
  pcm: Buffer;       // 48 kHz mono s16le
  durationMs: number;
  startedAt: number; // epoch ms of speaking-start
}

interface SpeechHandle {
  readonly done: Promise<void>; // resolves on finish OR cancel
  readonly cancelled: boolean;
  cancel(): void;               // stop mid-sentence (barge-in)
}
```

Get a session from the `VoiceGateway` (`gateway.ts`):

```ts
const session = await voiceGateway.join({ guildId, channelId, requestedByUserId });
session.onUtterance(u => { /* next branch: hand u.pcm to STT */ });
const handle = session.speak(pcm);     // next branch: hand TTS PCM here
// … a human starts talking → handle.cancel() fires automatically (barge-in)
```

## Authorization — owner + maintainers only

Joining/leaving voice is a maintainer-grade action, the **same authority the four elevated
verbs (push / merge / deploy / restart) use**. `canControlVoice(level)` is `true` only for
`owner` and `maintainer`. The gate is **code-enforced** inside `VoiceGateway.join`/`leave`,
keyed off Discord's authenticated author id resolved through the same
`classify()` / `access.txt` / `maintainers.txt` machinery as the rest of the daemon — never
from chat content. A member or outsider is refused with a typed `VoiceAuthorizationError`,
and the backend is never even opened.

## Segmentation — per-speaker, per-utterance

`VoiceSegmenter` (`segmenter.ts`) turns low-level signals — speaking-start, decoded PCM
frames, speaking-stop — into one `Utterance` per turn, **keyed by user id**. Overlapping
speakers accumulate on independent segments and surface as independent utterances; there is
no global "current speaker". Segmentation is driven by **Discord's own speaking signals**:
the real backend opens an `EndBehaviorType.AfterSilence` subscription per speaker, and that
stream's end (silence) is the "speaking stop" boundary. A safety cap
(`DEFAULT_MAX_UTTERANCE_MS`, 30 s) chunks a stuck-open mic rather than growing an unbounded
buffer — audio is split across utterances, never dropped.

## Playback + barge-in

`speak(pcm)` plays a 48 kHz mono s16le buffer into the channel and returns a `SpeechHandle`.
`cancel()` stops it mid-sentence. The session also wires **automatic barge-in**: whenever a
remote speaker starts, any in-flight playback is cancelled (Beckett never receives its own
audio, so a speaking-start is always a human). A new `speak()` supersedes a previous one.

## PCM format & buffer sizes — read `bench/voice-stack/RESULTS.md` first

Discord's wire format is 48 kHz **stereo** s16le Opus in 20 ms frames (960 samples/channel).
RESULTS.md measured the whole constraint: on the target 2014 Haswell (4 cores, ~2 free under
worker load) the *future* STT+TTS stack already blows a ~1.5 s budget by ~4×. **CPU is the
entire budget.** So this layer does the cheapest correct transform and nothing speculative:

- **Decode Opus → 48 kHz s16le, then downmix stereo → mono** (one add + shift per sample).
- **No 48 k → 16 k resample in the frame path.** Resampling 50×/second would burn cycles the
  STT/TTS halves can't spare. Whatever rate a future STT wants, it resamples **once per
  finished utterance** — batched, off the hot path.
- **Mono** halves every downstream buffer (Kokoro alone is ~1.3 GB RSS in RESULTS; memory is
  budget too) and is already what an STT wants.
- **Staying at Discord-native 48 kHz** keeps playback exact: mono → stereo re-expansion is
  lossless duplication, so "play the exact same audio back" is faithful.

Frames are 20 ms; per-utterance memory is bounded by the 30 s cap. See the header of
`types.ts` for the full rationale.

## Runtime dependencies

The `@discordjs/voice` backend (`backend-discordjs.ts`) is imported **lazily** by the daemon,
so a box missing the optional deps degrades to "voice join fails with a clear error" instead
of failing boot. `bun install` brings them:

- `@discordjs/voice` + `prism-media` — connection, receive streams, playback.
- `opusscript` — pure-JS Opus codec (no native build; works under Bun).
- `libsodium-wrappers` — encryption (native `aes-256-gcm` is also used when available).

The gateway also needs the non-privileged `GuildVoiceStates` intent, added in
`src/discord/gateway.ts`.

## Proving it — the loopback

**Automated (CI):** `src/discord/voice/loopback.test.ts` runs join → record → play-back
through the in-memory `FakeVoiceBackend` and asserts the finished utterance carries the right
user id, the exact recorded PCM, and the correct duration, and that the exact same bytes reach
the playback path. Concurrent speakers and the real Opus decode path are covered too.

**Live (manual audibility):**

```bash
DISCORD_TOKEN=... DISCORD_OWNER_ID=<your id> \
  bun scripts/voice/loopback.ts --guild <guildId> --channel "<voice channel name>"
```

Join the named channel, run it, and speak — the script echoes your first utterance back into
the channel and prints the user id it attributed the audio to.
