#!/usr/bin/env bash
# Prove jingle's generated credential can be stored and injected without printing it.
set -euo pipefail

entry="${1:-smoke-$(date -u +%Y%m%d%H%M%S)}"

command -v jingle >/dev/null
jingle add "$entry" --service smoke.invalid --username smoke@beckett.invalid --generate --length 32

list_output="$(jingle list)"
printf '%s\n' "$list_output"
grep -Fqx "$entry  service=smoke.invalid  user=smoke@beckett.invalid  secrets=password" <<<"$list_output" >/dev/null

show_output="$(jingle show "$entry")"
printf '%s\n' "$show_output"
grep -Fqx 'secrets:  password=[REDACTED]' <<<"$show_output" >/dev/null

# The child can inspect the injected credential but is deliberately forbidden
# from printing it. Its only output is this non-secret success marker.
injected_output="$(jingle exec -s "$entry=JINGLE_SMOKE_PASSWORD" -- sh -c 'test -n "$JINGLE_SMOKE_PASSWORD" && test "${#JINGLE_SMOKE_PASSWORD}" -eq 32 && printf injected-ok')"
test "$injected_output" = "injected-ok"
printf '%s\n' 'injected-ok'
printf '%s\n' 'jingle smoke test passed: generated credential stayed redacted and was injected into the child.'
