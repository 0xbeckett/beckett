# pi harness review — auth, providers, and load balancing

Audit date **2026-07-29**, against `pi` **0.82.1**, beckett **v6.14.0** (`53dc03d`).
Every claim below was checked against the installed pi package or exercised live; the
"verified" notes say which. Nothing here is inferred from the header comments.

---

## 1. Verdict

The **driver** is in good shape. `src/drivers/pi.ts` is the most carefully built harness
adapter in the tree: live steering over `--mode rpc`, `agent_settled` (not `agent_end`) as the
terminal event, a bounded settle-time steering drain with a spin guard, provider-error detection
so an auth-dead run can't finish as an empty success, SIGTERM→SIGKILL process-*group* teardown,
and a preflight that distinguishes a KILLED probe from a FAILED one. I found no correctness bug
in the RPC lifecycle.

The **provider layer around it** is where the work is. pi is provider-agnostic; Beckett is not
yet. Concretely:

| Ask | State |
|---|---|
| Claude via OAuth token | **Works.** Verified live. |
| Codex subscription | **Works.** Verified (`~/.pi/agent/auth.json` holds the `openai-codex` OAuth grant). |
| OpenRouter models | **Already works, and is already castable** — verified live end-to-end for `moonshotai/kimi-k3`, `x-ai/grok-4.5`, `z-ai/glm-5.2`. Zero code change needed to cast them. |
| OpenRouter *endpoint/quantization* pinning (`modal/mxfp4`, `moonshotai/mxfp4`) | **Supported by pi, not reachable from Beckett.** Needs a `models.json` that Beckett doesn't own. No extension required. |
| Other API configs | Reachable in principle (pi ships ~35 provider→env-key mappings), but preflight will lie about three of the four auth mechanisms. |
| Load balancing across the three budgets | **Not implemented.** The fallback graph is drawn over the wrong axis. |

Two things are actively wrong rather than merely missing: the preflight auth check (§3.1) and
telemetry silently dropping runs (§3.4).

---

## 2. What works today — verified, not assumed

### 2.1 The three credential mechanisms

pi resolves credentials three different ways, and Beckett's env guard interacts with each
differently:

