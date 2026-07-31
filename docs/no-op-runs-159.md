# The zero-tool-call no-op run (#159)

Diagnosis of the ~43% of `pi` implement runs that were billed ~$0, made zero tool calls, and
returned. Written against `~/.beckett/spend.jsonl` and `~/.pi/agent/sessions/` as of
**2026-07-31T07:03Z** (1548 ledger lines, 605 implement runs, 2026-07-11 → 2026-07-31).

## TL;DR

**The cause is outside our code.** It is not the launcher, not argv, not the spawn path, and not
model quality. `pi`'s `openai-codex` provider *refuses the very first turn* — quota exhausted, or a
dead login — and pi then **exits 0** with a clean `agent_end`. Every no-op run is a provider
refusal, not an attempt.

What *was* ours: two ways that refusal stayed invisible, both fixed here.

1. `piPreflight` blessed a login that could not work (it substring-tested `auth.json` for the
   provider name), so 35 of the no-ops launched a child we could have refused to start.
2. The spend ledger wrote a refused launch as an ordinary `failed` run *of that cast* — the same
   row shape a genuine "the model tried and gave up" produces. That conflation is what made terra
   read as a bad implementer in the #156 model-economics pass.

## Evidence

Counting implement runs with `turns <= 1 && toolCalls === 0`:

| Harness | Implement runs | No-op runs |
|---|---:|---:|
| `pi` (gpt-5.6-terra, all efforts) | 216 | **92 (43%)** |
| `claude` (all models/efforts) | 389 | 2 (0.5%) |

Each of the 92 pi no-ops was matched to the pi session transcript written in its own run window
(`~/.pi/agent/sessions/<cwd-slug>/<ts>_<session-uuid>.jsonl`). **92 of 92** — no exceptions — have
a first assistant message carrying `stopReason:"error"`, zero tokens, and no tool call:

| Provider error on turn one | No-op runs |
|---|---:|
| `Codex error: The usage limit has been reached` | 57 |
| `No API key for provider: openai-codex` | 24 |
| `Your authentication token has been invalidated. Please try signing in again.` | 11 |

Sample runs — ledger row (`ticketId` + `ts`, the ledger had no run id) → transcript:

- `#46` / `2026-07-19T01:52:59.325Z` (medium, 5540ms, $0) → session
  `f5efc7be-8b7e-4d0c-afa1-03234c34541e` in
  `~/.pi/agent/sessions/--home-beckett-Projects-beckett-.beckett-worktrees-#46--/` —
  `"stopReason":"error","errorMessage":"Codex error: The usage limit has been reached"`.
- `#73` / `2026-07-20T20:45:03.799Z` (high) → session `a778a9a9-3520-485e-afa5-1a5b2434f1aa` —
  `"Your authentication token has been invalidated. Please try signing in again."`
- `#137` / `2026-07-30T06:12:45.254Z` (medium, 9414ms, $0) → session
  `5a6a1626-60f5-4634-a642-1587e53ccfc3`. The whole transcript is five lines: `session`,
  `model_change`, `thinking_level_change`, the task prompt, then an **empty** assistant message with
  `"usage":{"input":0,"output":0,...}` and `"errorMessage":"Codex error: The usage limit has been
  reached"`. The prompt was delivered intact. Nothing was wrong with what pi was handed.
- `#158` / `2026-07-31T07:01:07.410Z` → session `b8e0eb87-0a85-499a-bf87-92661ddaf6ed`, same
  usage-limit refusal. Still live at the time of writing.

The two non-pi no-ops (`#122`, both `2026-07-29`, claude-opus-5 high) are a different, unrelated
shape: ~200s wall clock and a non-zero cost, not an instant ~$0 refusal.

### What the process actually does

Reproduced directly, no daemon involved (see below). pi's `--mode json` stream for a refused run:

```
{"type":"session","version":3,"id":"…"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user",…}}
{"type":"message_end","message":{"role":"user",…}}
{"type":"message_start","message":{"role":"assistant","content":[],"usage":{…"total":0},
  "stopReason":"error","errorMessage":"Codex error: …"}}
{"type":"message_end","message":{…same…}}
{"type":"turn_end","message":{…same…},"toolResults":[]}
{"type":"agent_end","messages":[…]}
{"type":"agent_settled"}
```

…and then **`pi` exits 0**. One `turn_start` (hence `turns: 1`), no `tool_execution_*`, no usage.
There is no signal at the process level — exit code, stderr, stream shape — that distinguishes this
from a worker that finished. Only the *outcome* does: no tokens, no tools, no text.

