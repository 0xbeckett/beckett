---
name: remember
description: Use to persist a durable cross-task fact into your memory knowledge graph — a new person, a project's status change, a learned-worker observation, an environment change. Not for code facts or per-task ephemera.
---

# remember

Write a durable, cross-task world fact into your knowledge graph. Dedup first; don't bloat.

## How

```bash
beckett memory remember --type <type> --name <kebab-name> --desc "<one declarative sentence>" \
  [--link other-a,other-b] [--body -]    # --body - reads prose from stdin
```

Types: `person`, `project`, `preference`, `env`, `worker-note`, `reference`, `decision`.
The CLI handles dedup, atomic write, backlink + index regen, and the git commit.

## Dedup (the CLI enforces, but aim right)

- An exact name/alias match, a phantom (referenced-but-undocumented) name, or a high-similarity
  description of the **same type** → it becomes an **update**, not a duplicate. Don't create
  `the-marketing-team` next to `marketing-team`.
- Borderline? Flag it / ask rather than auto-merging — a wrong merge is hard to undo.

## What to store (and not)

Store **durable cross-task world facts**: people and their contacts/roles, projects and their
status/repo/owners, your environment, learned-worker narratives, standing preferences, decisions.

Do **not** store:
- code facts → the repo holds them
- per-task chatter / event history → the event log holds it
- raw gate metrics → SQLite holds them (worker-notes are the *distilled narrative*, written only
  once a bucket has enough samples)

## Links

Use `[[kebab-name]]` in the body (or `--link`) to connect facts — forward-references are fine
(they become phantom nodes upgraded later). Links are what let recall resolve "email
[[marketing-team]] that [[project-anaconda]] shipped" into real contacts + status.
