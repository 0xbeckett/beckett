# Beckett — Spec 00: Overview & Canon (v2)

> **SUPERSEDED:** This v2 design spec describes the retired parent/MCP/watcher architecture. Current build agents should start with [`docs/V3.md`](../../docs/V3.md).


> **Anchor document.** Defines the vision, vocabulary, and canonical decisions. If a deeper
> spec contradicts this file, this file wins (or this file is wrong and we fix it *here* first).
>
> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> Supersedes the v0.1 spec set (archived in [`_legacy/`](../_legacy/)). v2 is a re-architecture,
> not a tweak: Beckett stops being a hand-coded orchestration engine and *becomes an agent*.

---

## 1. What Beckett is

**Beckett is an agentic coworker you reach in Discord.** You `@beckett` a task in whatever
channel you're in; it goes off, does the whole thing, and comes back like a colleague would —
sparingly, in its own voice, owning its decisions. Code is its primary expertise, but it's
general: it carries a memory of your people, projects, and environment.

Its defining trait is **agency**: its own home on a machine, its own GitHub/Gmail/Discord
identity, a memory it accumulates, and **discretion over how it spends resources**. It works
best when it can just *do the thing* and surface only what you need to know.

## 2. The v2 inversion: agent, not engine

The v0.1 design hand-coded the reasoning loop — a state-machine orchestrator that called an LLM
for individual decisions (`plan`, `gate`, `drift-read`) and wired the results together in
TypeScript. That was ~16.5k lines reimplementing what a coding agent already does natively.

**v2 inverts it. Beckett *is* a long-lived `claude -p` agent — the *parent*.** It reasons
through the work itself. The control logic lives in the model's head, guided by:

- **Skills** — an on-demand playbook (how to plan, staff, supervise, review, deliver, recall).
  Reached for when the chosen path needs them; *not* a fixed pipeline.
- **Hooks** — deterministic guardrails + compact telemetry on the child workers it spawns.
- **Tools** — a small MCP surface (`beckett-control`) to spawn / observe / steer child agents,
  plus CLIs for memory and identity.

Children are *other agents* it delegates to: `claude -p`, `codex exec`, or `pi`. The parent
**observes children by reading the compact event logs the hooks emit + child session JSONL** —
it never streams raw logs into its own context; it wakes on signals and pulls digests.

> **The spine is unchanged conceptually** — Beckett is still "a harness over harnesses," and
> the atomic unit is still:
> **a worker = a harness instance + a scoped task + an isolated workspace + a resource
> envelope + acceptance criteria.**
> What changed is *who runs the loop*: the agent, not a TypeScript state machine.

## 3. Dynamic effort — the organizing principle

The v0.1 loop (intake → plan → staff → dispatch → supervise → integrate → review → deliver)
was designed for **large** tasks and applied to **all** of them. That is the bloat, restated.

In v2 the loop is **dynamic**. Beckett judges each task and brings the **minimum sufficient
machinery**:

| Task size | Path Beckett takes |
|---|---|
| **Trivial** (a question, a one-line fact, a quick read) | Answer/do it **inline**. No worker. |
| **Medium** (a contained change, one file/module, a bug fix) | Spin off **one worker** in a worktree, light review, deliver. |
| **Large** (multi-module, parallelizable, architecture-critical) | Escalate to the **full heavy path**: plan a DAG, staff it, fan out workers, integrate, adversarial review, gate, deliver. |

The heavy path is a **pattern available on demand**, not a gate every task passes through.
**Discretion over resources is the point**: Beckett decides how much to spend, scaling effort
to difficulty — and can say "this is bigger than it looks, I'm bringing in more" or "this is
trivial, here you go."

## 4. The four pillars of "self"

Design north stars; every feature should strengthen at least one.

1. **Discretion over resources.** Beckett decides path, worker count, harness, model tier,
   effort — and whether a piece of work is even worth doing. Agency *is* discretion.
2. **A persistent home + earned knowledge.** Beckett lives at `/home/beckett/` on `loom-desk`
   and accrues a **knowledge graph** of linked markdown (people, projects, env, and a learned
   model of its own workers). Earned through experience, which makes it genuinely Beckett's.
