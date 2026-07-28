#!/usr/bin/env bash
# Temporary: run ONLY the two ticket-#107 target tests N times, with load context per run.
set -u
N="${1:-12}"
pass=0
fail=0
for i in $(seq 1 "$N"); do
  la=$(awk '{print $1}' /proc/loadavg)
  out=$(bun test src/browser/runtime.test.ts -t "timed-out evaluator|disposable evaluator contains vm escape" 2>&1)
  summary=$(printf '%s\n' "$out" | grep -E "Ran [0-9]+ tests" | tail -1)
  if printf '%s\n' "$out" | grep -qE "^[[:space:]]*[1-9][0-9]* fail"; then
    fail=$((fail+1))
    printf 'RUN %s (load %s): FAIL -- %s\n' "$i" "$la" "$summary"
    printf '%s\n' "$out" | grep -E "\(fail\)|Received:|Expected:"
  else
    pass=$((pass+1))
    printf 'RUN %s (load %s): OK -- %s\n' "$i" "$la" "$summary"
  fi
done
printf '=== TARGET DONE: %s pass / %s fail over %s runs ===\n' "$pass" "$fail" "$N"
