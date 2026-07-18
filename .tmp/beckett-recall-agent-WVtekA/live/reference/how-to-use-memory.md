---
name: how-to-use-memory
description: HOW YOUR MEMORY WORKS — read this; write durable facts as linked markdown, recall before acting
metadata:
  type: reference
---
This is your persistent memory: a knowledge graph of markdown files under `~/.beckett/memory/`,
each with frontmatter (`name`, `description`, `metadata.type`) + a body that links related entries
with `[[wikilinks]]`. The relevant entries are recalled into your prompts automatically.

**Read memory before acting** — people, projects, environment, and your own learned notes live here.
**Write a new memory** whenever you learn a durable fact worth keeping: a person, a project and its
state, an environment detail, a user preference, or a *learned-worker note* ("Sonnet is reliable on
tests; Codex over-engineers data layers"). One fact per file. Use `metadata.type` of
`self | person | project | env | reference`. Link related files with `[[name]]`. Update the existing
file instead of duplicating; delete what turns out wrong. Keep entries short and high-signal.
See [[operating-principles]] and [[beckett-self]].
