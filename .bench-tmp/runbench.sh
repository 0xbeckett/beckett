#!/usr/bin/env bash
# usage: runbench.sh <label> <versiondir>
set -u
LABEL="$1"
VDIR="$2"
ROOT="/home/beckett/Projects/beckett/.beckett/worktrees/161/.bench-tmp"
READYLOG="$ROOT/ready.$LABEL.log"
rm -f "$READYLOG"
( cd "$VDIR" && TABS=5 HOLD_MS=32000 timeout 75 bun hold.mjs ) > "$READYLOG" 2>&1 &
BENCH_BG=$!
PID=""
for i in $(seq 1 55); do
  if grep -q READY "$READYLOG" 2>/dev/null; then
    PID=$(grep READY "$READYLOG" | awk '{print $2}')
    break
  fi
  sleep 1
done
if [ -z "$PID" ]; then
  echo "$LABEL: FAILED to reach READY"; tail -5 "$READYLOG"; wait "$BENCH_BG" 2>/dev/null; exit 1
fi
echo -n "$LABEL "; grep SPEED "$READYLOG"
sleep 4
echo -n "$LABEL "; python3 "$ROOT/sample.py" "$PID" 12
wait "$BENCH_BG" 2>/dev/null
