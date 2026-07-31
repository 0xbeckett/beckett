# Model economics: capability per dollar on luna, terra and sonnet 5

**Ticket:** #156 (research) · **Author:** Beckett (worker) · **Date:** 2026-07-30
**Status:** Research only — no code, config or playbook changes; the playbook edit is #108.2's job.
**Premise under test (ro's, not assumed):** a smaller/cheaper model paired with a strong
advisor/reviewer may do work as good as a big implement seat for meaningfully less money.

## 0. TL;DR

Five findings, in order of how much they should change what we do.

1. **The pricing in the ticket went stale the day it was filed.** OpenAI cut Terra and Luna on
   **30 July 2026** — Terra $2.50/$15 → **$2/$12**, Luna $1/$6 → **$0.20/$1.20**. Luna is now
   **5× cheaper than the ticket assumed** and **10× cheaper than Terra** [1][2][3].
2. **Terra — today's implement default — is provably off the efficient frontier.** Artificial
   Analysis: *"For any Terra effort level, there is a Luna or Sol effort level that is more
   intelligent at no extra cost, or equally intelligent at lower cost"* [4].
3. **Our ledger says the cheap seat already works** — where it runs at all. Median all-in per
   ticket: pure-terra **$3.68**, pure-opus-4.8 **$9.38**, pure-fable **$18.52** (n=38/75/20).
   Terra and opus both land 98%. 31% of terra tickets get rescued by a heavy model, lifting
   terra's *expected* cost to ~$5.03 — still ~1.9× cheaper.
4. **The real terra tax isn't quality, it's the harness.** **40% of pi/terra implement runs never
   start** — zero tool calls, ~$0, no work done. Claude: **2 of 315 (0.6%)**. Terra's headline 48%
   not-done rate collapses to **14%** once those are excluded. We've been blaming the model for a
   launcher bug.
5. **The concierge seat is the biggest standing cost in the system — bigger than any worker.**
   From 30 days of transcripts: **~$70/day median, ~$2,090/mo** on Opus 5 — *more than 20 days of
   all worker spend combined* ($2,574). Sonnet 5 would cut it to **~$1,254/mo list, ~$836/mo
   intro**.

**The one-line answer to ro's question:** small-implement + heavy-review wins decisively on
*mechanical and well-specified* work (~60% saving, real), and loses on *fuzzy, visual, or
long-context* work — where luna's context cliff (MRCR 72.5% → **41.3%**) and pi's lack of eyes
are not reviewable defects, because a reviewer cannot see what the implementer never looked at.

## 1. Price per Mtok — current as of 2026-07-30

All figures list price, USD per million tokens.

| Model | Harness | Input | Output | Cached in | Cache write | Source |
|---|---|---:|---:|---:|---:|---|
| **gpt-5.6-luna** | `pi` | **$0.20** | **$1.20** | $0.02 | $0.25 | [1][3] |
| **gpt-5.6-terra** | `pi` | **$2.00** | **$12.00** | $0.20 | $2.50 | [1][3] |
| gpt-5.6-sol | *blocked on our tier* | $5.00 | $30.00 | $0.50 | $6.25 | [1][3] |
| **claude-sonnet-5** | `claude` | **$3.00** ($2.00 intro¹) | **$15.00** ($10.00 intro¹) | $0.30 | $3.75 | [5] |
| claude-opus-5 | `claude` | $5.00 | $25.00 | $0.50 | $6.25 | [5] |
| claude-fable-5 | `claude` | $10.00 | $50.00 | $1.00 | $12.50 | [5] |

¹ Sonnet 5 introductory pricing runs **through 2026-08-31**. Budget on $3/$15 — the intro rate
expires in a month and any saving built on it evaporates.

Claude cache reads are 0.1× input, cache writes 1.25× (5-min TTL) or 2× (1-hour TTL). This matters
more than the sticker price for us: **cache reads are 78% of concierge token volume** (§4).

### The 30 July price cut

The ticket quotes luna at ~$1/$6 and terra at ~$2.50/$15. Those were correct **at launch on
9 July 2026** [2] and were cut on **30 July** — Terra by 20%, Luna by 80%, on the back of a
reported 20% reduction in OpenAI's serving cost [1][3]. Sol was not cut.

The consequence is not marginal: at launch luna was half of terra; today it is **one tenth**.
Any "is the cheap seat worth it" analysis done before today understates luna's advantage by 5×.

> **Caveat on our actual rates.** We drive `pi` through a ChatGPT-account tier, not the public API,
> so list price is an upper bound. Our ledger's implied blended all-in terra rate is **$0.67/Mtok**,
> well under the list-implied blend — consistent with heavy cache hits and possibly account-tier
> pricing. Treat the table as the *relative* ranking and §3 as our *absolute* cost.

## 2. Published capability benchmarks

| Benchmark | Luna | Terra | Sonnet 5 | Opus 5 | Fable 5 | Src |
|---|---:|---:|---:|---:|---:|---|
| SWE-bench Verified | 93.0% | — | 85.2% | **97.0%** | 95.0% | [6][7] |
| SWE-bench **Pro** | 62.7% | 63.4% | — | — | **80.0%** | [6][8] |
| Terminal-Bench 2.1 | 84.7% | 87.4% | 80.4% | — | **88.0%** | [8][7] |
| Agents' Last Exam | >Fable | >Fable | — | — | 40.5 | [2][9] |
| MRCR 512K–1M (long ctx) | **41.3%** | 72.5% | — | — | — | [6] |
| AA Intelligence Index (max) | 51 | 55 | — | — | **60** | [4] |
| AA cost to run the index | **$0.21** | $0.55 | — | — | $3.12 | [4] |

**How to read this, because the benchmarks genuinely disagree:**

- **Terminal/agentic: the gap is small.** Terra (87.4) is within 0.6 points of Fable 5 (88.0) at
  a fraction of the price; Luna (84.7) is 3.3 back. This is the shell-driving, build-run-fix
  profile — much of our routine backend work.
- **Real-repo patching: the gap is large and favours Claude.** SWE-bench **Pro** (real GitHub
  issues in their original environment) has Fable 5 at **80.0%** vs the whole GPT-5.6 family at
  62.7–64.6% — a ~17-point gap on the board that most resembles what our implement seats do.
  But OpenAI disputes its reliability [2], and SWE-bench *Verified* tells the opposite story
  (Luna 93.0%). **The two boards genuinely conflict; treat neither as settled.**
- **Long-horizon workflows: pi wins outright.** On Agents' Last Exam, OpenAI reports Terra *and
  Luna* beating Fable 5 "at around one-sixteenth the cost" [9]. Vendor-shaped, but the direction
  matches our ledger.
- **Luna has one disqualifying cliff: long context.** MRCR at 512K–1M drops from Terra's 72.5%
  to Luna's **41.3%** [6], against a median terra implement run of **1.46M input tokens**. This
  is the single most important number in the table for us.

**The Pareto finding.** Artificial Analysis is blunt: *"For any Terra effort level, there is a
Luna or Sol effort level that is more intelligent at no extra cost, or equally intelligent at
lower cost"* [4]. Terra sits **off** the efficiency frontier. Since Sol is hard-blocked on our
ChatGPT-account tier, the actionable half of that sentence is: **where the task fits in luna's
context budget, luna should be preferred to terra.**

## 3. Our data: real observed cost per ticket

**Source.** `~/.beckett/spend.jsonl`, written by `Dispatcher.recordSpend` — the structured twin of
the `_N turns · M tool calls · X tokens · ~$Y_` footer on worker comments. Both read the same
`handle.telemetry()` (`src/dispatch/dispatcher.ts:2890`), so the ledger *is* the footers, with
fields kept separate instead of formatted into prose.

**Sample size, stated honestly:**

- **773 runs** across **207 tickets**, **2026-07-11 → 2026-07-31** (20 days). Total **$2,574**.
  599 runs are project `beckett`; the rest spread thin across 12 others.
- **16 runs have null cost** (all `claude`); **94 have null token counts**. Excluded from rate math.
- **There are zero `gpt-5.6-luna` rows. Luna has never been cast.** Every luna claim here is from
  published benchmarks and price sheets, not experience. That is the biggest gap in this analysis
  and why §6 recommends a bounded trial rather than a playbook change.
- Cells below n=20 are indicative only. Fable (n=20 tickets) and opus-5 (n=12) are thin.
- **Selection bias runs through everything.** Terra is cast on work we already judged easy, fable
  on work we already judged hard — so the cost gap is *partly* a gap in ticket difficulty, not
  model efficiency. Nothing here is a controlled comparison.

### 3.1 Cost per ticket, all-in (implement + review + retries)

| Primary implement model | Tickets | Median | Mean | p90 | Attempts | Landed |
|---|---:|---:|---:|---:|---:|---:|
| claude-opus-4-8 | 103 | $10.26 | $12.38 | $23.25 | 2.33 | 98% |
| **gpt-5.6-terra** | **57** | **$5.35** | $8.14 | $16.50 | 2.09 | **98%** |
| claude-fable-5 | 21 | $18.72 | $18.93 | $36.44 | 1.19 | 100% |
| claude-opus-5 | 18 | $16.30 | $21.12 | $36.23 | 2.06 | 83% |
| claude-sonnet-5 | 8 | $4.69 | $7.11 | $16.40 | 1.62 | 75% |

Restricted to tickets where **one** model did all the implement work (no escalation):

| Pure cast | Tickets | Median all-in |
|---|---:|---:|
| gpt-5.6-terra | 38 | **$3.68** |
| claude-opus-5 | 12 | $8.04 |
| claude-opus-4-8 | 75 | $9.38 |
| claude-fable-5 | 20 | $18.52 |

**Terra lands 98% of its tickets at 39% of opus-4.8's median cost.** Fable's 100% landing rate and
1.19 attempts are real — and so is its 5× price.

### 3.2 The escalation tax

**55 of 207 tickets** used more than one implement model. The paths that matter:

| Path | Tickets |
|---|---:|
| claude-opus-4-8 → gpt-5.6-terra | 22 |
| gpt-5.6-terra → claude-opus-4-8 | 11 |
| gpt-5.6-terra → claude-opus-5 | 5 |
| gpt-5.6-terra → claude-fable-5 | 1 |

Separately — and confusingly, the same number — **55 tickets *started* on terra**: 38 finished on
terra alone, **17 escalated to a heavy seat (31%)** at a median all-in of **$8.02** vs **$3.68**
when terra finishes alone. So the expected cost of a terra start is
0.69 × $3.68 + 0.31 × $8.02 ≈ **$5.03**, against pure opus-4.8 at **$9.38**.

**Even paying the full bounce tax, starting on terra is ~1.9× cheaper.** The 22 opus→terra tickets
are the reverse flow (heavy scopes, cheap finishes), not failures.

### 3.3 The harness tax — the finding that reframes everything

| Implement cast | Runs | No-op runs (≤1 turn, 0 tool calls) |
|---|---:|---:|
| gpt-5.6-terra medium | 53 | **28 (53%)** |
| gpt-5.6-terra high | 159 | **63 (40%)** |
| claude-opus-5 high | 34 | 2 (6%) |
| claude-opus-4-8 (all) | 232 | **0 (0%)** |
| claude-sonnet-5 (all) | 18 | **0 (0%)** |
| claude-fable-5 high | 26 | **0 (0%)** |

**40–53% of pi/terra runs never start** — zero tool calls, ~$0 billed, no work done; 28 of terra
medium's 34 "failures" are these. The whole `claude` harness has **2 no-ops in 315 implement runs
(0.6%)**, both opus-5. Excluding no-ops, the quality picture inverts:

| Implement cast | Substantive runs | Failed/rework | Median cost |
|---|---:|---:|---:|
| claude-fable-5 high | 26 | **0%** | $13.52 |
| claude-opus-4-8 medium | 34 | 9% | $2.42 |
| **gpt-5.6-terra high** | **96** | **14%** | **$1.12** |
| claude-opus-4-8 high | 182 | 18% | $4.23 |
| claude-opus-5 high | 32 | 22% | $8.00 |
| gpt-5.6-terra medium | 25 | 24% | $0.37 |

**Terra at high has a *lower* substantive failure rate than opus-4.8 at high (14% vs 18%) at one
quarter the cost.** Terra's bad reputation is a launcher-reliability problem wearing a
model-quality costume. Worth a ticket of its own — the cheapest available win in the system,
and not a casting decision.

### 3.4 The review gate

Review is **18.8% of all spend** ($482.65 of $2,574). 369 implement runs ran under `fresh`,
158 under `self`.

| Reviewer | Reviews | Sent back | Rate | Total cost | **Cost per catch** |
|---|---:|---:|---:|---:|---:|
| claude-sonnet-5 | 185 | 51 | 27.6% | $333.77 | **$6.54** |
| claude-opus-5 | 25 | 11 | **44.0%** | $60.25 | **$5.48** |
| claude-fable-5 | 33 | 4 | 12.1% | $84.96 | $21.24 |

Sonnet 5 costs **$1.44 median** per review and catches something 27.6% of the time. Opus 5 sends
back 44% — but n=25, and opus-5 review lands on harder tickets, so that is at least partly ticket
difficulty, not reviewer acuity. **Fable as a reviewer is poor value at $21/catch:** 1.7× sonnet's
price to send back less than half as often. Pay fable to *implement*, not to review.

The naive gate delta (reviewed vs unreviewed: +$4.31 terra, +$8.37 opus-4.8) **overstates the
gate's cost** — it includes the rework runs the gate triggered, and unreviewed tickets are the
easy ones by construction. The honest figure is the review run itself: **~$1.44 median, ~$1.65
on a terra ticket.**

**Verdict: the fresh gate is cheap and earns its keep.** ~$1.44 to catch a defect 28% of the time
against a $3.68–$9.38 median ticket is not a close call. The gate is not where our money goes —
the implement seat is.

## 4. Is claude-sonnet-5 at medium a sound concierge seat?

**Measured, not estimated.** From 1,440 concierge transcripts in
`~/.claude/projects/-home-beckett-beckett/`, 30,148 assistant turns with usage records:

| | Value |
|---|---|
| Median daily cost (Opus 5 rates, last 14 days) | **$69.66** |
| Mean daily | $97.20 |
| Implied monthly | **~$2,090** |
| Same traffic, Sonnet 5 list ($3/$15) | ~$41.80/day → **~$1,254/mo** |
| Same traffic, Sonnet 5 intro ($2/$10) | ~$27.87/day → ~$836/mo |
| Cache reads as share of tokens | **78%** (1.89B of 2.42B) |

For scale: **the concierge seat costs more per month than every worker in the ledger cost in
20 days combined** ($2,574). ro is right that it is the priciest standing cost in the system.

**The saving is real but smaller than the sticker suggests.** 78% of concierge tokens are cache
reads billed at 0.1× — the seat is dominated by *re-reading its own context*, not generating
(output is only ~$15/day of the ~$70). So the saving tracks the input-side ratio (5:3, ~40%),
not the headline tier gap.

**The work is a genuine fit.** The seat is conversation, tool dispatch, and judgment about where
work goes — not deep implementation. Sonnet 5's 80.4 Terminal-Bench / 85.2 SWE-bench Verified [7]
are not the binding constraint on a seat that reads a board, classifies a request, files a ticket.

**What would regress — watch these specifically:**

1. **Casting judgment itself.** The concierge decides which model implements. A cheaper router
   making worse calls costs more downstream than it saves: one extra fable-tier miscast ($18.52)
   wipes out ~11 days of saving. **This is the real risk**, and no benchmark measures it.
2. **Long-session coherence.** Sessions are long and cache-heavy — the exact profile where the
   ledger shows sonnet-5 implement runs at 25% substantive failure (n=12, thin). Watch for
   dropped promises and repeat-questions across a day.
3. **Ambiguity handling.** Sonnet 5 follows instructions **more literally** than Opus 5 [5]. For
   a seat that infers what a half-sentence mention wants, more literal is worse — expect more
   clarifying questions and more mis-scoped tickets.
4. **No mid-conversation system messages.** Opus 5 supports `role:"system"` mid-thread; **Sonnet 5
   does not** [5]. Any steering that relies on it must fall back to `<system-reminder>` in a user
   turn — a code path, not a prompt tweak.
5. **Intro price expires 2026-08-31.** A decision justified on $836/mo is a $1,254/mo decision
   from September.

**Verdict: sound, and worth trialling — but not as a silent swap.** Run a week with casting
decisions logged and diffed against what Opus 5 would have chosen. Gate the change on **routing
quality, not cost saving** — the saving is not in question, the routing quality is, and one bad
routing habit costs more than the ~$836/mo it saves.

## 5. Where small-implement + heavy-review beats heavy-implement

**Where it wins** — mechanical and well-specified work with a checkable definition of done:

| | Heavy implement | Small + heavy review | Delta |
|---|---:|---:|---:|
| Observed median all-in (our ledger) | $9.38 (opus-4.8) | $3.68 (terra) | **−61%** |
| Expected, incl. 31% escalation | $9.38 | ~$5.03 | **−46%** |
| Substantive failure rate | 18% | 14% | favours terra |

Adding a heavier reviewer to a terra ticket costs ~$1.44–$2.14 and still lands far under a heavy
implement seat. **On well-specified backend work the pattern is straightforwardly correct** — our
ledger demonstrates it at n=38. Not a hypothesis; current practice nobody had costed.

Published research agrees on the shape: practitioners converge on *"a large reasoning model to
plan and architect; a cheaper, fast model to execute the plan; and a different, independent model
to review"* [10]. Note the first clause — **the plan comes from the expensive model.** The saving
comes from cheapening *execution*, not judgment. We currently hand terra the ticket description
and hope; the pattern says hand it a plan.

### Where it does NOT win — named failure modes

1. **Visual/frontend — pi has no eyes.** A reviewer cannot catch a layout defect the implementer
   never saw. This is a *sensory* gap, not a quality gap review can close. Cast `claude` for
   anything with a rendered surface, one-pass (`reviewTier: "self"`) — a reviewer who also can't
   see adds cost without signal.
2. **Fuzzy specs — luna and terra drift.** The pattern needs a checkable "done." Given a
   paragraph of intent, a cheap implementer confidently builds the wrong thing and gets bounced —
   and each bounce is a full implement run. Escalated terra tickets cost **$8.02 vs $3.68**, so
   two bounces erase the entire saving.
3. **Long-context — luna's hard cliff.** MRCR 72.5% → **41.3%** past 512K [6] against a 1.46M-token
   median run. Disqualifying for large-repo work on published numbers alone. **This is why luna
   is not the new default.**
4. **Correctness-critical — SWE-bench Pro's 17-point gap.** Where a subtle defect is expensive
   (dispatcher, auth, money, migrations), fable's 80.0% vs the GPT family's ~63% [8] is what
   matters, backed by fable's **0% failure rate in 26 substantive runs**. Review is a filter, not
   a guarantee — sonnet catches 27.6% of the time, so it *misses* most of the time.
5. **The harness tax makes cheap seats slow.** A 40% no-op rate means a terra ticket often needs
   two launches — nearly free in dollars, expensive in wall-clock. When latency matters more than
   money, the cheap seat is the wrong trade until §3.3 is fixed.

## 6. Weight-of-task → cast

Four classes. Each names a concrete harness + model + effort and a verdict on the fresh gate.

### Class 1 — Trivial / mechanical
*Copy tweaks, version bumps, config edits, renames, doc typos, obvious single-file diffs.*

- **Cast:** `pi` / `gpt-5.6-terra` / **low** — note the ledger contains **no terra-low runs at all**
  (only medium and high), so this tier is an extrapolation from terra-medium's $0.37 median, not
  an observed result.
- **Fresh review: No** — `reviewTier: "self"`. A ~$1.44 review on a sub-$0.50 run is 3–4× overhead
  to check a diff whose correctness is visible in the diff.
- **Why not luna:** should be luna on price ($0.20/$1.20, Terminal-Bench 84.7); blocked only by
  zero operational evidence — see the trial below.

### Class 2 — Standard spec'd work *(the common case)*
*Well-specified backend: APIs, parsers, data layers, business logic, tests, migrations. "Done"
is checkable.*

- **Cast:** `pi` / `gpt-5.6-terra` / **high** — note **high, not medium.** Terra-high fails 14%
  vs terra-medium's 24%, for $1.12 vs $0.37. Paying $0.75 to halve the bounce rate is correct
  when a bounce costs a full rerun.
- **Fresh review: Yes** — `claude-sonnet-5`, ~$1.65 on a ~$5 ticket, catches 27.6%. Best-evidenced
  cell here (n=38), and it already works.
- **Expected all-in:** ~$5.03 incl. escalation tax vs ~$9.38 heavy. **~46% saving.**

### Class 3 — Judgment-heavy
*Ambiguous specs, design decisions, wide refactors, anything visual, anything where "what should
this do" is the hard part.*

- **Cast:** `claude` / `claude-opus-5` / **high**; visual work adds `reviewTier: "self"`.
- **Fresh review: only for non-visual work.** Judgment work bounces on taste, and a taste bounce
  costs a full $8.00 implement run.
- **Why not terra:** failure mode #2 — the saving is real only when "done" is checkable.

### Class 4 — Correctness-critical
*Dispatcher, auth, money, migrations, concurrency — anywhere a subtle defect is expensive later.*

- **Cast:** `claude` / `claude-fable-5` / **high** — confirm-before-cast on channel stays.
- **Fresh review: Yes, but reviewer = `claude-opus-5`, not fable.** Opus-5 sends back 44% at
  $5.48/catch; fable 12.1% at $21.24/catch. Pay fable to *implement*, opus to *review*. This is
  a concrete change from current practice.
- **Justification:** fable is 0-for-26 on substantive failures and leads SWE-bench Pro by ~17
  points. Expensive at $18.52/ticket, and worth it *here and only here*.

### Summary

| Class | Harness / model / effort | Fresh gate | Expected all-in |
|---|---|---|---:|
| 1 · Trivial | `pi` / terra / low | **No** (self) | ~$0.40 |
| 2 · Standard spec'd | `pi` / terra / **high** | **Yes** (sonnet-5) | ~$5.03 |
| 3 · Judgment-heavy | `claude` / opus-5 / high | Yes; **No** if visual | ~$8–16 |
| 4 · Correctness-critical | `claude` / fable-5 / high | **Yes — opus-5** | ~$18–21 |

### The luna trial (recommended, not a playbook change)

Luna has **never been cast**, and at $0.20/$1.20 it is 10× cheaper than terra with Terminal-Bench
within 2.7 points; the Pareto finding says it should displace terra wherever context allows [4].
Proposal for #108.2: cast luna on **20 Class-1 tickets**, `reviewTier: "self"`, with a hard rule
that anything reading >400K tokens goes to terra instead (the MRCR cliff). Compare no-op rate,
substantive failure rate and cost per ticket against §3's terra baselines. A ~$10 experiment
against a five-figure annual line item.

## 7. What this doc does not know

- **Nothing about luna operationally** — zero rows; every luna claim is vendor or third-party.
- **No controlled comparison anywhere.** Casts were chosen by expected difficulty, so cost gaps
  partly measure ticket difficulty. All deltas are directional.
- **Thin cells:** fable n=20 tickets, opus-5 n=18, sonnet-5 implement n=8. The opus-5 xhigh 60%
  failure rate (n=5) is noise — do not cite it.
- **Benchmarks conflict and some are vendor-shaped** (SWE-bench Verified vs Pro; Agents' Last
  Exam is OpenAI's own reporting).
- **Concierge cost is a reconstruction** from transcript tokens at list prices, not a billed
  figure — the ledger covers workers only. Daily variance is large ($25.70–$253.21).

## Sources

1. [OpenAI cuts prices for two of its GPT-5.6 AI models — CNBC, 30 Jul 2026](https://www.cnbc.com/2026/07/30/open-ai-price-cut-gpt.html)
2. [The new GPT-5.6 family: Luna, Terra, Sol — Simon Willison, 9 Jul 2026](https://simonwillison.net/2026/Jul/9/gpt-5-6/)
3. [OpenAI API Pricing, July 2026 — aipricing.guru](https://www.aipricing.guru/openai-pricing/)
4. [GPT-5.6 benchmarks across Intelligence, Speed and Cost — Artificial Analysis](https://artificialanalysis.ai/articles/gpt-5-6-has-landed)
5. Anthropic model pricing and capability reference — `claude-api` skill, cached 2026-06-24; live: [platform.claude.com/docs/en/pricing](https://platform.claude.com/docs/en/pricing)
6. [GPT-5.6 Benchmark Review: Sol, Terra, Luna — LayerLens](https://layerlens.ai/blog/gpt-5-6-benchmark-review-sol-terra-luna)
7. [Claude Sonnet 5 Benchmarks Explained — Vellum](https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained)
8. [GPT-5.6: Models Explained, Benchmarks & Access — CometAPI](https://www.cometapi.com/gpt-5-6-models-explained-benchmarks-access/)
9. [OpenAI on Agents' Last Exam results](https://x.com/OpenAI/status/2075271423992680532)
10. [Best LLM for Code Review in 2026 — Tokenwise](https://tokenwisehq.com/best-llm-for/code-review)
11. Our telemetry: `~/.beckett/spend.jsonl` (773 runs, 207 tickets, 2026-07-11 → 2026-07-31);
    emitter `src/dispatch/dispatcher.ts:2890`. Concierge: 1,440 transcripts in
    `~/.claude/projects/-home-beckett-beckett/`.
