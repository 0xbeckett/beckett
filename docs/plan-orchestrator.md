# Plan — Beckett as an orchestrator

Drafted **2026-07-29** against v6.14.0 (`53dc03d`). Backing evidence:
[`pi-harness-review.md`](pi-harness-review.md) (audit, all findings verified live) and
[`pi/README.md`](pi/README.md) (extension backlog).

The through-line: Beckett currently *dispatches* — one ticket, one worker, one seat chosen by
hand. Everything below moves it toward *orchestrating* — the expensive model spends its tokens on
judgment, cheap models do volume, and the routing between them is a decision the system makes
and can explain.

---

## Workstreams

### W1 — pi harness hardening

Foundation. Two of these three are bug fixes, and W3 cannot be trusted without W1.2.

| | Item | Size | Notes |
|---|---|---|---|
| 1.1 | Provider-aware preflight credential table | S | Review §3.1. Fixes a check that inverts into the failure it prevents. **Do first.** |
| 1.2 | Telemetry: prefer harness-reported cost | S | Review §3.4. Today an unpriced model's runs are silently dropped from the dataset. Must land before any cost-based routing. |
| 1.3 | `REQUIRED_PI_FLAGS` + short-TTL preflight cache | XS | Review §3.8. Opportunistic. |

### W2 — OpenRouter seats

The models already work (verified live). This workstream is about *owning* the configuration.

| | Item | Size | Notes |
|---|---|---|---|
| 2.1 | `models.json` as a generated artifact from `[harness.pi.models]` | M | Review §3.2. Today it's untracked box state; a pinned SKU would be invisible to the repo and lost on rebuild. |
| 2.2 | Land the requested SKUs | S | `moonshotai/kimi-k3` (plain, `@modal/mxfp4`, `@moonshotai/mxfp4`), `x-ai/grok-4.5`, `z-ai/glm-5.2`. Rides 2.1. |
| 2.3 | OpenRouter rows in `config/model-rates.json` | XS | Second cost source for reconciliation. |
| 2.4 | Cast-time model validation against a cached OpenRouter catalogue | S | Review §3.5. Rejects a typo'd slug where it's cheap. |
| 2.5 | `beckett doctor` verifies generated `models.json` + provider credentials | S | Closes the loop on 1.1 and 2.1. |

Note: casting any OpenRouter model needs **no** code change today. 2.1–2.5 are about pins,
durability and failing early — not about access.

### W3 — Seat router (load balancing)

The real project. Review §4 has the design.

| | Item | Size | Notes |
|---|---|---|---|
| 3.1 | `Seat` + `AccountId` model; per-account state store | M | The key move is `account`, because that's what runs out. `claude/*` and `pi/anthropic/*` share one. |
| 3.2 | OpenRouter credits poll (`GET /api/v1/credits`) | S | The one account with a real gauge. |
| 3.3 | Circuit breaker for the two subscriptions | M | No quota API exists. Inferred from `classifyHarnessFailure` + rolling spend. Backoff on `rate_limit`, clear on a clean run. |
| 3.4 | `pickSeat(workClass, accountState, config)` — pure, fixture-tested | M | Pure function, so it is testable without a fleet. |
| 3.5 | Wire into `Dispatcher.castFor` as the default for un-cast tickets | M | An explicit cast still always wins. |
| 3.6 | Wire into classed-failure recovery | M | Replaces walking `fallback_order` with "next seat on a *different* account". |
| 3.7 | One explainability line per routing decision, on the ticket | S | Non-negotiable. An unexplained router is unmaintainable. |

Guardrails from Review §4 that belong in the acceptance criteria, not the follow-up: never
downgrade a seat mid-ticket; a seat that fails twice on a ticket is out for that ticket; rework
rate feeds back into seat choice.

### W4 — Chat seat + Advisor

**Ordering is the whole risk here.** The concierge writes the cast blocks and acceptance criteria
that workers execute; brief quality is the biggest single lever on first-try success. Sonnet at
medium will hold the voice and triage fine and write blander criteria. So the Advisor must be
landed *and verified in use* before the seat drops — otherwise the first week of Sonnet chat
produces weak briefs with nothing to catch them.

