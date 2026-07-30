# `p-subagent` — fan-out inside a pi worker

**Priority 7.** The biggest capability jump and the easiest one to get wrong. Build it last, and
only after the ceilings in `p-turn-budget` exist.

## Problem

pi has no sub-agents by design ("intentionally does not include … sub-agents", pi
`docs/usage.md`). Beckett's fan-out today happens at the *dispatcher* level: a plan becomes N
tickets, each with its own worker, worktree and lifecycle. That is the right granularity for
work a human wants to review separately, and the wrong granularity for the many small
independent sub-questions inside one ticket — "check each of these nine lane files", "read these
five modules and tell me which owns X", "verify this claim three different ways."

Those get done serially inside one expensive worker, or not at all. The known failure pattern is
the same one recorded repeatedly: a ticket that sweeps the whole codebase crash-loops its worker,
and the workaround is to split it by hand into per-area tickets. Fan-out inside the worker is the
mechanism that makes the split unnecessary.

## Mechanism

pi exposes the pieces: `ctx.newSession(options?)` creates a session, `pi.sendMessage(...)` drives
it, `ctx.waitForIdle()` synchronises. So a `spawn_subagent` tool is buildable. But the naive
version — a tool that spawns whatever the model asks for — is a token bomb and a recursion hazard.

Constraints that are not optional:

1. **Fixed cheap seat.** Sub-agents run on a configured cheap model (`z-ai/glm-5.2`,
   `gpt-5.6-luna`), never the parent's seat, and never a model the parent chooses. The economics
   only work if the sub-runs are an order of magnitude cheaper; letting the model pick means it
   picks the good one.
2. **Depth 1. Hard.** A sub-agent does not get the `spawn_subagent` tool. Enforce structurally
   (don't register it in the child), not by prompt.
3. **A fan-out ceiling** — max concurrent (small: 3–4) and max total per parent run. Both from
   flags Beckett passes, both counted in the extension.
4. **Budget flows through.** Sub-agent spend counts against the parent's `--max-usd` from
   `p-turn-budget`. This is why that extension is a prerequisite: fan-out without a shared
   ceiling turns one $2 ticket into a $60 one, and the $40 cap won't catch it because nothing
   aggregates.
5. **Read-mostly by default.** Sub-agents get a narrowed toolset (`pi.setActiveTools`) — read,
   grep, find, ls. A sub-agent that writes files means N concurrent writers in one worktree,
   which is a corrupted tree, not parallelism. Writing sub-agents need worktree isolation, which
   is a much bigger piece of work; declare it out of scope.
6. **Structured returns.** The tool returns the sub-agent's final text; the *prompt* should
   demand a compact structured answer. The parent must not receive nine full transcripts — the
   entire point is that the parent pays for conclusions, not for exploration.

Tool shape:

```
spawn_subagents(tasks: Array<{label: string, prompt: string}>)
  → Array<{label: string, result: string, ok: boolean, usd: number}>
```

Batch, not single. A batch call makes concurrency the extension's business rather than the
model's, and makes the ceiling enforceable in one place. A failed sub-agent returns
`ok: false` with its reason and does **not** fail the batch — one dead sub-run should not lose
the other eight results.

## What this unlocks

This is the actual "special things as an orchestrator" capability. Concretely:

- **Per-area sweeps in one ticket** instead of N tickets and a hand-split.
- **Adversarial verification**: a claim gets checked by three independent sub-runs with different
  framings before the worker commits to it. Cheap, and it is the single best defence against the
  confident-wrong finding.
- **Wide reads on a budget**: nine files read by nine cheap sub-agents returning nine summaries
  costs a fraction of one expensive model reading all nine.

## Verification

1. A fixture parent fans out 4 read-only sub-agents and receives 4 structured results; assert
   total cost is within the expected multiple of a single run's.
2. Depth enforcement: a sub-agent's prompt explicitly asking to spawn cannot, because the tool
   isn't registered. Assert on its toolset.
3. Ceiling enforcement: a parent asking for 20 sub-agents gets the configured max and a clear
   note about what was dropped — never a silent truncation.
4. One deliberately failing sub-agent does not lose the others' results.
5. Parent `--max-usd` accounts for sub-agent spend — assert the aggregate.

## Failure modes

- **Cost blowup.** The prerequisite ceiling exists for this. Do not ship without it.
- **Context flood.** Sub-agent output must be summarised by contract. Consider a hard character
  cap per result with an explicit truncation marker.
- **Silent partial results.** If a sub-agent is dropped for any reason, the parent must be told,
  in the tool result. A fan-out that quietly covers 6 of 9 files while reading as complete is
  worse than a serial sweep.
- **Concurrency in one worktree.** Read-only default, and be explicit that write-capable
  sub-agents are a separate project.

## Size

**L.** And it is the one where a mediocre implementation is actively harmful — an unbounded,
write-capable, depth-unlimited fan-out would be the most expensive bug in the system. Build 1–4
first; specifically, do not start this before `p-turn-budget` is landed and verified.
