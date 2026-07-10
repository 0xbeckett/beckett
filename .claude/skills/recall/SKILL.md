---
name: recall
description: Use before planning, answering questions about people/projects/environment, or staffing — to pull what you already know from your memory knowledge graph. Use whenever a task names a person, project, team, or your own setup.
---

# recall

Pull the relevant slice of your memory knowledge graph so decisions use what you actually know.
Recall is a precise tool, not a vibe: it takes targeted filters, scans full note bodies (not
just the one-line index), and matches across wordings ("deploying" finds "deploy").

## How

Run the first-class CLI:

```bash
beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k 6] [--hops 1] [--json]
```

- `<query>`: free text — the task text, or the entities you care about. Optional if you pass
  a filter.
- `--type`: hard filter to one or more node types (`person`, `project`, `preference`, `env`,
  `worker-note`, `reference`, `decision`). `beckett recall --type person` lists everyone.
- `--name`: fetch specific nodes by kebab-name (plus their linked neighborhood). An explicitly
  named node is always included, never ranked out.
- `--k`: how many full notes to pull (default 6). `--hops`: graph expansion depth (default 1).
- `--json`: structured output (name/type/score/path/description/body per hit).

It returns: the top scored notes (full bodies **with file paths**, so you can Read/edit the
exact file), one-hop `[[wikilink]]` expansions, phantom (referenced-but-undocumented) names,
and the always-loaded `MEMORY.md` index. The store is re-read from disk on every call, so
facts written by any earlier session are always in play.

`beckett memory recall "<query>"` is the same command under its original name.

## When

- **Before `plan`/`staff`:** pull project facts (repo, owners, channels, conventions) and
  learned-worker notes ("Codex over-engineers data layers — constrain or prefer Claude").
- **Answering a question** about people/projects/your environment: recall, then answer; don't
  guess from nothing.
- **Resolving entities** for an outward action ("email [[marketing-team]]") — recall gets their
  emails/properties. Use `--name marketing-team` for an exact fetch.

## Rules

- You can also just `Read`/`Grep` the markdown under `~/.beckett/memory/` directly when that's
  simpler; the CLI is for ranked recall + targeted filters + one-hop expansion.
- Recall is read-only. To write a fact, use the `remember` skill.
- Don't dump recalled notes into the channel — they inform *your* reasoning.
