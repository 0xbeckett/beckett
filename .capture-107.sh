#!/usr/bin/env bash
set -u
N="${1:-6}"
for i in $(seq 1 "$N"); do
  la=$(awk '{print $1}' /proc/loadavg)
  echo "===== RUN $i (load $la) ====="
  bun test src/browser/runtime.test.ts -t "persistent cookies, AI snapshots|CDP cancels slow and concurrent" 2>&1 \
    | grep -vE "^\(pass\)" | tail -60
done
