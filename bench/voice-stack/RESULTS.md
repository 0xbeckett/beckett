# Local voice-stack benchmark — results

**Question:** can a fully local voice stack (STT + TTS, no API) round-trip under
~1.5s on *this* box, and if not, which half is the bottleneck?

All numbers below are measured on this machine by `benchmark.py`. Every figure is
reported twice — idle, and under simulated worker load (2 CPU-pinned busy
processes). Median of 3 timed runs per case (one warmup discarded).

## Hardware / setup

- **CPU:** Intel(R) Core(TM) i7-4790 CPU @ 3.60GHz — 4 physical cores, AVX2, no AVX-512 (2014 Haswell class)
- **whisper.cpp** threads: 4 (= physical cores)
- **TTS:** hexgrad/Kokoro-82M via `kokoro-onnx` (~338 MB on disk: 311 MB ONNX + 27 MB voices), ONNX Runtime CPU
- **STT:** whisper.cpp `base.en` (142 MB), 4 threads
- **Load simulation:** 2 Python processes busy-spinning numpy matmul, each pinned to a
  physical core with `taskset`, so 2 of 4 cores are saturated during the loaded pass.

## TTS — Kokoro-82M (time-to-first-audio & realtime factor)

RTF = generation time / audio duration; below 1.0 is faster than realtime.

| Reply | Words | Audio dur | TTFA (idle) | TTFA (loaded) | RTF (idle) | RTF (loaded) |
|---|---|---|---|---|---|---|
| short | 15 | 4.33s | 2.633s | 3.502s | 0.608 | 0.809 |
| long | 66 | 21.25s | 9.909s | 14.531s | 0.466 | 0.684 |

Kokoro cold load (model init, one-time): **0.92s**.

## STT — whisper.cpp base.en (transcription latency)

| Utterance | Latency (idle) | Latency (loaded) | RTF (idle) | RTF (loaded) |
|---|---|---|---|---|
| 3s | 1.683s | 2.225s | 0.561 | 0.742 |
| 5s | 1.79s | 2.241s | 0.358 | 0.448 |
| 10s | 1.935s | 2.996s | 0.193 | 0.3 |

## Peak RSS per model

| Model | Peak RSS (idle) | Peak RSS (loaded) |
|---|---|---|
| Kokoro-82M (TTS, ONNX Runtime) | 1313.9 MB | 1309.9 MB |
| whisper.cpp base.en (STT) | 284.1 MB | 284.5 MB |

## End-to-end round trip

Audio stops → transcript → model turn (assumed **2.0s**, real model **not** called) →
first audio out. STT uses a representative 5s spoken turn; TTS uses the short reply.

| Segment | Idle | Loaded |
|---|---|---|
| STT (transcribe 5s utterance) | 1.79s | 2.241s |
| Model turn (assumed, not measured) | 2.0s | 2.0s |
| TTS time-to-first-audio (short reply) | 2.633s | 3.502s |
| **Voice-stack overhead (STT + TTS)** | **4.423s** | **5.743s** |
| **Full round trip (incl. 2s model)** | **6.423s** | **7.743s** |

## Verdict

**The ~1.5s target is judged against the voice-stack overhead — the two halves we control (STT + TTS first-audio) — because the 2s model turn is a fixed external constant we were told to assume.**

❌ **FAIL — not close.** Under load the voice stack adds **5.743s**, ~4x the ~1.5s bar. The heavier half is **TTS** (TTS first-audio 3.502s vs STT 2.241s), but this is not a one-bottleneck story: **each half on its own already exceeds 1.5s** under load (STT 2.241s, TTS 3.502s), and both are over 1.5s even idle (STT 1.79s, TTS 2.633s). No single fix lands the round trip under 1.5s on this hardware.

Counting the assumed 2s model turn, the full perceived round trip under load is **7.743s**.

### Why, and what would actually move the needle
- **TTS time-to-first-audio is the whole reply, not a first chunk.** `kokoro-onnx` only splits synthesis when a text exceeds its phoneme-window (~510 tokens); a 15-word reply is emitted as a single chunk, so *first* audio == *full* synthesis of the reply (3.502s loaded). Sentence-level chunking in the caller would cut perceived TTS latency for multi-sentence replies, but a short one-sentence reply stays one chunk. Kokoro's RTF is well under 1.0 (it synthesises faster than realtime) — the latency is purely the up-front generation of the first chunk.
- **STT is offline/batch here** — whisper.cpp transcribes the whole clip after audio stops. A streaming STT (or moonshine, or a smaller `tiny.en`) that decodes during speech would hide most of this behind the utterance.
- **Kokoro peak RSS is ~1.3GB** despite being an 82M-param model — that is ONNX Runtime's memory arena, not weights. On a box whose cores are already busy this is a real footprint to budget for; whisper base.en is a tame ~285MB.
- **Bottom line:** real-time (<1.5s) local voice on this 2014 Haswell under worker load is not achievable with this exact stack as measured. Getting there needs streaming STT + sentence-chunked TTS and, realistically, headroom (fewer competing workers or newer/faster silicon).

---
*Regenerate: `./run.sh` (runs the idle + loaded passes and rewrites this file).*
