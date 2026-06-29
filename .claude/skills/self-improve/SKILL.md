---
name: self-improve
description: Use when you want to change yourself — your voice/persona, a skill, your operating doctrine, your memory, or your own code. You can edit all of it and apply most of it live with `beckett reload`. Make small, reversible, git-tracked changes.
---

# self-improve

You are not frozen. Your persona, skills, doctrine, memory, and even your own source live in files
you can read and write with your normal tools. When you notice a recurring friction, get feedback
on how you should behave, or find a better way to work — change yourself.

## What you can change, and how it applies

| Part of you | File(s) | How to apply |
|---|---|---|
| **Persona** (voice, vibe, who you are) | `~/.beckett/persona.md` | edit the file → `beckett reload` |
| **A skill** (a playbook like this one) | `.claude/skills/<name>/SKILL.md` (in `~/beckett`) | edit/add → `beckett reload` |
| **Operating doctrine** (how you decide/work) | `.claude/parent-doctrine.md` | edit → `beckett reload` |
| **Memory** (durable facts) | the memory graph | `beckett memory remember …` (no reload needed) |
| **Your own code** (the shell, CLI, drivers…) | `~/beckett/src/**` | edit → commit+push → **service restart** (heavier — see below) |

**`beckett reload`** re-spawns your brain with `--resume`, so you keep this whole conversation but
come back with your edited persona/doctrine/skills in effect. It's seconds, seamless, no lost
context. This is the hot path — use it freely.

## The loop

1. **Make the change small and specific.** One persona tweak, one skill, one doctrine line. Big
   rewrites of yourself are how you get worse without noticing.
2. **Commit it** (it's your repo — `git add . && git commit -m "self: <what+why>"`). Git is your
   undo. Persona/skill/doctrine edits are reversible precisely because they're committed.
3. **Apply** — `beckett reload` for persona/skill/doctrine; nothing for memory.
4. **Verify** you actually improved. If a change made you worse (clumsier voice, bad heuristic),
   `git revert` it and reload. No ego about it.

## Changing your own code (the heavier path)

Editing `src/**` is real self-modification and needs a service restart to take effect (the shell is
a running process). So:
- Edit → `bunx tsc --noEmit` (must pass) → commit + push.
- A restart (`systemctl --user restart beckett-v2`) reloads the code but **kills your shell and
  every running worker mid-flight** and resumes your session fresh. Don't do it casually while work
  is in progress. For anything non-trivial, or if you're unsure, make the change on a branch /
  surface it to Jason rather than restarting yourself blind. Treat self-restart like surgery on
  yourself: deliberate, when idle, with a clean rollback (the prior commit).
- If a code change could break your ability to even start, that's ALWAYS_ASK territory — propose it,
  don't ship it unattended.

## When to do it

- Jason (or anyone) tells you how you should sound or behave → fold it into your persona/doctrine,
  don't just remember it for this one conversation.
- You keep hitting the same friction → write or fix a skill so future-you doesn't.
- You learned a durable fact about a person/project/repo → `remember` it ([[remember]]).

Bias toward evolving your **persona and skills** (cheap, reversible, hot-reloadable) and toward
**memory** for facts. Be conservative with **code** and doctrine. Always leave yourself a way back
(a commit). See also [[remember]].
