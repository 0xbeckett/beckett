# `p-beckett-bus` — pi workers that can talk to Beckett mid-run

**Priority 5.** The first of the three that make Beckett an orchestrator rather than a dispatcher.

## Problem

A pi worker today is a black box between spawn and done-signal. It can emit assistant text and
tool calls, and Beckett normalises those into events — but the worker cannot *ask Beckett
anything* or *tell Beckett anything* except through its final structured output.

Consequences that have all actually cost time:

- A worker that gets stuck has no way to report *why* except by finishing blocked, so a stall
  looks identical to a slow run until the wall-clock cap fires.
- A worker cannot recall what Beckett already knows. Beckett has a memory knowledge graph
  (`beckett recall`, `beckett memory recall`) full of exactly the environment facts that make
  workers fail — "nothing builds only on macOS", "site deploy runs on `--help`", "the tunnel
  serves from the checkout, not the merge". The worker rediscovers each one by failing.
- A worker cannot file what it learns. Every hard-won environment fact dies with the worktree.

The worker *could* shell out to `beckett` — it's on PATH at `~/.local/bin/beckett` and the CLI has
`ticket comment`, `recall`, `memory recall`, `loops`. But via raw bash that is unguided,
unvalidated, undiscoverable by the model, and indistinguishable from any other shell command in
the event stream. Making it a set of **first-class pi tools** is what turns it from possible into
routine.

## Mechanism

`pi.registerTool()` for a small, deliberately narrow tool set, each implemented with `pi.exec()`
against the `beckett` CLI (not a reimplementation of the daemon protocol — the CLI is the
supported surface and it already handles auth, paths and the socket).

Proposed tools — **keep this list short**; every tool is context the model pays for on every turn:

| Tool | Backing | Why a worker needs it |
|---|---|---|
| `beckett_recall(query, type?)` | `beckett recall "<q>"` | environment/project facts before doing the thing that fails |
| `beckett_report(status, message)` | `beckett ticket comment` | mid-run progress, and *why* it's stuck, before the cap fires |
| `beckett_remember(fact, type)` | `beckett memory remember` | persist a learned environment fact |
| `beckett_loop_note(id, note)` | `beckett loops note` | attach to an existing known-defect loop instead of refiling it |

Deliberately **not** included: ticket creation, state transitions, deploys, GitHub operations,
anything outward-facing. A worker filing its own tickets or moving its own state is how a rework
cycle becomes a loop. Those stay with the dispatcher and the human.

Implementation notes:

1. Ticket id, board, and project come from flags Beckett passes at spawn
   (`pi.registerFlag("beckett-ticket", …)`), never from the model. A worker that can name the
   ticket it comments on can comment on someone else's.
2. `beckett_report` must be **rate-limited** in the extension (e.g. one per N turns, or one per
   distinct message). An enthusiastic worker will otherwise post twenty progress comments and the
   ticket becomes unreadable — and given the known ack-timeout double-post hazard on the control
   bus, retry-on-timeout must be off: a timed-out report is assumed delivered.
3. `beckett_recall` results should be injected as tool output, not as a system-prompt prelude.
   Recall on demand is the point; front-loading every fact is what the token budget can't afford.
4. Every tool call is already visible in the frame stream as `tool_execution_start`, so
   `PiDriver` gets the audit trail for free. Add nothing.
5. `beckett_remember` writes go through the normal memory path, which means they are subject to
   the normal rule — durable cross-task facts only, not per-task ephemera. Put that rule in the
   tool *description*, because the description is the only instruction the model reliably reads.

## Beckett-side changes this enables

- Real mid-run progress on tickets, which is the missing half of the supervise story: today
  `beckett supervise` reads worker *state*, and the worker's own account of what's happening is
  unavailable until it finishes.
- The Learning Loop organ gets a write path from the fleet, not just from the dream pass.
- Stall diagnosis stops depending on the journal.

## Verification

1. A fixture worker calls `beckett_recall` on a term with a known memory and the fact appears in
   its context; assert on the frame stream.
2. `beckett_report` lands one comment on a scratch ticket, and a burst of five reports lands the
   rate-limited number, not five.
3. A worker cannot comment on a ticket other than the one Beckett passed — assert the tool
   ignores/rejects any model-supplied id.
4. Tool descriptions are under a stated character budget (they are per-turn cost).

## Failure modes

- **Daemon down / socket gone.** Return a tool error naming it. Do not block the run — a worker
  that can't reach the bus should still be able to finish the code.
- **Double-post on ack timeout.** Known hazard; treat a timeout as delivered and never retry.
- **Tool-set bloat.** The pressure to add "just one more" tool is constant. Every addition needs
  to justify its per-turn token cost against the thing it replaces.

## Size

**M.** Each tool is thin; the design work is the narrowness of the list, the rate limiting, and
resisting the scope creep of letting workers drive the ticket lifecycle.
