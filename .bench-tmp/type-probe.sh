#!/bin/bash
# Break down the BENCH browser tree CPU by chrome process --type=, scoped to the
# bench's own temp profile (beckett-browser-bench-*) so host chrome is excluded.
LABEL="$1"; shift
"$@" >.bench-tmp/probe-bench.out 2>.bench-tmp/probe-bench.err &
BENCH=$!
declare -A CPU
while kill -0 $BENCH 2>/dev/null; do
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      *beckett-browser-bench*)
        pid=${d#/proc/}
        type=$(echo "$cmd" | grep -oE -- '--type=[a-zA-Z-]+' | head -1)
        [ -z "$type" ] && type="--type=browser/main"
        ticks=$(awk '{print $14+$15}' "$d/stat" 2>/dev/null) || continue
        [ -n "$ticks" ] && CPU["$type|$pid"]=$ticks
        ;;
    esac
  done
  sleep 0.1
done
wait $BENCH
declare -A BYTYPE
for k in "${!CPU[@]}"; do t="${k%%|*}"; BYTYPE[$t]=$(( ${BYTYPE[$t]:-0} + ${CPU[$k]} )); done
echo "[$LABEL] per-type CPU seconds (bench tree only):"
for t in "${!BYTYPE[@]}"; do awk "BEGIN{printf \"   %-28s %.2f s\n\", \"$t\", ${BYTYPE[$t]}/100}"; done | sort
grep -E 'cpuSeconds|coldAcquireMs|peakRssMb|"p50"' .bench-tmp/probe-bench.out
