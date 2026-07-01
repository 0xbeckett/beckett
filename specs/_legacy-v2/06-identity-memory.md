# Beckett — Spec 06: Identity & Memory

> **SUPERSEDED:** This v2 design spec describes the retired parent/MCP/watcher architecture. Current build agents should start with [`docs/V3.md`](../../docs/V3.md).


> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> Beckett's own identity + agency gates + delivery handshakes, and its markdown knowledge-graph
> memory. Both modules are **already implemented** and salvaged as-is (`src/agency/index.ts`,
> `src/memory/index.ts`); this spec is the doctrine the parent follows when using them through
> the CLIs ([Spec 05](./05-tools-mcp.md)). Honors [Spec 00 §5](./00-overview.md).

---

## 1. Identity & Agency

### 1.1 One identity, signed on every outward action
A single `Identity` loaded once at boot from `~/.beckett/.env` + config: its **own** GitHub
account (`beckett-bot`), Gmail account, Discord bot user, and OS user `beckett`. Everything
outward is *signed as Beckett* and funnels through one choke point — the agency gate — so the
policy can't be bypassed. Tokens are least-privilege so they **can't do what the gate forbids**
(enforcement floor under the policy).

### 1.2 Action classes (the policy, fail-closed)
`classifyAction(type, ctx)` is pure, total, and **defaults unknown actions to ALWAYS_ASK**.

| Class | Meaning | Examples | Behavior |
|---|---|---|---|
| **FREE** | reversible / internal | branch, commit, PR open/update, comment, read/label/draft email, spawn task | just do it, no gate |
| **HANDSHAKE_GATED** | the expected irreversible finish line | merge to main, send email, force-push own `beckett/*` branch w/ open PR | ask **once**, await go/decline/variant |
| **ALWAYS_ASK** | destructive / out-of-remit | force-push shared branch, repo/account admin, permanent delete, deploy/publish/money, task-spawn from untrusted email | never unattended; explicit instruction required |

The classification table *is* the policy. Three classes exhaust all actions; class is a property
of the action type, not a per-task setting.

### 1.3 GitHub agency
`@beckett-bot` is Beckett's own collaborator account with a fine-grained PAT (Contents RW, PRs
RW, Issues RW, Metadata RO — no admin/workflow/org). One PAT drives two layers: **git transport**
(credential helper, commits authored as `beckett-bot`) and **API** (`gh` CLI + REST fallback via
`GH_TOKEN`). **Namespace discipline:** pushes only to `beckett/*` branches; never main/release/
others'. The PR is the integration handoff — Beckett proposes (FREE), **merge is the handshake**.

### 1.4 The delivery handshake (`PendingAction`)
The universal machine for an irreversible step, also used for self-halt ([Spec 02 §6](./02-doctrine.md)):
```ts
interface PendingAction {
  id; taskId; userId; type;           // ActionType
  ctx;                                // everything needed to reconstruct + execute, for restart
  handshake: { prompt; grammar };     // "PR's up — review or merge?" + go/decline/variant
  status; createdAt; expiresAt; resolution?;
}
```
- **Created at the finish line** (merge point, send point, self-halt) with all state in `(type,
  ctx)` so it survives a restart (the execute thunk is rehydrated from `ctx`, no closure state).
- **Surfaced to Discord** by the parent via `discord_reply`; the human's reply resolves it.
- **Timeout never auto-fires** (fail-safe): an unanswered merge leaves the PR open, an unanswered
  send leaves the draft. The task is still **DELIVERED** with the action undone (honest terminal
  state, not a failure). A **variant** answer ("merge to develop instead", "send but cc Sam")
  triggers a re-plan + new `PendingAction`.

