#!/bin/bash
# Capture the bench browser/main + gpu-process argv to confirm --disable-gpu is injected.
"$@" >.bench-tmp/probe-bench.out 2>.bench-tmp/probe-bench.err &
BENCH=$!
FOUND_MAIN=""; FOUND_GPU=""
while kill -0 $BENCH 2>/dev/null; do
  for d in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      *beckett-browser-bench*chrome*)
        case "$cmd" in
          *--type=gpu-process*) [ -z "$FOUND_GPU" ] && FOUND_GPU="$cmd" ;;
          *--type=*) : ;;
          *) [ -z "$FOUND_MAIN" ] && FOUND_MAIN="$cmd" ;;
        esac
        ;;
    esac
  done
  [ -n "$FOUND_MAIN" ] && [ -n "$FOUND_GPU" ] && break
  sleep 0.05
done
echo "--- browser/main argv (first 400 chars) ---"; echo "${FOUND_MAIN:0:400}"
echo; echo "--- gpu-process argv (first 400 chars) ---"; echo "${FOUND_GPU:0:400}"
echo "--disable-gpu in main? $([[ "$FOUND_MAIN" == *--disable-gpu* ]] && echo YES || echo NO)"
echo "--disable-software-rasterizer in main? $([[ "$FOUND_MAIN" == *--disable-software-rasterizer* ]] && echo YES || echo NO)"
wait $BENCH 2>/dev/null
