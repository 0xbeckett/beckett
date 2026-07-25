#!/bin/bash
"$@" >.bench-tmp/probe-bench.out 2>.bench-tmp/probe-bench.err &
BENCH=$!
FOUND_MAIN=""; FOUND_GPU=""
while kill -0 $BENCH 2>/dev/null; do
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    [[ "$cmd" == *--user-data-dir=* && "$cmd" == *browser/profile* ]] || continue
    if [[ "$cmd" == *--type=gpu-process* ]]; then [ -z "$FOUND_GPU" ] && FOUND_GPU="$cmd"
    elif [[ "$cmd" != *--type=* ]]; then [ -z "$FOUND_MAIN" ] && FOUND_MAIN="$cmd"; fi
  done
  [ -n "$FOUND_MAIN" ] && [ -n "$FOUND_GPU" ] && break
  sleep 0.05
done
echo "MAIN has --disable-gpu?  $([[ "$FOUND_MAIN" == *\ --disable-gpu\ * ]] && echo YES || echo NO)"
echo "MAIN has --disable-software-rasterizer? $([[ "$FOUND_MAIN" == *--disable-software-rasterizer* ]] && echo YES || echo NO)"
echo "GPU  has --disable-gpu?  $([[ "$FOUND_GPU" == *\ --disable-gpu\ * ]] && echo YES || echo NO)"
echo "--- main argv0 + first flags ---"; echo "${FOUND_MAIN:0:220}"
wait $BENCH 2>/dev/null
