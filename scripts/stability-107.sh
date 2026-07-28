#!/usr/bin/env bash
# Temporary stability harness for ticket #107. Runs runtime.test.ts N times and reports.
set -u
N="${1:-10}"
pass=0
fail=0
for i in $(seq 1 "$N"); do
  out=$(bun test src/browser/runtime.test.ts 2>&1)
  summary=$(printf '%s\n' "$out" | grep -E "Ran [0-9]+ tests" | tail -1)
  if printf '%s\n' "$out" | grep -qE "^[[:space:]]*[1-9][0-9]* fail"; then
    fail=$((fail+1))
    printf 'RUN %s: FAIL -- %s\n' "$i" "$summary"
    printf '%s\n' "$out" | grep -E "\(fail\)"
  else
    pass=$((pass+1))
    printf 'RUN %s: OK -- %s\n' "$i" "$summary"
  fi
done
printf '=== DONE: %s pass / %s fail over %s runs ===\n' "$pass" "$fail" "$N"
