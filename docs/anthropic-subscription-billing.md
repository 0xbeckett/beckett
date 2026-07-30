# Why Anthropic usage is landing in extra usage

Investigated **2026-07-29** against pi 0.82.1 and the live spend ledger
(`~/.beckett/spend.jsonl`). The question: Claude Code has started billing extra usage instead of the
subscription, and pi was suspected.

## Answer, short

Two claims, both evidenced below:

1. **The OAuth token does pull from the subscription — your understanding is correct, and pi honors
   it.** pi's Anthropic path with an `sk-ant-oat01…` token sends Bearer auth plus the Claude Code
   identity headers. It is not on API billing.
2. **pi is not what drained it, and the drain is not a routing mistake.** Over the last 14 days the
   Claude seats consumed **2.11 billion billable input units across 22,687 turns** — every one of
   them on the `claude` harness, not pi. That is far past any subscription tier's included
   allowance, so once the allowance is gone, everything after it is extra usage. The subscription
   isn't being bypassed; it's being exhausted, continuously.

## Evidence 1 — pi's Anthropic requests are subscription requests

`pi-ai/dist/api/anthropic-messages.js:664-679`. When the resolved credential is an OAuth token, pi
builds the client as:

```js
const client = new Anthropic({
  apiKey: null,                 // NOT x-api-key — no API-credit path
  authToken: apiKey,            // → Authorization: Bearer sk-ant-oat01…
  defaultHeaders: {
    "anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
    "user-agent": `claude-cli/${claudeCodeVersion}`,
    "x-app": "cli",
  },
});
```

That is byte-for-byte the shape of a Claude Code subscription request: Bearer auth, the
`oauth-2025-04-20` and `claude-code-20250219` betas, and the `claude-cli` user agent. The API-key
branch (`:681-694`, `apiKey` set / `authToken: null`) is a *different* branch that this token never
reaches.

The env side agrees: the token is present as `ANTHROPIC_OAUTH_TOKEN` (108 chars, `sk-ant-oat01…`),
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset, and `src/env.ts:24-31` strips both of
those prefixes from every harness child while explicitly allowlisting the OAuth one. There is no
configured path by which a Beckett child could reach API billing even if it wanted to.

So pi is exonerated on mechanism.

## Evidence 2 — the volume, and where it comes from

14 days of `~/.beckett/spend.jsonl`, grouped by seat. `$` is the API-equivalent price from
`config/model-rates.json` (cache multipliers applied); `tok in` is `input + cacheRead + cacheCreate`
(`src/dispatch/dispatcher.ts:2875`), so it is billable input *units*, most of which are cache reads:

| harness / model | runs | turns | tok in | $ equiv |
|---|---|---|---|---|
| `claude` / claude-opus-4-8 | 193 | 10,893 | 963,885,350 | 866.19 |
| `claude` / claude-opus-5 | 49 | 3,779 | 473,586,866 | 387.16 |
| `claude` / claude-sonnet-5 | 170 | 6,929 | 549,133,450 | 324.91 |
| `claude` / claude-fable-5 | 24 | 1,086 | 127,188,488 | 214.72 |
| `pi` / gpt-5.6-terra | 176 | 2,919 | 193,405,149 | 118.32 |
| **Anthropic-subscription total** | **436** | **22,687** | **2,113,794,154** | **1,792.98** |

Read the harness column. **Every Claude-seat run went through the `claude` harness.** pi's entire
14-day footprint is one row — `gpt-5.6-terra` on the ChatGPT/Codex account, which never touches
Anthropic at all. pi has consumed **zero** of the Anthropic subscription in this window.

Two further notes on the number:

- **It undercounts.** The spend ledger records *ticket stages only*. The concierge chat seat
  (Opus 5, one long-lived session per Discord channel, `rotate_at_tokens` 160k) is not in it, and
  neither are the quick / browser / dream lanes. The real subscription draw is higher than 2.11B.
- **93,172 billable input units per turn, averaged over 22,687 turns.** That is the actual driver.
  It is a context-size problem, not a request-count problem.

## What this means

The subscription includes an allowance; past it, extra usage takes over. At this volume the
allowance is gone almost immediately and stays gone, so from the outside it looks like the
subscription is being bypassed. It isn't — it is saturated, and Claude Code's interactive turns are
queueing behind a fleet that shares the same account. This is precisely the failure the
[seat router](pi-harness-review.md#4-load-balancing-the-design) is meant to prevent: `claude/*` and
`pi/anthropic/*` are one budget, and nothing in Beckett currently knows that.

## Three things worth doing about it

**1. The single biggest line is a stale default nobody chose.** `claude/claude-opus-4-8` is
**$866 — 45% of all fleet spend** — across 191 `implement` runs. It is not a cast anyone wrote:
`~/.beckett/config.toml` pins `harness.claude.default_model = "claude-opus-4-8"` under a comment
block describing a Sonnet 4.6 / Opus 4.8 routing scheme that predates the Claude 5 family. The
operating doctrine says the implement default is Opus 5 on `pi`/`anthropic`; the config says
otherwise and the config wins. Whether Opus 4.8 is still wanted is a real decision — but right now
it is the fleet's largest cost and it is there by drift. (See `pi-harness-review.md` §3.6.)

**2. Move volume off the Anthropic account entirely.** This is what the OpenRouter work buys, and
the numbers are not marginal. `z-ai/glm-5.2` is $0.68/$2.13 per Mtok against Opus's $5/$25 — a
**7×** input and **12×** output difference — on a separate, metered budget with a real balance API.
Mechanical grind and bulk reads have no business on the subscription seat. All three requested
OpenRouter models are verified working through pi today and castable with no code change.

**3. Attack the 93k-units-per-turn number, because it is the multiplier on everything.** Two
concrete, already-diagnosed contributors:
   - the concierge doctrine has grown to **56KB / ~14k tokens**, 3× its last audited size, plus five
     newer per-launch blocks — and every session launch, rotation and recycle re-pays it at full
     price, multiplied by per-channel session scope
     (`docs/reviews/cohesion-audit-kimi-k3.md` finding 7);
   - worker orientation is grep-shaped, so exploration is re-sent every turn until compaction
     (`docs/pi/p-semantic-index.md`).

Ordering note: (1) is a one-line config decision, (2) is a cast/config change, (3) is real work.
Do them in that order.

## What was ruled out

- **pi using API billing.** Disproven at the header level — see Evidence 1.
- **A leaked `ANTHROPIC_API_KEY` in a child env.** Unset in the daemon env, and prefix-stripped by
  `src/env.ts` regardless.
- **`ANTHROPIC_BASE_URL` redirecting to a metered proxy.** Unset, and also prefix-stripped.
- **pi as the volume source.** $118 of $1,911, all of it on the ChatGPT/Codex account.
