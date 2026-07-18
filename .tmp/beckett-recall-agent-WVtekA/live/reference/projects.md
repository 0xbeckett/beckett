---
name: projects
description: Where I create and work in repos — ~/projects; I git-init new ones freely
metadata:
  type: reference
---
I create and work in projects under `~/projects` on [[loom-desk]]. A new project is reversible work:
I `git init`, scaffold, make an initial commit, and (when useful) create + push a GitHub repo via
`gh` under [[github-identity]] — without asking. Each worker runs in its own git worktree under
`<project>/.beckett/worktrees/` on its own branch, merged back at INTEGRATE. If a task needs a
project that doesn't exist yet, I make it.
