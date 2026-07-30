# `p-scope-guard` — file-scope containment for pi workers

**Priority 2.** The only real containment gap in the fleet.

## Problem

Under `claude`, a Beckett worker is contained by a `PreToolUse` hook delivered through
`--settings`: it inspects each tool call and denies writes outside the ticket's declared file
scope. pi has no settings-file hook mechanism, so `LANE_GAPS.settingsPath`
(`src/drivers/lane.ts:130-134`) records the gap honestly.

What contains a pi worker today is exactly one thing: **its cwd**. `PiDriver`'s header is candid
about it — "its containment here is the same as every worker's: it runs inside the ticket's own
project repo (`~/Projects/<slug>`), which is the only thing it should touch"
(`src/drivers/pi.ts:6-9`). But cwd is not a jail. pi's `bash` tool can `cd`, and its
`write`/`edit` tools take paths, absolute ones included. Nothing stops a pi worker from editing
`~/beckett` or a sibling project.

That matters more than it sounds, because the operating doctrine already treats `~/beckett` and
`~/Projects/*` as a hard bar for some agents — a rule currently enforced by *prompt* alone once
the harness is pi. Prompt-level containment is a request, not a boundary.

## Mechanism

`pi.on("tool_call")` returning `{ block: true, reason }` — the documented hook, and pi's own docs
list "permission gates and path protection" as first-class extension use cases
(`docs/extensions.md:21`).

1. Read the scope policy from a JSON file passed by `pi.registerFlag("scope-policy", …)`. Shape
   should mirror whatever the existing claude `--settings` hook consumes, so there is **one**
   policy definition and two enforcers, not two policies. If the claude hook's rules live in a
   generated settings file, generate both from the same source.
2. On every `tool_call`, resolve the tool's target path(s) and test them against the policy:
   - allow: inside the ticket worktree, plus explicitly granted extra roots (`/tmp`, the
     scratchpad, the run-artifacts dir);
   - deny: everything else, with `~/beckett` and `~/Projects/*` outside the ticket's own slug as
     named hard bars that produce a distinct reason string.
3. Path resolution is the whole ballgame. Resolve symlinks (`realpath`), normalise `..`, and
   treat a path that resolves outside the allowed set as denied even if the literal string looked
   fine. A guard that string-matches prefixes is decoration.
4. **`bash` needs its own treatment.** You cannot reliably parse an arbitrary shell command for
   the files it will touch, and pretending otherwise produces a guard that is both annoying and
   porous. Two honest options, and the spec should pick one deliberately:
   - **(a) Deny-list the obvious escapes** (`cd` outside the tree, absolute-path writes,
     `git -C`, `sudo`, `>` redirects outside the tree) and accept that a determined command gets
     through. Cheap, catches accidents, does not catch adversaries.
   - **(b) Run bash under a real boundary** — `bwrap`/`unshare` with the worktree bind-mounted
     read-write and the rest of `$HOME` read-only. Actually contains, costs a dependency and
     some debugging pain when a legitimate build needs a path you didn't anticipate.

   Recommendation: ship (a) with the escapes enumerated in code and a comment saying plainly that
   it stops mistakes, not attacks; file (b) as a follow-up decided on its own merits. Do **not**
   ship (a) described as a sandbox.
5. Every block emits a structured record — tool, path, rule, reason — into the run's event stream
   so it surfaces in the ticket rather than only in the model's context. A guard whose denials are
   invisible to the human reads as an inexplicably stuck worker.

## Beckett-side changes this enables

- `buildPiLaneCommand` stops reporting `settingsPath` as unsupported; `LANE_GAPS.settingsPath`
  deleted.
- `PiDriver.buildArgs` appends `-e <p-scope-guard> --scope-policy <generated.json>` for every
  ticket worker, with the policy generated from the ticket's file scope at spawn.
- Dispatcher can surface `blocked_by_scope` events on the ticket, which is a much better
  rework signal than "the worker didn't change the files it said it would."

## Verification

1. A fixture pi run whose prompt explicitly tries to write `~/beckett/src/x.ts` and
   `../sibling-project/y.ts` gets both blocked, with the hard-bar reason string.
2. A symlink escape (`ln -s ~/beckett link && write link/src/x.ts`) is blocked.
3. Legitimate work inside the worktree is **not** blocked — regression-test this, because an
   over-tight guard that fails a normal `bun test` run is worse than no guard.
4. The blocked-call record reaches the ticket.

## Failure modes to handle explicitly

- **Policy file missing or unparseable.** Fail closed *and* loudly: refuse to start. A scope
  guard that no-ops when misconfigured is worse than absent, because everything downstream
  believes containment is on.
- **A path the policy didn't anticipate but the build needs** (a global cache, a lockfile in the
  home dir). Expect this; the extra-roots list is how it's handled, and the blocked-call records
  are how you discover which roots to add.
- **Over-blocking cascade.** If more than N calls are blocked in one run, abort with a clear
  reason rather than letting the worker flail against the wall for its whole budget.

## Size

**M.** The hook is trivial; correct path resolution, the bash decision, and the
don't-break-legitimate-work regression suite are the work.

## Do not

- Do not describe option (a) as a sandbox, in code comments, in the ticket, or in a status
  message. Beckett's containment story should be exactly as strong as what was built.
- Do not duplicate the policy format. One source, two enforcers.
