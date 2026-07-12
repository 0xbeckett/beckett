#!/usr/bin/env bash
# Build docs/dynamic-workflow-design.pdf from index.html via headless Chrome
# (the same pipeline rev 1 used). Fonts are vendored in fonts/ — no network needed.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-google-chrome}"
OUT="../../dynamic-workflow-design.pdf"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=10000 \
  --print-to-pdf="$OUT" \
  "file://$PWD/index.html"
echo "wrote $(cd ../.. && pwd)/dynamic-workflow-design.pdf"
