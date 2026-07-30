# `p-done-signal` — enforced structured output for pi

**Priority 3.** Small, and it removes a whole class of soft failure.

## Problem

`claude --json-schema` constrains the final message to a schema. pi has no equivalent
(`LANE_GAPS.jsonSchema`, `src/drivers/lane.ts:127-129`), so `PiDriver` parses the done-signal
*leniently* from the last assistant message — three attempts in `parseStructuredOutput()`
(`src/drivers/pi.ts:1109-1138`): whole-message JSON, a ```json fence, then the last balanced
`{…}` in the text. When all three fail it returns `null` and the dispatcher falls back to summary
text.

That fallback is the problem. A worker that finished real work but wrote its done-signal as prose
looks, to the dispatcher, indistinguishable from a worker that finished nothing — same `null`,
same degraded path. The lenient parser makes it *rarer*, not *diagnosable*.

It also silently loses the fields the pipeline actually uses (`filesChanged`, `checksRun`,
`blockedReason`), which is how a ticket advances on a summary with no evidence attached.

## Mechanism

`pi.on("message_end")`, which per pi's docs may **return a replacement message** — the same hook
`docs/custom-provider.md` uses to rewrite `errorMessage` before pi's compaction check reads it. So
the extension sits exactly where it can both validate and correct.

1. Take a JSON Schema via `pi.registerFlag("done-schema", <path>)`. Beckett already has the schema
   — it is the same one the claude driver passes to `--json-schema`. Pass the same file; do not
   define a second copy.
2. On the final assistant `message_end`, run the *same* lenient extraction `PiDriver` does (raw /
   fenced / trailing object), then validate against the schema.
3. **Valid** → rewrite the message content to the canonical serialised JSON, so `PiDriver`'s parse
   is guaranteed to hit case 1 and the three-way fallback becomes dead weight rather than a
   load-bearing guess.
4. **Invalid or absent** → do not fail the run. Inject one corrective user turn: the validation
   errors plus the schema, and "reply with only the done-signal JSON." pi's agent loop will take
   it as the next turn. Bound this to **one** retry: a second failure emits a structured
   `done_signal_invalid` marker in the message so the dispatcher can distinguish "worker did the
   work but can't format" from "worker did nothing" — which is the actual diagnostic win here.
5. Never invent field values. If the worker didn't report `checksRun`, the corrected signal has an
   empty `checksRun`, not a plausible-looking one. A fabricated evidence field is worse than a
   missing one because it advances a ticket on nothing.

## Beckett-side changes this enables

- `buildPiLaneCommand`/`PiDriver.buildArgs` pass `-e <p-done-signal> --done-schema <path>`;
  `LANE_GAPS.jsonSchema` deleted.
- `parseStructuredOutput()` keeps its fallbacks (defence in depth, and resumed sessions from
  before this lands) but stops being the primary mechanism.
- The dispatcher gains a real `done_signal_invalid` signal, distinct from `null`.

## Verification

1. A fixture worker instructed to answer in prose produces a schema-valid done-signal after
   exactly one correction, and the frame stream shows the single corrective turn.
2. A worker that ignores the correction twice yields `done_signal_invalid` — assert the marker
   reaches `PiDriver`'s `finished` event.
3. A worker that already answers correctly gets **zero** extra turns. Regression-test this; a
   validator that adds a turn to every healthy run is a tax on the whole fleet.
4. No fabricated fields: assert a prose answer with no checks mentioned yields `checksRun: []`.

## Failure modes

- **Schema file missing** → fail at startup, loudly. Silently unvalidated output is the status
  quo, and shipping the status quo under a name that claims otherwise is the worst outcome.
- **The corrective turn triggers a compaction** on a long run. Keep the injected turn small —
  errors and schema only, never the original transcript.
- **Interaction with `agent_settled` drains.** `PiDriver` already re-prompts at settle time to
  drain queued steering (`src/drivers/pi.ts:1000-1025`, bounded by `MAX_SETTLE_DRAINS`). A
  correction turn must not race that. Simplest safe rule: only correct on a `message_end` where
  no steering is queued, and let the settle drain win otherwise.

## Size

**S.** One hook, one validator, one bounded retry. The care is all in "don't add a turn to
healthy runs" and "don't invent fields."
