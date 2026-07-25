#!/usr/bin/env bash
# Verify the compressed doctrine against the original (HEAD~ version kept in .trim/orig.md).
set -u
cd "$(dirname "$0")/.."
ORIG=.trim/orig.md
NEW=src/concierge/concierge.md
fail=0

echo "== word count =="
w=$(wc -w < "$NEW"); echo "new: $w words (orig: $(wc -w < "$ORIG"))"
[ "$w" -lt 6500 ] || { echo "FAIL: over 6500 words"; fail=1; }

echo "== headings identical and in order =="
if diff <(grep '^#' "$ORIG") <(grep '^#' "$NEW") > /tmp/heading.diff 2>&1; then
  echo "ok: headings byte-identical, same order"
else
  echo "FAIL: heading drift"; cat /tmp/heading.diff; fail=1
fi

echo "== fenced code blocks byte-identical =="
awk '/^```$/{f=!f; print "---BLOCK---"; next} f{print}' "$ORIG" > /tmp/orig.blocks
awk '/^```$/{f=!f; print "---BLOCK---"; next} f{print}' "$NEW" > /tmp/new.blocks
if diff /tmp/orig.blocks /tmp/new.blocks > /tmp/blocks.diff 2>&1; then
  echo "ok: all $(grep -c -- '---BLOCK---' /tmp/new.blocks) fenced blocks identical"
else
  echo "FAIL: code block drift"; cat /tmp/blocks.diff; fail=1
fi

echo "== roster table byte-identical =="
if diff <(grep '^|' "$ORIG") <(grep '^|' "$NEW") > /tmp/table.diff 2>&1; then
  echo "ok: table rows identical"
else
  echo "FAIL: table drift"; cat /tmp/table.diff; fail=1
fi

echo "== named identifiers still present =="
missing=0
while IFS= read -r tok; do
  [ -z "$tok" ] && continue
  if ! grep -qF -- "$tok" "$NEW"; then echo "MISSING: $tok"; missing=$((missing+1)); fi
done < .trim/identifiers.txt
if [ "$missing" -eq 0 ]; then echo "ok: every tracked identifier present"; else echo "FAIL: $missing missing"; fail=1; fi

exit $fail
