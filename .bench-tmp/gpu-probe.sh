#!/bin/bash
# Sample /proc for chrome gpu-process presence + CPU while a bench run is live.
LABEL="$1"; shift
"$@" >.bench-tmp/probe-bench.out 2>.bench-tmp/probe-bench.err &
BENCH=$!
declare -A GPUCPU
GPUSEEN=0
while kill -0 $BENCH 2>/dev/null; do
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
    case "$cmd" in
      *--type=gpu-process*)
        pid=${d#/proc/}
        ticks=$(awk '{print $14+$15}' "$d/stat" 2>/dev/null)
        [ -n "$ticks" ] && GPUCPU[$pid]=$ticks
        GPUSEEN=1
        ;;
    esac
  done
  sleep 0.1
done
wait $BENCH
total=0
for pid in "${!GPUCPU[@]}"; do total=$((total + ${GPUCPU[$pid]})); done
echo "[$LABEL] gpu-process seen=$GPUSEEN distinct_pids=${#GPUCPU[@]} gpu_cpu_ticks=$total gpu_cpu_sec=$(awk "BEGIN{print $total/100}")"
grep -q '"cpuSeconds"' .bench-tmp/probe-bench.out && grep -E 'cpuSeconds|coldAcquireMs|peakRssMb' .bench-tmp/probe-bench.out
