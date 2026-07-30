#!/usr/bin/env bash
# Verify the concierge doctrine CORPUS against its pre-trim baseline (#93), and hold the
# system-prompt ceiling (#128).
#
#   bash scripts/ops/verify-doctrine-trim.sh [baseline-ref]
#
# ── WHY THIS CHANGED SHAPE ────────────────────────────────────────────────────────────────
# The doctrine used to be one 54KB file, and this script compared THAT file to the baseline.
# It is now a small always-loaded index (`src/concierge/concierge.md`) plus one playbook file
# per procedure (`src/concierge/playbooks/*.md`), which the model reads when a trigger fires.
# Comparing concierge.md alone would now "pass" only by having lost everything.
#
# So the unit of comparison is the CORPUS: the index plus every playbook, concatenated. The
# guarantee this script has always enforced — ro's hard criterion on #93, "zero rules lost" —
# is unchanged and still exactly what is checked. What is deliberately relaxed is ORDER: once
# rules live in separate files, the sequence they appear in is an artifact of `ls`, not a
# property worth pinning. Presence is asserted; ordering is not.
#
# Two checks are NEW, because the whole point of the split is a prompt that stays small:
#   - the index has a hard token ceiling. It is the prefix EVERY session pays on every launch,
#     rotation and recycle, multiplied by per-channel session scope. It tripled once already
#     with nothing watching (13.4k tokens against a 4.6k audit), which is what motivated this.
#   - every playbook path the index cites must exist. A dangling pointer is worse than an
#     inlined rule: the model reports the file missing and then proceeds from memory, which is
#     the single failure this architecture exists to prevent.
set -u
cd "$(git rev-parse --show-toplevel)"

BASE_REF="${1:-83b138f}"
INDEX=src/concierge/concierge.md
PLAYBOOKS=src/concierge/playbooks
IDS=scripts/ops/doctrine-identifiers.txt
# Ceiling on the ALWAYS-LOADED index only (chars; ~4 chars/token). The playbooks are read on
# demand and are deliberately unbounded — they cost nothing until a trigger fires.
INDEX_CEILING_CHARS=16000
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ORIG="$TMP/orig.md"
CORPUS="$TMP/corpus.md"
fail=0

if ! git show "$BASE_REF:$INDEX" > "$ORIG" 2>/dev/null; then
  echo "FAIL: cannot read $INDEX at $BASE_REF"; exit 1
fi

# The corpus = the index plus every playbook, in a stable order.
cat "$INDEX" > "$CORPUS"
if [ -d "$PLAYBOOKS" ]; then
  for f in $(find "$PLAYBOOKS" -name '*.md' | sort); do printf '\n' >> "$CORPUS"; cat "$f" >> "$CORPUS"; done
fi

echo "== always-loaded index ceiling =="
n=$(wc -c < "$INDEX")
echo "index: $n chars (~$((n / 4)) tokens), ceiling $INDEX_CEILING_CHARS (~$((INDEX_CEILING_CHARS / 4)) tokens)"
if [ "$n" -le "$INDEX_CEILING_CHARS" ]; then
  echo "ok: index within ceiling"
else
  echo "FAIL: the always-loaded prompt exceeds its ceiling — move a section into $PLAYBOOKS"
  fail=1
fi

echo "== every cited playbook exists =="
dangling=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  [ -f "$p" ] || { echo "DANGLING: $p"; dangling=$((dangling+1)); }
done < <(grep -oE '\{\{beckett_root\}\}/[A-Za-z0-9_./-]+\.md' "$INDEX" | sed 's|{{beckett_root}}/||' | sort -u)
if [ "$dangling" -eq 0 ]; then echo "ok: every cited playbook resolves"; else echo "FAIL: $dangling dangling"; fail=1; fi

echo "== word count (corpus) =="
w=$(wc -w < "$CORPUS")
echo "corpus: $w words (baseline $BASE_REF: $(wc -w < "$ORIG"))"

echo "== every baseline heading still present somewhere =="
# Presence, not order: the corpus is assembled from files, so sequence is not meaningful.
if diff <(grep '^#' "$ORIG" | sort -u) <(grep '^#' "$CORPUS" | sort -u) > "$TMP/heading.diff" 2>&1; then
  echo "ok: heading set identical"
else
  # Only headings that VANISHED are a failure; the index legitimately adds its own.
  lost=$(comm -23 <(grep '^#' "$ORIG" | sort -u) <(grep '^#' "$CORPUS" | sort -u))
  if [ -z "$lost" ]; then
    echo "ok: no baseline heading lost (corpus adds: $(comm -13 <(grep '^#' "$ORIG" | sort -u) <(grep '^#' "$CORPUS" | sort -u) | tr '\n' ' '))"
  else
    echo "FAIL: headings lost:"; echo "$lost"; fail=1
  fi
fi

echo "== fenced code blocks preserved =="
awk '/^```$/{f=!f; next} f{print}' "$ORIG"   | sort > "$TMP/orig.blocks"
awk '/^```$/{f=!f; next} f{print}' "$CORPUS" | sort > "$TMP/new.blocks"
if [ -z "$(comm -23 "$TMP/orig.blocks" "$TMP/new.blocks")" ]; then
  echo "ok: no code-block line lost"
else
  echo "FAIL: code-block content lost:"; comm -23 "$TMP/orig.blocks" "$TMP/new.blocks" | head -20; fail=1
fi

echo "== roster table preserved =="
if [ -z "$(comm -23 <(grep '^|' "$ORIG" | sort -u) <(grep '^|' "$CORPUS" | sort -u))" ]; then
  echo "ok: no table row lost"
else
  echo "FAIL: table rows lost:"; comm -23 <(grep '^|' "$ORIG" | sort -u) <(grep '^|' "$CORPUS" | sort -u) | head -20; fail=1
fi

echo "== named identifiers still present =="
missing=0
while IFS= read -r tok; do
  [ -z "$tok" ] && continue
  if ! grep -qF -- "$tok" "$CORPUS"; then echo "MISSING: $tok"; missing=$((missing+1)); fi
done < "$IDS"
if [ "$missing" -eq 0 ]; then
  echo "ok: every tracked identifier present in the corpus"
else
  echo "FAIL: $missing missing"; fail=1
fi

exit $fail
