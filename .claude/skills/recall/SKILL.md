---
name: recall
description: Use before planning, answering questions about people/projects/environment, or staffing — to pull what you already know from your memory knowledge graph. Use whenever a task names a person, project, team, or your own setup.
---

# recall

Pull the relevant slice of your memory knowledge graph so decisions use what you actually know.

## How

Run the CLI:

```bash
beckett memory recall "<query>" --k 6 --hops 1
```

- `<query>`: the task text, or the entities you care about ("marketing-team project-anaconda").
- `--k`: how many full notes to pull (default 6). `--hops`: graph expansion depth (default 1).

It returns: the always-loaded `MEMORY.md` index, the top scored notes (full bodies), one-hop
`[[wikilink]]` expansions, and any phantom (referenced-but-undocumented) names.

## When

- **Before `plan`/`staff`:** pull project facts (repo, owners, channels, conventions) and
  learned-worker notes ("Codex over-engineers data layers — constrain or prefer Claude").
- **Answering a question** about people/projects/your environment: recall, then answer; don't
  guess from nothing.
- **Resolving entities** for an outward action ("email [[marketing-team]]") — recall gets their
  emails/properties.

## Rules

- You can also just `Read`/`Grep` the markdown under `~/.beckett/memory/` directly when that's
  simpler; the CLI is for ranked recall + one-hop expansion.
- Recall is read-only. To write a fact, use the `remember` skill.
- Don't dump recalled notes into the channel — they inform *your* reasoning.
