#!/usr/bin/env bash
# One command to run the whole local voice-stack benchmark and write RESULTS.md.
#
#   ./run.sh
#
# Prereqs (fetched once, see setup.sh): Kokoro ONNX model + voices, whisper.cpp
# built with base.en. If they are missing, run ./setup.sh first.
set -euo pipefail
cd "$(dirname "$0")"

need=(models/kokoro-v1.0.onnx models/voices-v1.0.bin models/ggml-base.en.bin
      whisper.cpp/build/bin/whisper-cli)
for f in "${need[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "Missing $f — run ./setup.sh first to fetch models and build whisper.cpp." >&2
    exit 1
  fi
done

# STT fixtures (3s/5s/10s speech clips) — generate if absent.
if [[ ! -f fixtures/utt_10s.wav ]]; then
  echo "Generating STT fixtures ..."
  uv run python make_fixtures.py
fi

mkdir -p results
echo "=== Pass 1/2: idle ==="
uv run python benchmark.py --load 0 --out results/idle.json
echo "=== Pass 2/2: under load (2 pinned busy workers) ==="
uv run python benchmark.py --load 2 --out results/loaded.json
echo "=== Rendering RESULTS.md ==="
uv run python report.py
echo "Done. See RESULTS.md"
