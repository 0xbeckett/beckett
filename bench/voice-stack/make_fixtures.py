"""Generate STT test fixtures (3s, 5s, 10s of natural speech) using Kokoro.

whisper.cpp wants 16kHz mono WAV. Kokoro emits 24kHz; we resample by
linear interpolation (good enough for a fixed benchmark input) and pad/trim
to the exact target duration so the STT latency numbers map to a known
utterance length.
"""
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

SR = 16000
LONG_TEXT = (
    "Hey, quick question about the deployment we shipped this morning. "
    "I noticed the worker queue backed up around nine and then cleared on its own, "
    "but I want to make sure we understand why before it happens again tonight. "
    "Can you pull the metrics for the last six hours and let me know what you find, "
    "and whether we need to bump the concurrency limit before the evening traffic spike."
)

k = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
samples, sr = k.create(LONG_TEXT, voice="af_heart", speed=1.0, lang="en-us")
samples = np.asarray(samples, dtype=np.float32)

# resample 24k -> 16k
n_out = int(round(len(samples) * SR / sr))
resampled = np.interp(
    np.linspace(0, len(samples) - 1, n_out), np.arange(len(samples)), samples
).astype(np.float32)

for secs in (3, 5, 10):
    want = SR * secs
    clip = resampled[:want]
    if len(clip) < want:  # pad with silence if source too short
        clip = np.pad(clip, (0, want - len(clip)))
    sf.write(f"fixtures/utt_{secs}s.wav", clip, SR)
    print(f"wrote fixtures/utt_{secs}s.wav  {len(clip)/SR:.2f}s")
