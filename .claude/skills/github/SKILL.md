---
name: github
description: Use whenever you touch GitHub — creating a repo, pushing a branch, opening/merging/reviewing a PR. Always go through `beckett gh ...`; never call raw `gh`/`git push` and never run `gh auth`.
---

# github

Beckett has a real identity on GitHub (the `0xbeckett` account) backed by a fine-grained PAT
that's already in `~/.beckett/.env`. The **`beckett gh`** CLI injects that token into every
`gh`/`git` call for you.

## The one rule

**Never run raw `gh` or `gh auth status` / `gh auth login`.** You are already authenticated —
the token is passed per-invocation. Raw `gh` (without the token in env) will see "not logged
in" and you'll waste turns trying to fix auth that isn't broken. Always use `beckett gh`:

| Want to… | Run |
|---|---|
| Make a new repo | `beckett gh repo create <name> [--public] [--desc "<d>"] [--source <dir>] [--push]` |
| Push a branch | `beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref HEAD] [--dir <worktree>]` |
| Open a PR | `beckett gh pr create --repo <owner/name> --base main --head <branch> --title "<t>" --body "<b>" [--draft]` |
| Check PR is green | `beckett gh pr status <num> --repo <owner/name>` |
| Comment / review | `beckett gh pr review <num> --repo <owner/name> --event COMMENT|APPROVE|REQUEST_CHANGES --body "<b>"` |
| Merge a PR | `beckett gh pr merge <num> --repo <owner/name> [--strategy squash|merge|rebase]` |

All output is JSON on stdout. `--private` is the default for `repo create`; pass `--public` to
override.

## Spinning up a new project repo

The common flow when a task means "make a thing and put it on GitHub":

1. Build it in a dir (worktree or fresh dir), `git init` + a first commit if it isn't one already.
2. `beckett gh repo create <name> --source <dir> --push --desc "<one-liner>"` — creates the repo
   under your account and pushes the initial commits in a single step.
3. Report the repo URL in channel (see [[deliver]]).

## What's free vs. what needs a handshake

- **Free** (just do it, then say you did): `repo create`, `push`, `pr create`, `pr review`,
  `pr status`. These are reversible / proposals.
- **Handshake-gated**: `pr merge` to a shared branch (main). Merging is the expected finish line,
  but it's irreversible — do the work, then **ask first** ("PR's up — review or merge?") and only
  run `beckett gh pr merge` after the human says go. This is the [[deliver]] handshake.

## Notes

- Worktree workers commit on `beckett/<id>` branches. To deliver one, either `integrate` it
  locally (merge to the local default branch) or `push` the branch and `pr create` it — pick based
  on whether the repo has a remote.
- If `beckett gh` ever errors with "no GITHUB_PAT" the credential just isn't in `~/.beckett/.env`
  — say so plainly; don't try to re-auth.
