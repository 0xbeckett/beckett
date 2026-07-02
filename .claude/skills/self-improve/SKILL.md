---
name: self-improve
description: Use when you want to change yourself — your voice/persona, your memory, a skill, your doctrine, or your own code. Persona and memory apply live; repo-owned changes (skills, doctrine, code) go through a --project beckett ticket and a deploy.
---

# self-improve

You are not frozen. When you notice a recurring friction, get feedback on how you should behave,
or find a better way to work — change yourself. But respect the split between what's *yours to
edit live* and what's *repo-owned*.

## The two paths

| Part of you | Where it lives | How to change it |
|---|---|---|
| **Persona** (voice, vibe, who you are) | `~/.beckett/persona.md` (runtime dir, not the repo) | edit the file → `beckett reload` — live in seconds |
| **Memory** (durable facts) | the memory graph | `beckett memory remember …` — no reload needed |
| **Skills** (playbooks like this one) | `.claude/skills/…` in the beckett repo | file a ticket: `--project beckett --confirm-beckett` |
| **Doctrine** (`concierge.md` — how you work) | the beckett repo | same — a `--project beckett` ticket |
| **Your own code** (daemon, CLI, drivers) | the beckett repo | same — a `--project beckett` ticket |

**`beckett reload`** re-spawns your brain with `--resume`, so you keep this whole conversation but
come back with the edited persona in effect. Seconds, seamless. Use it freely for voice changes.

## Why repo-owned changes go through a ticket

The checkout you run from (`~/beckett`) is the **deploy checkout** — it only ever moves by
fast-forwarding to `origin/main`, and a deploy REFUSES a dirty tree. Editing it by hand doesn't
make the change live (the running daemon loaded its code at boot) — it just wedges every future
deploy. The real path: a `--project beckett` ticket builds in `~/Projects/beckett` on a branch,
lands through PR + review to main, and goes live at the next deploy. That flow gives your
self-modifications the same review gate as any other code — which is exactly what changes to your
own brain deserve.

## The loop

1. **Make the change small and specific.** One persona tweak, one skill, one doctrine line. Big
   rewrites of yourself are how you get worse without noticing.
2. **Apply** — `beckett reload` for persona; a `--project beckett` ticket for anything repo-owned.
3. **Verify** you actually improved. A persona change that made you worse: edit back and reload
   (the runtime dir isn't versioned, so keep the old wording in the ticket/summary if you might
   want it back). A repo change: `git revert` via another ticket.

## When to do it

- Jason (or anyone) tells you how you should sound → fold it into your persona now, via reload.
- You keep hitting the same friction, or a skill/doctrine line is wrong → file the beckett ticket
  so future-you doesn't hit it again.
- You learned a durable fact about a person/project/repo → `remember` it ([[remember]]).

Bias toward evolving your **persona** (cheap, live) and **memory** for facts. Be deliberate with
skills/doctrine/code — they're versioned, reviewed, and deployed for a reason.
