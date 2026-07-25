#!/usr/bin/env bash
# Verify the compressed concierge doctrine against its pre-trim baseline (#93).
#
# Checks the invariants the trim had to hold: word budget, headings and their order,
# fenced code blocks, the model roster table, and every tracked named identifier.
#
#   bash scripts/ops/verify-doctrine-trim.sh [baseline-ref]
#
# baseline-ref defaults to the pre-trim commit; any git ref works.
set -u
cd "$(git rev-parse --show-toplevel)"

BASE_REF="${1:-83b138f}"
NEW=src/concierge/concierge.md
IDS=scripts/ops/doctrine-identifiers.txt
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ORIG="$TMP/orig.md"
fail=0

if ! git show "$BASE_REF:$NEW" > "$ORIG" 2>/dev/null; then
  echo "FAIL: cannot read $NEW at $BASE_REF"; exit 1
fi

echo "== word count =="
w=$(wc -w < "$NEW")
echo "new: $w words (baseline $BASE_REF: $(wc -w < "$ORIG"))"
[ "$w" -lt 6500 ] || { echo "FAIL: over 6500 words"; fail=1; }

echo "== headings identical and in order =="
if diff <(grep '^#' "$ORIG") <(grep '^#' "$NEW") > "$TMP/heading.diff" 2>&1; then
  echo "ok: headings byte-identical, same order"
else
  echo "FAIL: heading drift"; cat "$TMP/heading.diff"; fail=1
fi

echo "== fenced code blocks byte-identical =="
awk '/^```$/{f=!f; print "---BLOCK---"; next} f{print}' "$ORIG" > "$TMP/orig.blocks"
awk '/^```$/{f=!f; print "---BLOCK---"; next} f{print}' "$NEW"  > "$TMP/new.blocks"
if diff "$TMP/orig.blocks" "$TMP/new.blocks" > "$TMP/blocks.diff" 2>&1; then
  echo "ok: all $(grep -c -- '---BLOCK---' "$TMP/new.blocks") fenced blocks identical"
else
  echo "FAIL: code block drift"; cat "$TMP/blocks.diff"; fail=1
fi

echo "== roster table byte-identical =="
if diff <(grep '^|' "$ORIG") <(grep '^|' "$NEW") > "$TMP/table.diff" 2>&1; then
  echo "ok: table rows identical"
else
  echo "FAIL: table drift"; cat "$TMP/table.diff"; fail=1
fi

echo "== named identifiers still present =="
missing=0
while IFS= read -r tok; do
  [ -z "$tok" ] && continue
  if ! grep -qF -- "$tok" "$NEW"; then echo "MISSING: $tok"; missing=$((missing+1)); fi
done < "$IDS"
if [ "$missing" -eq 0 ]; then
  echo "ok: every tracked identifier present"
else
  echo "FAIL: $missing missing"; fail=1
fi

exit $fail
