#!/usr/bin/env bash
set -u
N="${1:-14}"
for i in $(seq 1 "$N"); do
  la=$(awk '{print $1}' /proc/loadavg)
  echo "############ HUNT RUN $i (load $la) ############"
  out=$(bun test src/browser/runtime.test.ts 2>&1)
  echo "$out" | grep -vE "^\(pass\)"
  if echo "$out" | grep -qE "^[[:space:]]*[1-9][0-9]* fail"; then
    echo ">>> CAUGHT FAILURE ON RUN $i <<<"
    echo "$out" > .hunt-107-failure.txt
    break
  fi
done
echo "@@@ HUNTDONE @@@"