3. **Standing to push back.** Beckett can say "this spec contradicts itself" or "I'd decompose
   this differently," and can refuse to staff a bad plan. Clarify is standing, not politeness.
4. **Self-governance.** Beckett can halt *itself*, not just its workers. Knowing when to stop
   is what separates an agent with a viewpoint from a runaway loop.

And it **reports in the first person and owns its decisions**: "I aborted worker 3 because it
was rewriting auth it didn't own; I re-scoped and re-dispatched."

## 5. Canonical decisions (the ledger)

Single source of truth. Changed-from-v0.1 rows are marked **▲**.

| # | Decision |
|---|---|
| **Runtime** | A thin **bun shell** + a long-lived **`claude -p` parent agent**, on **`loom-desk`** (Ubuntu 24.04, 8c/31GB, Tailscale). ▲ (was: monolithic bun daemon owning the loop) |
| **Control** | ▲ The parent **agent** runs the loop via reasoning + **Skills**. No hand-coded state machine/orchestrator. |
| **Effort** | ▲ **Dynamic**: inline / one-worker / heavy-path DAG, chosen per task. Heavy path is on-demand, not mandatory. |
| **Worker layer** | ▲ **Hybrid**: salvaged **Claude driver** is the steerable primary (live stream-json nudge); **sandcastle** spawns codex/pi workers + provides Docker/Vercel sandboxes + branch-merge. |
| **Observation** | ▲ Workers emit compact telemetry via **hooks**; a shell **watcher** digests logs into smoke-alarms; the parent **wakes on signals** and pulls digests via tools — never streams raw logs. |
| **Steering** | Claude worker nudge = stream-json user msg at next turn boundary; abort = kill + `--resume`. Codex/pi (via sandcastle) nudge = checkpoint + resume between runs. |
| **Economics** | **No dollar budget** — runs on subscriptions. Scarce = rate limits + wall-clock + attention. "Budget" = scope/resources Beckett proposes. |
| **Rate limits** | Failover to the other harness; else queue + backoff; notify only if blocked a long time. |
| **Workspace** | **Git worktree per worker** (branch each). Integrate = git merge (sandcastle branch-merge for its workers). Containers via sandcastle when isolation is needed. |
| **Scope enforcement** | Worktree + PreToolUse **scope-guard hook** denies writes outside owned globs (Claude); OS sandbox for codex/sandcastle workers. |
| **Skills** | The playbook (intake, plan, staff, supervise, review, deliver, recall, remember) as markdown skills the parent loads. |
| **Tools** | `beckett-control` MCP server: `spawn_worker`, `worker_status`, `read_worker_log`, `nudge_worker`, `abort_worker`, `integrate`, `discord_reply`. Memory + identity via CLIs. |
| **Discord** | **Ambient, no threads.** `@beckett` in any channel → replies in that same channel. Sparseness is law. Management off Discord. |
| **Persistence** | ▲ **Session JSONL + hook event logs are the primary audit trail.** SQLite slimmed to outcome logging (learned model) + handshake/pending-action durability. |
| **Criteria** | Per worker/node: **executable checks** (exit codes) + **NL criteria**. Mandatory for non-trivial work — no node without a "done." |
| **Review** | **Tiered**: self for simple, **fresh adversarial reviewer** for critical, cross-provider/panel for the most critical. Gate = checks pass AND review pass. |
| **Retry/escalate** | **≤3** re-dispatch cycles per node → escalate with options. Never silent. |
| **Clarify bias** | **Proceed on reversible** (report assumptions at delivery), **ask once on irreversible**. Never ask about things it can just try. |
| **Identity** | Beckett's **own GitHub + Gmail + Discord bot + OS user `beckett`** from day one. |
| **Agency boundary** | Reversible work free (branch, PR, draft); outbound/irreversible via **delivery handshake** ("review or merge?" / "send as me?"). Fail-closed: unknown action → ALWAYS_ASK. |
| **Memory** | **Knowledge graph** of linked markdown (`~/.beckett/memory/`, frontmatter + `[[wikilinks]]` + index). People, projects, env, learned-worker narratives. |
| **Persona** | Chill, quippy, young, energetic-but-relaxed. `~/.beckett/persona.md` → parent's CLAUDE.md. User-facing voice only; internal/worker prompts businesslike. |
| **Learned model** | **Design-for, build-later**: static capability guidance now + **log every gate outcome** to SQLite from day one. |
| **Secrets** | `~/.beckett/.env` (mode 600). Subscriptions in `~/.claude`/`~/.codex`. Goal = zero re-auth. |
| **Multiplayer** | **Design-for, build-later**: single-user v1, `user_id` on every task/message. |

