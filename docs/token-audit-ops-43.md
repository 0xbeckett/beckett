# OPS-43 Token Audit — the no-skill-load path

**Question (Jason):** when a Concierge turn does NOT invoke any skill, what still gets
injected into context just to keep skills *available*, and are we paying a fat fixed cost
on every plain-chat turn?

**Verdict up front:** No. The fixed "skills are available" tax is **~905 tokens** of skill
descriptions per turn, and because the Concierge is one persistent `claude -p` session with
prompt caching, that prefix is a **cache read** (~0.1x price) on every warm turn, not a
re-processed cost. **MCP schemas and deferred-tool lists cost 0** — the daemon has no MCP
servers configured. This is not meaningful waste. No behavior change recommended. Details and
the one real risk (adding MCP servers to the daemon) below.

---

## What a no-skill turn actually carries

The Concierge is a long-lived `claude -p --input-format stream-json` Opus process
(`src/concierge/index.ts`, class `ConciergeSession`). It is the full `claude` CLI harness, so
the harness — not Beckett's code — auto-loads skills/tools. A plain-chat turn's fixed prefix:

| Chunk | ~Tokens | Cached? | Where it's injected |
|---|---:|---|---|
| **Skill descriptions** (16 project skills, name + `description` frontmatter only) | **~905** | yes (prefix) | Harness auto-discovers `.claude/skills/*/SKILL.md` in the process **cwd**. Beckett sets that cwd to the repo root at `src/concierge/index.ts:173` (`this.cwd = opts.cwd ?? defaultRepoRoot()`, `defaultRepoRoot()` at :890) and spawns with `cwd: this.cwd` at :259–266. No skill-gating flag is passed (`buildArgs`, :283–310). |
| **MCP tool schemas** | **0** | — | Would arrive via `--mcp-config` (`src/drivers/claude.ts:463`), but the Concierge's `buildArgs` **never passes `--mcp-config`**, and the daemon's `~/.claude.json` has empty `mcpServers` globally **and** for the beckett project, plus empty `enabledMcpjsonServers`. Zero MCP servers → zero schemas. |
| **Deferred-tool lists** | **0** | — | The harness only emits a deferred-tool/tool-search list when there are many (MCP) tools. With no MCP servers there are no deferred tools. |
| **`concierge.md` doctrine** | ~4,665 | yes (prefix) | `composeSystemPrompt()` :573 → `readDoctrine()` :922, appended via `--append-system-prompt` in `buildArgs` :301–304. Deliberate operating doctrine, **not** skill-availability cost. |
| **`persona.md`** | ~150–300 | yes (prefix) | Same `composeSystemPrompt()` path (:573–578). Also deliberate. |
| Base harness system prompt + built-in tool schemas (Bash/Read/Edit/…) | irreducible | yes (prefix) | Injected by the `claude` binary itself; unavoidable for any harness turn. |

### How the ~905 was measured

Only the frontmatter `name` + `description` of each `SKILL.md` is injected per turn (the body
loads lazily only when the skill is invoked). Summed across the 16 project skills:

```
sum(name + description) = 3,619 chars ≈ 905 tokens (chars/4)
```

Range per skill: `supervise` 159 chars → `site` 299 chars. Full breakdown reproducible via the
frontmatter extraction over `.claude/skills/*/SKILL.md`.

Sanity check on the surroundings: `concierge.md` is 18,660 chars ≈ 4,665 tokens. So the skill
list is only **~16%** the size of the doctrine we already inject on purpose, and a small slice
of the total cached prefix.

---

## Is it meaningful waste? Put a number on it.

**No — ~905 tokens, cached, is not meaningful.**

- The Concierge is **one persistent session**, not a fresh spawn per message. The system
  prompt + doctrine + skill list + built-in tool schemas sit at the front of the context and
  are written to the prompt cache once, then served as `cache_read_input_tokens` on every
  subsequent turn (see the usage accounting in `contextTokensFromUsage`,
  `src/concierge/index.ts:100`, which already knows the mass lives in `cache_read`).
- Marginal cost of the skill list on a **warm** turn: ~905 tokens at Opus cache-read (~0.1x of
  input) ≈ **$0.0014/turn**. It is only paid at full price on a cold start or after a >5-min
  cache gap (then it reappears as `cache_creation`), and even then it's ~$0.014 once.
- Idle auto-compaction rotates the session at `rotate_at_tokens` (default 160k,
  `:81`), which re-primes the cache — but that's amortized across ~hundreds of turns.

So the "just to have skills available" tax is a fraction of a cent per turn on the hot path.
Lazy-loading or gating it would save ~905 cache-read tokens per turn while adding complexity
and a first-use latency hit on the turn a skill *is* needed — a bad trade.

---

## The one real risk (worth flagging, not fixing now)

The reason this audit reads "fine" is entirely that **no MCP servers are attached to the
daemon.** For comparison: the interactive session that wrote this audit had claude.ai
connectors enabled (Figma, Gmail, Notion, Drive, Calendar, PubMed, …) and that dumped **100+
MCP tool schemas + per-server instruction blocks** into context — easily **tens of thousands of
tokens** of fixed prefix, plus the deferred-tool list machinery. That is the failure mode Jason
is worried about, and Beckett's daemon simply isn't in it today.

**Guardrail recommendation (cheap, no behavior change to chat):** if we ever add MCP servers to
the daemon's config, attach them to the *worker* driver (which already supports `--mcp-config`,
`src/drivers/claude.ts:463`) scoped per-ticket, and **keep the Concierge session MCP-free** so
plain chat never pays that tax. The Concierge's `buildArgs` deliberately omits `--mcp-config`
today; a one-line comment there stating "MCP stays off the chat session on purpose" would lock
in the property. (Left as a proposed follow-up, per the read-only-first ask.)

---

## Recommendation

**It's fine — leave it.** Concrete reasons:

1. Skill descriptions cost ~905 tokens, served from cache at ~0.1x on every warm turn.
2. MCP schemas and deferred-tool lists cost 0 (no servers configured).
3. Lazy-loading skills would trade a fraction-of-a-cent saving for complexity + first-use
   latency, and defeats the point of having skills discoverable.

**Optional follow-ups (do not block this ticket):**

- Add the "Concierge session stays MCP-free" guard comment in
  `src/concierge/index.ts` `buildArgs`, so a future MCP integration doesn't silently balloon
  the chat prefix.
- If we ever want to trim the *real* fixed cost, the lever is `concierge.md` (~4,665 tokens),
  not the skill list — but that's doctrine, tune it for correctness, not token count.

*Read-only investigation; no runtime behavior changed by this ticket.*