| Provider | Credential source | Survives `childEnv()`? |
|---|---|---|
| `openai-codex` | `~/.pi/agent/auth.json` OAuth grant (type/access/refresh/expires/accountId) | n/a — file, not env |
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN` env var | **Yes** — explicitly allowlisted (`src/env.ts:31`) |
| `openrouter` + ~33 others | `OPENROUTER_API_KEY` etc. env var | **Yes** — `OPENROUTER_` is not a forbidden prefix (`src/env.ts:24`) |

The forbidden prefixes are `ANTHROPIC_`, `OPENAI_`, `CLAUDE_CODE_`. That means the API-key
mechanism for every non-Anthropic, non-OpenAI provider passes through untouched. This is
*accidentally* correct — the subscription-only rule in the `src/env.ts` header no longer
describes what the code does, because a third-party API key is now a first-class auth path. The
comment should say so.

pi's provider→env map lives at
`node_modules/@earendil-works/pi-ai/dist/env-api-keys.js:72-108` and covers `openrouter`,
`xai`, `zai`, `moonshotai`, `groq`, `cerebras`, `deepseek`, `together`, `fireworks`,
`mistral`, `minimax`, `nvidia`, `huggingface`, `google`, `google-vertex`, Azure, Bedrock,
Cloudflare, and more. For `anthropic` it returns
`[ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY]` — which is exactly why the
`ANTHROPIC_OAUTH_TOKEN` allowlist in `src/env.ts` is load-bearing.

### 2.2 OpenRouter is already castable

`src/tracker/cast.ts:75` keeps `provider` an open string on purpose ("pi's provider catalog is
pi's to grow"). Combined with §2.1, this means a cast of

```json
{"implement": {"harness": "pi", "provider": "openrouter", "model": "x-ai/grok-4.5", "effort": "high"}}
```

works right now. Verified live for all three requested models, with pi reporting real dollar
cost per turn, which `PiDriver.handleTurnEnd` (`src/drivers/pi.ts:973-988`) already accumulates
into the spend ledger:

```
x-ai/grok-4.5        stop  $0.0013004   "OPENROUTER_OK"
moonshotai/kimi-k3   stop  $0.0006996   "OK"
z-ai/glm-5.2         stop  $0.0003467   "OK"
```

`--thinking xhigh` also verified against `z-ai/glm-5.2` — accepted, no error.

Pricing at the top of the frontier (OpenRouter, $/Mtok in/out, checked 2026-07-29):
`moonshotai/kimi-k3` 3 / 15 @ 1.05M ctx · `x-ai/grok-4.5` 2 / 6 @ 500k ctx ·
`z-ai/glm-5.2` 0.68 / 2.13 @ 1.05M ctx.

GLM-5.2 at $0.68/$2.13 is roughly **an eighth** of Opus 5's input rate and a twelfth of its
output rate. That gap is the whole argument for the router in §4.

---

## 3. Defects and gaps, in priority order

### 3.1 `piPreflight` validates the wrong provider, and knows only one of three auth mechanisms

`src/drivers/pi.ts:270-285`:

```ts
const provider = config.harness.pi.default_provider;
if (provider && !auth.includes(provider)) {
  problems.push(`pi login at ${authPath} does not include provider ${provider}.`);
}
```

Two independent bugs:

**(a) It checks the *default* provider, never the one this spawn will use.** `resolvedProvider()`
(`src/drivers/pi.ts:530-534`) prefers `spec.provider`, so a stage cast at `openrouter` — or at a
typo'd provider name — sails through a preflight that only ever inspected `openai-codex`. The
guard exists precisely so a credential problem surfaces *before* the child spawns; for every
cast-provider run, it doesn't.

**(b) It only understands the auth.json path.** `~/.pi/agent/auth.json` on this box contains
exactly one key: `openai-codex`. `anthropic` and `openrouter` authenticate by env var and will
*never* appear there. So the moment `harness.pi.default_provider` is set to `anthropic` or
`openrouter`, **every pi spawn fails preflight** with a false "no login" — and because
`PiDriver.spawn` throws on `!pf.ok` (`src/drivers/pi.ts:464-473`), the dispatcher substitutes
away from a perfectly healthy harness. The check inverts into the failure it was written to
prevent.

**Fix.** Replace the substring test with a provider→credential-source table:

```ts
type CredentialSource = { kind: "authjson" } | { kind: "env"; keys: string[] };
```

resolve it for the provider *this spawn* will use (thread `spec.provider` into `piPreflight`),
and report the actual missing thing ("`OPENROUTER_API_KEY` is not set in the daemon env"). An
unknown provider should be its own loud problem, not a silent pass.

### 3.2 Endpoint/quantization pinning: supported by pi, unreachable from Beckett

The requested `modal/mxfp4` and `moonshotai/mxfp4` are OpenRouter **endpoint tags**, not model
ids. `moonshotai/kimi-k3` currently has nine endpoints:

```
DigitalOcean(unknown) · Modal(mxfp4) · BaseTen(fp8) · Morph(unknown) · Nebius(fp4)
Fireworks(unknown) · Together(unknown) · Moonshot AI(mxfp4) · Fireworks/fast(unknown)
```

Two findings:

- **Slug-suffix pinning does not work.** `moonshotai/kimi-k3:modal/mxfp4`,
  `:baseten/fp8` and `:nebius/fp4` all routed to **Moonshot AI** with no error — verified live
  against three different suffixes. Anything that relies on encoding the endpoint in the model
  string will silently route somewhere else. Do not build on it.
- **pi supports the real mechanism natively, with no extension.** `compat.openRouterRouting` is
  emitted straight into the request body at
  `pi-ai/dist/api/openai-completions.js:642-644`, and the `models.json` schema accepts the full
  OpenRouter routing object — `order`, `only`, `ignore`, `quantizations`, `sort`,
  `allow_fallbacks`, `require_parameters`, `zdr`, `data_collection`
  (`pi-coding-agent/dist/core/model-config.js:13-30`, referenced at `:84`). Verified live that
  `provider.order: ["modal/mxfp4"]` + `allow_fallbacks: false` pins to Modal.

So the pinned SKUs are pure configuration:

```json
{
  "providers": {
    "openrouter-modal": {
      "name": "OpenRouter (Modal mxfp4)",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [{
        "id": "moonshotai/kimi-k3",
        "name": "Kimi K3 (Modal mxfp4)",
        "reasoning": true, "input": ["text"],
        "contextWindow": 1048576, "maxTokens": 65536,
        "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 0 },
        "compat": {
          "thinkingFormat": "openrouter", "supportsReasoningEffort": true,
          "openRouterRouting": { "order": ["modal/mxfp4"], "allow_fallbacks": false }
        }
      }]
    }
  }
}
```

Two pinned variants of one upstream model need **two provider ids** (`openrouter-modal`,
`openrouter-moonshot`), because the pin rides the provider entry while `id` must stay the real
OpenRouter slug. A cast then reads
`{"harness":"pi","provider":"openrouter-modal","model":"moonshotai/kimi-k3"}` — and `cast.ts`
already accepts it.

**The actual gap is ownership.** `~/.pi/agent/models.json` is untracked box state. A pinned SKU
placed there is invisible to the repo, absent from a fresh install, and lost on a rebuild —
the same class of problem as the hand-populated metrics dashboard. `models.json` should be a
**generated artifact**: a `[harness.pi.models]` block in config → rendered to
`~/.pi/agent/models.json` at daemon boot, with the file carrying a "generated by beckett, do
not edit" header. That also gives `beckett doctor` something to verify.

`modelOverrides` (documented in pi's `docs/models.md`) is the lighter tool when you only want to
adjust a built-in entry — it patches `compat`/`cost`/`contextWindow` without replacing the
provider's model list. Use it for pins on models pi already knows; use a full `providers` entry
when you need two differently-pinned copies of the same model.

### 3.3 No provider-level load balancing — the fallback graph is on the wrong axis

`harness.fallback_order` is `["claude", "pi", "codex"]` (`src/capability/builtins.ts:120-122`),
walked by `Dispatcher` only *after* a classed failure
(`src/dispatch/dispatcher.ts:2638-2670`). Two structural problems:

1. **The scarce resource is the account, not the harness.** `pi/anthropic` and the `claude`
   harness spend the *same* Anthropic subscription. When Anthropic rate-limits, substituting
   `pi → claude` moves the work to the same exhausted budget and burns a
   `max_harness_substitutions` slot doing it. Meanwhile `pi/openrouter` — a completely separate
   budget, with credits sitting idle — is not in the graph at all, because the graph has no
   concept of a provider.
2. **It is reactive only.** There is no headroom signal, so nothing can route *before* hitting
   a limit. The recorded operational history is the tell: pi's quota cap silently fell back to
   claude for two days and the fix was "cast claude directly by hand."

What is already in place to build on: `src/spend.ts` is a durable append-only per-stage ledger
with real `costUsd`, `harness`, `model`, and outcome; `classifyHarnessFailure`
(`src/drivers/failure.ts:33-42`) already separates `auth` from `rate_limit` from `spawn`. What's
missing is a **seat** abstraction — `(harness, provider, account, model)` — with per-account
budget state, and a router that picks a seat by work class × current headroom. See §4.

### 3.4 Telemetry silently drops every run on an unpriced model

`src/telemetry/harvest.ts:313-314`:

```ts
const rate = rateForModel(session.model, rates);
if (!rate) { note(`… skipped …; model ${session.model} has no rate in table`); return null; }
```

`config/model-rates.json` contains no OpenRouter model. So every OpenRouter run is **dropped
from the telemetry dataset entirely** — not flagged, not estimated, just absent, with one line
on stderr. The metrics dashboard would show the fleet getting cheaper because its expensive runs
stopped being counted. Given that dashboard is already hand-populated from a static dist, nobody
would notice.

Worse, it's redundant work: **pi reports real per-turn cost** and `PiDriver` already accumulates
it. The harvester recomputes cost from a rate table it may not have, and discards the run when
it can't — throwing away a number pi handed it for free.

**Fix (two parts).** (a) Prefer the harness-reported cost when present; fall back to the rate
table; only skip when *both* are unavailable, and surface the skip count in the dataset rather
than on stderr. (b) Add the OpenRouter SKUs to `config/model-rates.json` anyway, since the
frontier moves and a second source is useful for reconciliation.

### 3.5 No cast-time model validation for open providers

`BLOCKED_MODELS` (`src/tracker/cast.ts:104`) correctly scopes its ChatGPT-tier blocklist to
`openai-codex`. But with the provider field open, `x-ai/grok-4-5` (wrong separator) or a
retired slug is accepted at file time and fails at runtime — after a worker spawn, a worktree,
and a substitution cycle. OpenRouter publishes `GET /api/v1/models`; a cached daily snapshot
would let `validateCasting` reject a bad slug where it's cheap to reject.

### 3.6 The live config's comments describe a routing scheme that no longer exists

`~/.beckett/config.toml` opens with:

```
#   - Delegator (always-on parent brain + planning/clarify) ... Sonnet 4.6
#   - Implementations / code (spawned workers) ............... Opus 4.8
[harness.claude]
default_model = "claude-opus-4-8"
```

That header predates the Claude 5 family, and `harness.claude.default_model` is still pinned to
`claude-opus-4-8` — overriding the schema default of `claude-sonnet-5`. Whether the pin is still
wanted is a judgment call for the owner; the *comment* is straightforwardly misleading and the
`[plane]` block is vestigial (the Plane backend was removed in OPS-191). Worth one cleanup pass
while the seats are being re-cut anyway.

### 3.7 The browser lane's claude pin is real, and has exactly one fix

Confirmed independently: pi ships no MCP client — no `--mcp-config` flag, no `mcpServers`
settings key, and no `@modelcontextprotocol/sdk` anywhere in its dependency tree. The
`LANE_GAPS` entry (`src/drivers/lane.ts:122-126`) is accurate and the browser lane's pin to
`claude` (`src/drivers/lane.ts:98-104`) is honest. The named fix — a pi extension registering
the browser tool via `pi.registerTool()` — is the single highest-value item in the extension
backlog, because it is the only thing keeping any lane off pi. Spec: `docs/pi/p-mcp-bridge.md`.

### 3.8 Minor

- `resolvedThinking()` (`src/drivers/pi.ts:537-539`) passes Beckett's `low|medium|high|xhigh`
  straight to `--thinking`. pi's own vocabulary also has `minimal` and `max`, and a model's
  `thinkingLevelMap` can mark a level unsupported. `xhigh` verified fine on `z-ai/glm-5.2`, but
  this is worth a per-model check as the seat list grows rather than an assumption.
- `piPreflight` runs three subprocess probes on **every** spawn, with budgets of 30s/60s. Under
  the per-repo spawn cap that's tolerable, but it's pure serial latency on the dispatch path and
  a natural candidate for a short-TTL cache keyed on `(bin, provider)`.
- `REQUIRED_PI_FLAGS` (`src/drivers/pi.ts:124-131`) does not include `--provider`, `--model`, or
  `--thinking` — three flags the driver emits unconditionally. Cheap to add; catches the next
  CLI drift a release earlier.

---

## 4. Load balancing: the design

The unit that needs to exist is a **seat**, not a harness:

```ts
interface Seat {
  id: string;                 // "pi/anthropic/opus-5", "pi/openrouter/kimi-k3"
  harness: "claude" | "pi" | "codex";
  provider: string;           // pi --provider; "" for claude
  account: AccountId;         // "anthropic-sub" | "chatgpt-sub" | "openrouter-credits"
  model: string;
  classes: WorkClass[];       // which work this seat is allowed to take
  rate: { inUsdPerMtok: number; outUsdPerMtok: number };
}
```

The key move is `account`, because **that** is the thing that runs out. `claude/*` and
`pi/anthropic/*` share `anthropic-sub`. `pi/openai-codex/*` is `chatgpt-sub`.
`pi/openrouter/*` is `openrouter-credits` — metered in dollars, so its headroom is *knowable*
rather than inferred.

**Headroom per account.** Three different signals, and the design should not pretend they're the
same:

- `openrouter-credits` — exact, cheap, and pollable: `GET /api/v1/credits`. Dollars remaining.
- `anthropic-sub` / `chatgpt-sub` — no quota API. Headroom is *inferred* from the
  `rate_limit` classifications already produced by `classifyHarnessFailure`, plus rolling spend
  from `src/spend.ts`. A `rate_limit` on an account sets a cooling-off with exponential backoff;
  a clean run clears it.

The honest framing: OpenRouter gets a real gauge, the two subscriptions get a circuit breaker.
Do not build a UI that implies otherwise.

**Routing policy.** Cheapest seat that clears the bar for the work class, subject to account
headroom:

| Work class | Preferred | Rationale |
|---|---|---|
| mechanical / grind (lint fixes, renames, mechanical refactors) | `openrouter/glm-5.2`, `pi/openai-codex/gpt-5.6-luna` | ~10× cheaper; the task is verifiable by tests |
| bulk read / summarize / audit (large context) | `openrouter/kimi-k3` (1.05M ctx) | context per dollar |
| implement (real feature work) | `pi/openai-codex/gpt-5.6-terra`, `pi/anthropic/claude-sonnet-5` | the current default, unchanged |
| review / judgment | `pi/anthropic/claude-fable-5` | already the reviewer default |
| taste / design / owner-facing | `pi/anthropic/claude-opus-5` | unchanged |

**Guardrails, because a naive cost router is worse than none.** (a) Never downgrade a seat
mid-ticket — `cast-is-immutable-in-flight` is a known hazard; a rework cycle gets the *same*
seat unless a human re-casts. (b) A seat that fails twice on the same ticket is out for that
ticket, cheap or not. (c) A cheap seat that produces rework twice as often is not cheap — feed
`outcome` from the spend ledger back into the choice, which is what the Learning Loop organ is
for. (d) The router must be *explainable*: every routing decision gets one line in the ticket
("routed to openrouter/glm-5.2 — mechanical class, anthropic-sub cooling until 14:20").

**Where the code goes.** A new `src/route/` module — a pure function
`pickSeat(workClass, accountState, config) → Seat` plus an account-state store — consulted in
two places: `Dispatcher.castFor` (as the default when a ticket names no cast) and the
classed-failure recovery path, which stops walking `fallback_order` and starts asking the router
for the next seat on a *different account*. `fallback_order` stays as the last-resort chain when
the router has nothing.

---

## 5. Chat seat: Opus 5 → Sonnet 5 medium, with an Advisor

The chat seat is `concierge.model` / `concierge.effort` (`src/capability/builtins.ts:538,543`),
consumed at `src/concierge/index.ts:672,1073`. The concierge spawns `claude` **directly**, not
through the lane seam, and depends on `--json-schema` for its turn contract
(`src/concierge/index.ts:1064`) — a flag pi does not have. So the chat seat stays on claude; the
change is two config values.

The risk is real and worth naming: the concierge doesn't just talk. It writes the cast blocks,
the acceptance criteria, and the briefs that workers execute — and brief quality is the single
biggest lever on whether a worker succeeds first try. Sonnet at medium will hold the voice and
the triage fine; it will write blander criteria.

Which is exactly what the **Advisor agent** is for, and the ordering matters: the Advisor must
land and be verified *before* the chat seat drops, not alongside it. Otherwise the first week of
Sonnet chat produces weak briefs with nothing to catch them.

Shape: a builtin agent in `src/agent/builtins.ts` (the registry is read live — no rebuild, no
restart), seated at `pi/anthropic/claude-opus-5` or `claude-fable-5` @ high, whose *only* job is
brief-craft: take the concierge's rough intent plus the recalled context, and return a
worker-ready brief — scope, acceptance criteria with a stated ceiling, the cast, and the
explicit non-goals. It writes no code and touches no repo. The existing operating doctrine
already encodes the house rules it needs (smallest complete ask, ceiling in the criteria, never
"passes N consecutive runs"), so those go in its system prompt verbatim.

Then the concierge's doctrine gains one rule: **before filing any ticket or plan, call the
advisor and file what it returns.** Cheap (one short agent run per ticket, not per turn), and it
keeps the expensive model exactly where it earns its price.

---

## 6. Recommended sequence

Ordered by dependency, not by size. Each step is independently landable.

1. **Preflight credential table** (§3.1) — small, and it unblocks everything else honestly. Do
   this first; it is the only item that turns a working provider into a broken one.
2. **Telemetry: prefer harness-reported cost** (§3.4) — small, and it must precede any
   cost-based routing, because the router's inputs are these numbers.
3. **`models.json` as a generated artifact** (§3.2) — medium. Adds `[harness.pi.models]` config,
   renders at boot, and lands the four requested SKUs (kimi-k3 plain / kimi-k3@modal-mxfp4 /
   kimi-k3@moonshot-mxfp4 / grok-4.5 / glm-5.2). `beckett doctor` verifies.
4. **Advisor agent** (§5) — small; registry-only, no restart.
5. **Chat seat → Sonnet 5 medium** (§5) — two config values. *After* 4 is verified in use.
6. **`src/route/` seat router** (§4) — the large one. Split it: (a) seat model + account state +
   OpenRouter credits poll; (b) `pickSeat` as a pure function with fixtures; (c) wire into
   `castFor`; (d) wire into classed-failure recovery; (e) the explainability line.
7. **Cast-time model validation** (§3.5) and the §3.6 config cleanup — small, do them whenever.
8. **pi extensions** — see `docs/pi/README.md`. `p-mcp-bridge` first (it is the only blocker on
   a lane); `p-scope-guard` next (it is the only real containment gap).

Items 1, 2, 4, 5, 7 are a single afternoon between them. Item 6 is the real project.