## 6. Filesystem & host layout (loom-desk)

```
loom-desk (Ubuntu 24.04, user: beckett)
~/.beckett/
  config.toml            # tunables (concurrency, retry N, drift K, model routing, paths)
  .env                   # secrets: DISCORD_TOKEN, GITHUB_PAT, GMAIL_*, …
  persona.md             # Beckett's voice (→ parent CLAUDE.md)
  memory/                # knowledge graph (its own git repo)
    MEMORY.md            # index (one line per fact)
    {people,projects,env,prefs,workers,reference,decision}/*.md
  beckett.db             # SQLite: gate outcomes, pending actions, users (slim)
  workers/<id>/          # per-worker compact telemetry from hooks
    events.jsonl · status.json
  parent/                # parent session id + resume state
  logs/                  # shell + watcher logs
/home/beckett/projects/<project>/      # a git repo Beckett works in
  .beckett/worktrees/<worker>/         # per-worker worktree (branch each)
~/.claude, ~/.codex                    # harness auth (one-time login; back up)
```

The repo itself is a **Claude Code agent project**: `.claude/skills/`, `.claude/hooks/`,
`CLAUDE.md` (parent doctrine + persona), `src/` (the bun shell + MCP server + salvaged libs).

## 7. Glossary

- **Parent** — the long-lived `claude -p` agent that *is* Beckett's brain + orchestrator.
- **Shell** — the thin bun process: Discord pump, parent-session supervisor, log watcher.
- **Worker** — a child agent (`claude -p` / `codex exec` / `pi`) running a scoped task in its
  own worktree under an envelope + criteria. The atomic unit.
- **Path** — the amount of machinery Beckett chooses: inline / one-worker / heavy-path DAG.
- **Skill** — a markdown playbook the parent loads on demand (e.g. `plan`, `review`).
- **Hook** — a deterministic script on a worker (PreToolUse scope-guard; PostToolUse telemetry).
- **Digest / status** — the compact worker state the parent reads instead of raw logs.
- **Smoke-alarm** — a cheap mechanical drift signal the watcher computes; a prompt to *look*.
- **Check-in** — a self-scheduled future look the parent arms on a worker.
- **Nudge** — a soft steering message to a running worker (live for Claude; resume-based else).
- **Gate** — the pass/fail decision against acceptance criteria (checks AND review).
- **Delivery handshake** — the one crisp question at the irreversible finish line (merge/send).

## 8. Document map

| Spec | Title | Covers |
|---|---|---|
| 00 | **Overview & Canon** (this) | Vision, the inversion, dynamic effort, pillars, ledger, layout, glossary |
| 01 | [Runtime](./01-runtime.md) | The bun shell, parent lifecycle/resume, process model, config, startup/recovery |
| 02 | [Doctrine](./02-doctrine.md) | How the parent judges effort & picks a path; the heavy-path pattern; escalation |
| 03 | [Skills](./03-skills.md) | The playbook: each skill's purpose, inputs, outputs, formats |
| 04 | [Workers & Hooks](./04-workers-and-hooks.md) | Worker spawn (driver vs sandcastle), worktree, hooks, supervise/control |
| 05 | [Tools & MCP](./05-tools-mcp.md) | The `beckett-control` tool contract + memory/identity CLIs |
| 06 | [Identity & Memory](./06-identity-memory.md) | Agency (gh/gmail), action-class gates, handshakes; the memory KG |
| 07 | [Roadmap & Setup](./07-roadmap.md) | v2 build order, loom-desk setup, verify-first risks |

Deep research & harness wire-formats live in [`../my-docs/`](../my-docs/). The v0.1 spec set is
preserved in [`_legacy/`](../_legacy/) — its formats (criteria, review verdict, action classes,
memory schema, smoke-alarm thresholds) are still canonical and carried forward here.
