#!/usr/bin/env bash
# Temporary: wait for external load to fall below THRESHOLD (8-core box), then run the full
# runtime.test.ts file N consecutive times. Records the load at the start of each run.
set -u
N="${1:-10}"
THRESHOLD="${2:-14}"
MAX_WAIT_SECS="${3:-3600}"

waited=0
while :; do
  la=$(awk '{print int($1)}' /proc/loadavg)
  if [ "$la" -le "$THRESHOLD" ]; then break; fi
  if [ "$waited" -ge "$MAX_WAIT_SECS" ]; then
    printf 'NOTE: load %s still above %s after %ss wait; proceeding anyway.\n' "$la" "$THRESHOLD" "$waited"
    break
  fi
  sleep 30
  waited=$((waited+30))
done

pass=0
fail=0
for i in $(seq 1 "$N"); do
  la=$(awk '{print $1}' /proc/loadavg)
  out=$(bun test src/browser/runtime.test.ts 2>&1)
  summary=$(printf '%s\n' "$out" | grep -E "Ran [0-9]+ tests" | tail -1)
  if printf '%s\n' "$out" | grep -qE "^[[:space:]]*[1-9][0-9]* fail"; then
    fail=$((fail+1))
    printf 'RUN %s (load %s): FAIL -- %s\n' "$i" "$la" "$summary"
    printf '%s\n' "$out" | grep -E "\(fail\)"
  else
    pass=$((pass+1))
    printf 'RUN %s (load %s): OK -- %s\n' "$i" "$la" "$summary"
  fi
done
printf '=== FULL DONE: %s pass / %s fail over %s runs ===\n' "$pass" "$fail" "$N"
