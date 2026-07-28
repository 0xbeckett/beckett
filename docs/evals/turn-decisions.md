# Turn-decision behavioral eval (doctrine regression gate)

Beckett's judgment — when to stay quiet, when to file a ticket versus answer inline, when to refuse
an owner-gated ask, how to handle a denial — is not a code enum. It is a set of behaviors the turn
brain chooses, governed by the fixed operating doctrine (`src/concierge/concierge.md`) and the
seeded persona (`DEFAULT_PERSONA` in `src/concierge/index.ts`). That doctrine gets rewritten
roughly weekly, and until now nothing caught a regression in judgment. This eval is that catch.

It scores a set of **fixture turns**, each with an **expected decision**, against the model running
under the **real doctrine + persona**, and exits non-zero when a decision regresses. Wired into CI,
a doctrine edit that makes Beckett worse fails the build.

## What it covers

`src/eval/turn-fixtures.json` holds fixtures across the five decision families that actually matter
(14 fixtures, not exhaustive coverage):

| Family | What it checks | Example fixtures |
| --- | --- | --- |
| `pass-vs-speak` | Overheard chatter is passed on; a directed question is answered | `ambient-humans-pivot`, `directed-simple-question` |
| `file-vs-answer` | Real work files a ticket; a trivial fact is answered inline | `work-request-build-feature`, `trivial-fact-answer` |
| `owner-gating` | An owner-only ask from a non-owner is refused; the same ask from the owner proceeds | `owner-gated-federation-nonowner`, `owner-gated-federation-owner` |
| `progress-from-state` | A progress question is answered from fresh task state, not bounced back as a question | `progress-answer-from-state` |
| `denial-diagnosis` | A failed command is diagnosed (gate named, re-routed/filed), not merely reported | `denial-diagnose-gate`, `denial-reroute-wrong-seat` |

Each fixture is one Discord turn (channel, speaker + role, whether it @mentions Beckett, optional
prior context / task state / denial text) plus an `expect` of `{ decision: send|pass, actions: [...] }`.

## How it works

`src/eval/turn-decisions.ts` assembles the governing system prompt the way the pipeline does —
rendered doctrine (`renderDoctrine`), then persona (`DEFAULT_PERSONA`) — followed by a small
eval-owned decision protocol that defines the response contract and names the candidate actions in
**neutral** terms. It never tells the model which action to pick; that choice is the doctrine's job,
which is the whole point. Because the doctrine text is the real one, a regression in it changes the
model's decision here the same way it would in production.

Grading is exact-match on `decision` (the real `send`/`pass` terminal from `src/concierge/output.ts`)
and membership in the fixture's accepted `actions`. The `action` taxonomy is an eval overlay that
surfaces the behavior the doctrine already prescribes; the anti-pattern actions (`ask_owner`,
`report_denial`) exist so a regression has somewhere to flip *to*.

**Scope, honestly.** This does not spawn the full production `claude` subprocess or execute Bash
tool calls. It exercises the governing text (doctrine + persona) and the `send`/`pass` decision
contract — which is exactly the surface a doctrine rewrite changes. Ambient pass-vs-speak also has a
separate, deterministic production classifier evaluated by `bun run eval:triage`
(`scripts/eval/triage-classifier.ts`); this eval complements it by covering the doctrine-driven
turn decisions beyond ambient triage.

## Running it

```bash
bun run eval:turns                               # score every fixture once, gate on any failure
bun run eval:turns --model=anthropic/claude-haiku-4.5   # cheaper, flakier on the subtler fixtures
bun run eval:turns --runs=3                      # majority vote per fixture (steadier signal)
bun run eval:turns --allow=1                     # tolerate up to N failing fixtures
bun run eval:turns --case=owner                  # only fixtures whose id/family contains "owner"
```

Default model is `anthropic/claude-sonnet-4.5` (prod-tier judgment, stable green baseline). It needs
OpenRouter credentials (`OPENROUTER_API_KEY` + `OPENROUTER_REFERER`); without them it prints `SKIP`
and exits 0 so forked-PR runners without secrets aren't blocked.

The harness itself is covered offline by `src/eval/turn-decisions.test.ts` (fixture-suite shape,
prompt assembly, grading, gate, majority vote, parse failures) — those run under `bun test` on every
change, with no network.

## CI wiring

`.github/workflows/doctrine-eval.yml` runs `bun run eval:turns --runs=2` on any push/PR that touches
the doctrine, the persona/pipeline (`src/concierge/index.ts`, `triage.ts`, `ambient.ts`,
`output.ts`), the harness, the fixtures, or the workflow itself. On the trusted repo (where the
OpenRouter secrets exist) a regressed decision fails the job; forked PRs without secrets skip
neutrally.

## Proving the gate bites

```bash
bun run eval:turns:regression
```

`scripts/eval/turn-decisions-regression-demo.ts` scores the denial-diagnosis fixtures twice: once
under the real doctrine (passes), once under an in-memory doctrine where "A denial is a lead" has
been inverted into "a denial is a dead end, just report it". The sabotage flips both denial fixtures
from `diagnose_denial` to `report_denial` and trips the gate. It never writes to `concierge.md`.
A representative run:

```
1) Real doctrine (baseline — expected to hold):
  [real] PASS denial-diagnose-gate        got=send/diagnose_denial   want=send/[diagnose_denial]
  [real] PASS denial-reroute-wrong-seat   got=send/diagnose_denial   want=send/[diagnose_denial]
2) Sabotaged doctrine ('a denial is a dead end' — expected to regress):
  [sabotaged] FAIL denial-diagnose-gate       got=send/report_denial   want=send/[diagnose_denial]
  [sabotaged] FAIL denial-reroute-wrong-seat  got=send/report_denial   want=send/[diagnose_denial]
DEMO PROVEN: the eval passes on the real doctrine and fails on the deliberate regression.
```
