#!/usr/bin/env bash
set -u
N="${1:-5}"
for i in $(seq 1 "$N"); do
  la=$(awk '{print $1}' /proc/loadavg)
  echo "############ FULL RUN $i (load $la) ############"
  bun test src/browser/runtime.test.ts 2>&1 | grep -vE "^\(pass\)"
done
echo "@@@ FULLDONE @@@"