### 1.5 Gmail agency
Beckett's own account. Read-side is FREE: poll incrementally (~5m), classify (parent), label,
triage, **draft**. Task-spawn from a known sender is FREE; external/unknown senders are
quarantined (anti prompt-injection). **Send is HANDSHAKE_GATED** ("drafted it — send as me, or
you handle it?"). Auth via OAuth refresh token (`GMAIL_OAUTH_*`, zero-reauth) or app-password
fallback; scopes limited to readonly + labels + compose + send (no delete, no account settings).

### 1.6 Secrets
All in `~/.beckett/.env` (mode 600, never committed, redacted in logs). Subscriptions
(`claude`/`codex` logins) live in `~/.claude`/`~/.codex` — **no** `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`. Zero-reauth = long-lived refresh tokens + fs-persisted harness logins.

---

## 2. Memory — the knowledge graph

### 2.1 Format & location
`~/.beckett/memory/` is its own git repo with type subdirs (`people/`, `projects/`, `env/`,
`prefs/`, `workers/`, `reference/`, `decision/`). Each fact is one markdown file:
- **Frontmatter (canonical):** required `name` (kebab-case, globally unique = the node id),
  `description` (one declarative sentence — recall's match surface), `metadata.type`; plus
  `metadata.{created, updated, source, confidence, ttl?}` and type-specific fields (e.g. `person`
  → `emails[], role, aliases[]`; `project` → `status, repo?, owners[[]], channels[], deadline?`;
  `worker-note` → `harness, model, task_type, derived_from, n_samples`).
- **Body:** free prose; `[[kebab-name]]` is a directed edge (forward-refs allowed = phantom
  nodes, upgraded in place when the file is written). A generated `## Backlinks` materializes
  inbound edges.
- **Index:** `MEMORY.md` — one line per fact, regenerated on every write (deterministic sort →
  clean diffs); never hand-edited; always loaded into the parent.

### 2.2 Recall (read) — 3-tier, cheap-first
1. Always inject the `MEMORY.md` index. 2. Score index lines (description + name/aliases) against
the task; fetch top-K full bodies (lexical in v1, embeddings later). 3. One-hop graph expansion
across `[[wikilinks]]` (pull direct out-edges + high-value in-edges like `owners`/`members`).
Returns whole nodes (never truncated); prompt budgeting is the parent's. So "email
[[marketing-team]] that [[project-anaconda]] shipped" resolves both entities + their properties.

### 2.3 Remember (write) — dedup-checked, anti-bloat
Before any create: check exact name/alias, phantom upgrade, and high-similarity description (same
type) → coerce to update (no `marketing-team` / `the-marketing-team` dupes); borderline → flag,
don't auto-merge. **Anti-bloat:** never store what the repo (code), event log (ephemera), or
SQLite (raw gate metrics) already hold — only durable cross-task world facts. Write is atomic
(`tmp`+`rename`) under a mutex, then patch graph + regen backlinks + regen index + mirror to
SQLite + quiet `git commit`. fs.watch handles out-of-band edits (git pull / manual).

### 2.4 The learned-worker model (design-for, build-later)
Raw `(harness, model, task_type) → {passed, retries, drift_events, turns}` is logged to SQLite at
every gate **from day one** ([Spec 03 review](./03-skills.md)). Once a bucket has ≥ MIN_SAMPLES,
a low-priority job distills the stats into a `worker-note` markdown narrative ("Codex
over-engineers data-layer nodes — 12/40 review flags; prefer Claude or constrain"). The `staff`
skill pulls these via `recall`. No narrative until enough samples (no noise); the static
capability guidance stands alone until then.

### 2.5 Environment self-knowledge
`type: env` nodes (host, tools, project inventory, accounts) are kept fresh by a startup +
periodic read-only scanner (`uname`, tool `--version`, `ls ~/projects`, `git remote`) that diffs
and proposes updates through the normal `remember` path. Secrets never go in memory — env account
nodes hold identifiers, not credentials.

---

## 3. Cross-references
- The CLIs that expose all of this (`beckett gh/gmail/memory`) → [Spec 05](./05-tools-mcp.md)
- When the parent recalls/remembers/handshakes (skills) → [Spec 03](./03-skills.md)
- Self-halt (same handshake machine) → [Spec 02 §6](./02-doctrine.md)
- Identity/Gmail/PAT setup steps → [Spec 07](./07-roadmap.md)
