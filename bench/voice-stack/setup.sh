#!/usr/bin/env bash
# Fetch models and build whisper.cpp for the voice-stack benchmark.
# Run once before ./run.sh. Idempotent: skips anything already present.
#
# Needs: uv, git, cmake, a C++ toolchain, ffmpeg, espeak-ng, internet.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p models

KOKORO_REL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
if [[ ! -f models/kokoro-v1.0.onnx ]]; then
  echo "Fetching Kokoro-82M ONNX (~310MB) ..."
  curl -L -o models/kokoro-v1.0.onnx "$KOKORO_REL/kokoro-v1.0.onnx"
fi
if [[ ! -f models/voices-v1.0.bin ]]; then
  echo "Fetching Kokoro voices ..."
  curl -L -o models/voices-v1.0.bin "$KOKORO_REL/voices-v1.0.bin"
fi
if [[ ! -f models/ggml-base.en.bin ]]; then
  echo "Fetching whisper base.en (142MB) ..."
  curl -L -o models/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
fi

if [[ ! -x whisper.cpp/build/bin/whisper-cli ]]; then
  echo "Building whisper.cpp ..."
  [[ -d whisper.cpp ]] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
  cd whisper.cpp
  # tests disabled: their path macros choke on a '#' in the checkout path.
  cmake -B build -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release \
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
  cmake --build build -j"$(nproc)" --config Release --target whisper-cli
  cd ..
fi

echo "Installing Python deps ..."
uv sync

echo "Setup complete. Run ./run.sh"