## Reproduction

Deterministic, offline-ish, and it does not require waiting for a quota window. Ask the
ChatGPT-account tier for a model it will not serve:

```sh
mkdir -p /tmp/pi-noop && cd /tmp/pi-noop
pi -p --mode json --no-extensions --no-skills --no-themes \
   --provider openai-codex --model gpt-5-codex --thinking medium \
   --session-id "$(uuidgen)" "say hi"
echo "exit=$?"          # → 0
```

You get the frame sequence above with
`errorMessage: "Codex error: The 'gpt-5-codex' model is not supported when using Codex with a
ChatGPT account."` and `exit=0`. Substitute the real quota refusal by running it while the codex
account is capped; the shape is identical.

To see the historical evidence for yourself:

```sh
# every no-op implement run in the ledger
jq -c 'select(.stage=="implement" and .turns<=1 and .toolCalls==0)' ~/.beckett/spend.jsonl

# what the process did before returning, for one of them
jq -c 'select(.message.stopReason=="error") | .message.errorMessage' \
  ~/.pi/agent/sessions/*/*.jsonl | sort | uniq -c | sort -rn
```

## The fix

Detection, not a patch — we cannot make someone else's provider answer.

1. **`piPreflight` no longer blesses an unusable login** (`src/drivers/pi.ts`). The old check was
   `auth.includes(provider)` over the raw file text, which passes for a provider entry that exists
   but carries no credential. It now parses `auth.json` and requires the provider entry to exist
   with a non-empty `access`/`key`/`token`; an entry whose `expires` has passed fails only when
   there is **no** `refresh` token, because pi renews from the refresh token on its own and
   benching the harness on expiry alone would be a false positive. An unparseable `auth.json` falls
   back to the old substring test rather than inventing a problem.

2. **A run that did nothing can no longer finish as success** (`src/drivers/pi.ts`,
   `handleAgentEnd`). The pre-existing `runError` guard catches refusals that name themselves on an
   assistant `message_end`. The new backstop catches the rest by *outcome*: `agent_end` with zero
   tool calls **and** zero tokens **and** no assistant text finishes `status:"error"`,
   `subtype:"error_noop"`, with the failure class read off the stderr tail. The three conditions are
   ANDed — a legitimately terse run still spends tokens and still produces text, so it cannot trip
   this.

3. **A no-op is ledgered as a launch failure, not as a run of the cast** (`src/spend.ts`,
   `src/dispatch/dispatcher.ts`). New `SpendOutcome` value `launch_failed`, plus optional
   `errorClass` and `sessionId` on every row. `isAttempt(row)` is the denominator any per-cast
   quality rate should use. `sessionId` means the next person does not have to correlate timestamps
   against transcripts to find out what happened, as this write-up had to.

4. **The ticket comment says what happened.** `onImplementIncomplete` names a zero-work run a
   "LAUNCH FAILURE … 0 tool calls and 0 tokens … not an attempt at the ticket" instead of "stopped
   without finishing (crash or harness error)", which read as though the worker had tried.

Escalation was already correct and is unchanged: a `rate_limit` class arms the #133 harness
cooldown and substitutes to a healthy harness; `auth` parks with the login command; anything
unclassed takes the bounded implement retry. The point of this change is that the *class* is now
reached from a run that says nothing about itself, and that the run is never mistaken for work.

## Consequence for casting

Any read of per-cast quality from `spend.jsonl` must exclude `outcome === "launch_failed"` rows
(and, for rows written before this change, `turns <= 1 && toolCalls === 0`). Terra's headline
not-done rate is inflated by 92 runs in which it was never asked anything. This document makes no
casting recommendation — that is #108.2's call.

## Adjacent work (checked, none of it covers this)

- **#37.1** — a timed-out `pi --version` probe vs a broken pi. Preflight-time; this failure happens
  after a clean preflight.
- **#59.1** — harness substitution vs spawn retries. Downstream of the classification; the run here
  reached `agent_end` normally, so it was never a spawn failure.
- **#85.1** — cast-level provider routing. Chooses the provider; does not notice it refusing.
- **#101.1** — the binary version probe surviving a hung binary. The binary here is healthy and
  exits 0.
- **#133** — the harness rate-limit cooldown. The nearest neighbour, and it does contain the
  *repeat* cost of a quota window. It is armed by the first death, so the first launch of each
  window is still spent, and it deliberately does not cool the `auth` class (35 of the 92 here) —
  which is what item 1 above addresses.