| | Item | Size | Notes |
|---|---|---|---|
| 4.1 | `advisor` builtin agent — brief-craft only, seated Opus/Fable @ high | S | `src/agent/builtins.ts`; registry is read live, no restart. |
| 4.2 | Doctrine rule: call the advisor before filing any ticket or plan | S | One short agent run per ticket, not per turn. |
| 4.3 | **Verify** on ≥3 real tickets that advisor briefs are at least as good as today's | — | Gate, not a task. |
| 4.4 | `concierge.model → claude-sonnet-5`, `concierge.effort → medium` | XS | Two config values. Only after 4.3. |
| 4.5 | Delete the stale routing comment block + vestigial `[plane]` from `~/.beckett/config.toml`; decide whether `harness.claude.default_model = claude-opus-4-8` is still wanted | XS | Review §3.6. The pin may be deliberate; the comment describing a Sonnet 4.6 / Opus 4.8 scheme is not. |

The chat seat stays on `claude` regardless — the concierge depends on `--json-schema`, which pi
does not have.

### W5 — pi extensions

Specs in [`pi/`](pi/). Priority order and rationale live there. Sequencing constraint worth
repeating: **`p-subagent` must not start before `p-turn-budget` is landed**, or fan-out has no
shared cost ceiling.

| | Item | Size |
|---|---|---|
| 5.1 | [`p-mcp-bridge`](pi/p-mcp-bridge.md) — unpins the browser lane from claude | M |
| 5.2 | [`p-scope-guard`](pi/p-scope-guard.md) — real containment (today: cwd only) | M |
| 5.3 | [`p-done-signal`](pi/p-done-signal.md) | S |
| 5.4 | [`p-turn-budget`](pi/p-turn-budget.md) — makes the $40 cap real | S |
| 5.5 | [`p-beckett-bus`](pi/p-beckett-bus.md) | M |
| 5.6 | [`p-semantic-index`](pi/p-semantic-index.md) — benchmark first; build only if it wins | M–L |
| 5.7 | [`p-subagent`](pi/p-subagent.md) — needs 5.4 | L |

### W6 — Codebase cohesion

Kimi K3 is running a full-repo audit through the pi harness (read-only, throwaway copy). Its
report becomes the input to this workstream, not the workstream itself: findings get split by
area into separate tickets with a cheap check each, because a single ticket sweeping every file
is a known worker-killer.

Constraint on every ticket that comes out of it: refactors land behind a green `tsc --noEmit` and
`bun test` on clean `origin/main` — a passed review does not check main.

### W7 — Public evals (`kowo-co/evals`)

In progress under a separate Fable 5 agent. Real-world tasks, sandboxed, scored on the
cost-intelligence frontier rather than pass-rate alone. The standing rule: **no fabricated
results** — an empty `results/` with a documented schema, or exactly what a real run produced.

W7 is what eventually validates W3. A router that claims cheap models are good enough should be
able to prove it on a public suite.

---

## Dependency graph

```
W1.1 ─┬─────────────────────────────► (everything, honestly)
W1.2 ─┴──► W3.1 ─► W3.4 ─┬─► W3.5 ─► W3.7
                          └─► W3.6
W2.1 ─► W2.2 ─► W2.5
W2.3 ─► W3.4        (rates are a router input)
W2.4  (independent)

W4.1 ─► W4.2 ─► [4.3 verify] ─► W4.4
W4.5  (independent)

W5.1  (independent; unpins browser lane)
W5.2  (independent)
W5.3  (independent)
W5.4 ─► W5.7
W5.5  (independent)
W5.6  (benchmark gate first)

W6    ← Kimi report
W7    (independent) ─► validates W3 later
```

## Suggested order

**First pass — small, high-leverage, mostly independent.** W1.1, W1.2, W2.3, W4.1, W4.2, W4.5.
Roughly an afternoon between them, and they unblock everything else.

**Second pass.** W2.1 + W2.2 (the pinned SKUs), W4.3 → W4.4 (the chat seat, once the Advisor has
proven itself), W5.3 + W5.4 (the two small extensions), W2.4, W2.5, W1.3.

**Third pass — the two real projects, in parallel.** W3 (the router, split into its seven items)
and W5.1 + W5.2 (the two extensions that close genuine gaps). W6 tickets land alongside as the
Kimi report gets triaged.

**Fourth.** W5.5, W5.6 (behind its benchmark gate), W5.7 (after W5.4).

## Filing notes

- W3 is the only item that warrants a real plan DAG (`beckett plan`); the rest are single
  tickets. Large plans have hit 429s on concurrent level creation, so cross-plan blockers want
  direct `createIssue` with `blockedBy` identifiers.
- Every ticket gets its ceiling written into the acceptance criteria. Never spec "passes N
  consecutive runs."
- W3.4 and W2.1 are the two worth casting at a strong seat — pure-function design and a config
  contract respectively. The rest are ordinary implement work.
- Batch the deploys: a `beckett deploy` restarts the daemon and re-staffs every running ticket,
  so let the in-flight branches drain first.
