#!/usr/bin/env bash
set -u
cd "/home/beckett/Projects/beckett/.beckett/worktrees/#107"
LOG=.stability107.log
: > "$LOG"

# Generate CPU load: 6 busy-loop workers on an 8-core box (load makes the race worse).
LOADPIDS=()
for i in $(seq 1 6); do
  bash -c 'while true; do :; done' &
  LOADPIDS+=($!)
done
echo "load workers: ${LOADPIDS[*]}" >> "$LOG"

pass=0
fail=0
for run in $(seq 1 10); do
  start=$(date +%s)
  if timeout 300 bun test src/browser/runtime.test.ts >>"$LOG" 2>&1; then
    res=PASS; pass=$((pass+1))
  else
    res=FAIL; fail=$((fail+1))
  fi
  end=$(date +%s)
  echo "=== RUN $run: $res ($((end-start))s) ===" >> "$LOG"
done

for p in "${LOADPIDS[@]}"; do kill "$p" 2>/dev/null; done

echo "SUMMARY: pass=$pass fail=$fail" >> "$LOG"
echo "DONE" >> "$LOG"
