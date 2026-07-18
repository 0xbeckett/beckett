---
name: claude-model-casting
description: "How to cast Claude models per stage — Sonnet vs Opus vs Fable, effort tiers, Fable confirm rule"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5579f9f9-52be-42da-828d-fa27f13c801d
---

Jason's guidance on casting Claude models in tickets:

- **Sonnet 5** at **medium/high (never xhigh)** — good for very specific, single-task specs.
- **Opus** at **high/xhigh** — good for longer runs.
- **Fable** — review ONLY, and only to review *massive* tasks and *really complex / critical* work. Before deploying a ticket that casts Fable, **ask Jason to confirm first** (do not fully file/start it silently).

**Why:** each Claude tier has a sweet spot — Sonnet is sharp on tight specs but xhigh is wasted on it; Opus earns its cost on long/gnarly runs; Fable is the heavy reviewer reserved for the rare huge/critical review.

**How to apply:** when I pick a `--cast`, match the model+effort to the work per this rule. Never cast Sonnet at xhigh. If I reach for Fable (always a `review` cast, only on massive/critical work), stop and confirm with Jason before deploying the ticket. Relates to [[review-default-sonnet]].