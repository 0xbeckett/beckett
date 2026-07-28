"""Local voice-stack benchmark for this box (see RESULTS.md for the writeup).

One pass measures, for a given load condition:
  - TTS (Kokoro-82M / ONNX): time-to-first-audio + realtime factor, short & long reply
  - STT (whisper.cpp base.en): transcription latency for 3s / 5s / 10s utterances
  - peak RSS for each model
  - end-to-end round trip: STT + assumed 2s model turn + TTS time-to-first-audio

Run via run.sh (does idle + loaded and writes RESULTS.md). Direct use:
    uv run python benchmark.py --load 0 --out results/idle.json
    uv run python benchmark.py --load 2 --out results/loaded.json
"""
import argparse, asyncio, json, os, re, resource, signal, statistics, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).parent
KOKORO_MODEL = HERE / "models/kokoro-v1.0.onnx"
KOKORO_VOICES = HERE / "models/voices-v1.0.bin"
WHISPER_CLI = HERE / "whisper.cpp/build/bin/whisper-cli"
WHISPER_MODEL = HERE / "models/ggml-base.en.bin"
FIXTURES = HERE / "fixtures"

VOICE = "af_heart"
THREADS = 4  # box has 4 physical cores
REPS = 3     # measured runs per case; report the median

# ~15 words
SHORT_REPLY = ("Sure, I've pulled the metrics and the queue cleared on its own "
               "around nine fifteen.")
# ~60 words
LONG_REPLY = (
    "Okay, here's what I found. The worker queue backed up because two long "
    "running jobs grabbed both spare cores at the same time, so everything else "
    "waited behind them. It drained on its own once those finished, around nine "
    "fifteen. If you want to avoid it tonight, I'd bump the concurrency limit by "
    "one and cap the job runtime. Want me to make that change now?")

MODEL_TURN_ASSUMPTION = 2.0  # seconds; we do NOT call the real model here
ROUNDTRIP_UTT = 5            # representative spoken turn length for the round trip


def rss_mb_self():
    """Peak RSS of THIS process in MB (ru_maxrss is KB on Linux)."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


# ---------------------------------------------------------------- TTS (Kokoro)
async def _tts_once(kokoro, text):
    """One streamed synthesis. Returns (ttfa_s, total_gen_s, audio_dur_s)."""
    t0 = time.perf_counter()
    ttfa = None
    total_samples = 0
    sr = 24000
    async for samples, rate in kokoro.create_stream(text, voice=VOICE, speed=1.0,
                                                     lang="en-us"):
        if ttfa is None:
            ttfa = time.perf_counter() - t0
        total_samples += len(samples)
        sr = rate
    total_gen = time.perf_counter() - t0
    return ttfa, total_gen, total_samples / sr


def bench_tts():
    from kokoro_onnx import Kokoro
    t0 = time.perf_counter()
    kokoro = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
    load_s = time.perf_counter() - t0

    async def run_all():
        out = {}
        for name, text in (("short", SHORT_REPLY), ("long", LONG_REPLY)):
            await _tts_once(kokoro, text)  # warmup (excluded)
            samples = [await _tts_once(kokoro, text) for _ in range(REPS)]
            ttfa = statistics.median(s[0] for s in samples)
            gen = statistics.median(s[1] for s in samples)
            dur = samples[0][2]
            out[name] = {
                "words": len(text.split()),
                "audio_dur_s": round(dur, 2),
                "ttfa_s": round(ttfa, 3),
                "total_gen_s": round(gen, 3),
                "rtf": round(gen / dur, 3),
            }
        return out

    results = asyncio.run(run_all())
    return {
        "load_s": round(load_s, 2),
        "peak_rss_mb": round(rss_mb_self(), 1),  # process holds only the TTS model
        "cases": results,
    }


# ------------------------------------------------------------ STT (whisper.cpp)
_RSS_RE = re.compile(r"Maximum resident set size \(kbytes\):\s*(\d+)")


def _whisper_once(wav):
    """Run whisper-cli under /usr/bin/time -v. Returns (wall_s, peak_rss_mb)."""
    cmd = ["/usr/bin/time", "-v", str(WHISPER_CLI),
           "-m", str(WHISPER_MODEL), "-f", str(wav),
           "-t", str(THREADS), "-nt", "-np"]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    m = _RSS_RE.search(proc.stderr)
    rss = int(m.group(1)) / 1024.0 if m else float("nan")
    return wall, rss


def bench_stt():
    out = {"cases": {}}
    peak_rss = 0.0
    for secs in (3, 5, 10):
        wav = FIXTURES / f"utt_{secs}s.wav"
        _whisper_once(wav)  # warmup (excluded)
        runs = [_whisper_once(wav) for _ in range(REPS)]
        wall = statistics.median(r[0] for r in runs)
        rss = statistics.median(r[1] for r in runs)
        peak_rss = max(peak_rss, rss)
        out["cases"][f"{secs}s"] = {
            "utterance_s": secs,
            "latency_s": round(wall, 3),
            "rtf": round(wall / secs, 3),
        }
    out["peak_rss_mb"] = round(peak_rss, 1)
    return out


# --------------------------------------------------------------- load control
def start_load(n):
    procs = []
    for i in range(n):
        # pin each load process to one physical core (0..3) so it genuinely
        # occupies a core instead of being shuffled around by the scheduler.
        core = i % 4
        p = subprocess.Popen(["taskset", "-c", str(core), sys.executable,
                              str(HERE / "loadgen.py")],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(p)
    if n:
        time.sleep(3)  # let the cores spin up
    return procs


def stop_load(procs):
    for p in procs:
        p.send_signal(signal.SIGKILL)
    for p in procs:
        p.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--load", type=int, default=0, help="busy worker processes")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    for path in (KOKORO_MODEL, KOKORO_VOICES, WHISPER_CLI, WHISPER_MODEL):
        if not path.exists():
            sys.exit(f"missing prerequisite: {path} (run run.sh first)")

    procs = start_load(args.load)
    try:
        label = f"loaded ({args.load} busy workers)" if args.load else "idle"
        print(f"[{label}] measuring STT ...", flush=True)
        stt = bench_stt()
        print(f"[{label}] measuring TTS ...", flush=True)
        tts = bench_tts()
    finally:
        stop_load(procs)

    # End-to-end round trip: audio stops -> transcript -> 2s model -> first audio.
    stt_rt = stt["cases"][f"{ROUNDTRIP_UTT}s"]["latency_s"]
    tts_ttfa = tts["cases"]["short"]["ttfa_s"]
    stack_overhead = round(stt_rt + tts_ttfa, 3)  # the two halves we control
    full_roundtrip = round(stack_overhead + MODEL_TURN_ASSUMPTION, 3)

    result = {
        "label": label,
        "load_workers": args.load,
        "threads": THREADS,
        "reps": REPS,
        "tts": tts,
        "stt": stt,
        "roundtrip": {
            "utterance_s": ROUNDTRIP_UTT,
            "stt_latency_s": stt_rt,
            "model_turn_s": MODEL_TURN_ASSUMPTION,
            "tts_ttfa_s": tts_ttfa,
            "stack_overhead_s": stack_overhead,   # STT + TTS TTFA (judged vs 1.5s)
            "full_roundtrip_s": full_roundtrip,   # + 2s model turn
            "bottleneck": "STT" if stt_rt > tts_ttfa else "TTS",
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2))
    print(f"[{label}] wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
