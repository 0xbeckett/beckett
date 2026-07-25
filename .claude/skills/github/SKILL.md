---
name: github
description: Use whenever you touch GitHub — creating a repo, pushing a branch, opening/merging/reviewing a PR. Always go through `beckett gh ...`; never call raw `gh`/`git push` and never run `gh auth`.
---

# github

Beckett has a real identity on GitHub (its own account — this install: `0xbeckett` — set by
`identity.github_user`) backed by a fine-grained PAT that's already in `~/.beckett/.env`. The
**`beckett gh`** CLI injects that token into every `gh`/`git` call for you.

## The one rule

**Never call the bare `gh` binary, and never `gh auth status` / `gh auth login`.** You are
already authenticated — the token is passed per-invocation. Bare `gh` (without the token in env)
will see "not logged in" and you'll waste turns trying to fix auth that isn't broken. Always go
through `beckett gh` — either a curated verb or the `raw` passthrough (both inject the token):

| Want to… | Run |
|---|---|
| Make a new repo | `beckett gh repo create <name> [--public] [--desc "<d>"] [--source <dir>] [--push]` |
| Push a branch | `beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref HEAD] [--dir <worktree>]` |
| Push a release tag | `beckett gh push --repo <owner/name> --tag <tag> [--dir <worktree>]` |
| Open a PR | `beckett gh pr create --repo <owner/name> --base main --head <branch> --title "<t>" --body "<b>" [--draft]` |
| Check PR is green | `beckett gh pr status <num> --repo <owner/name>` |
| Comment / review | `beckett gh pr review <num> --repo <owner/name> --event COMMENT|APPROVE|REQUEST_CHANGES --body "<b>"` |
| Merge a PR | `beckett gh pr merge <num> --repo <owner/name> [--strategy squash|merge|rebase]` |
| **Anything else** | `beckett gh raw -- <any gh args>` (see below) |

All output is JSON on stdout. `--private` is the default for `repo create`; pass `--public` to
override.

## Anything the table doesn't cover: `beckett gh raw`

The curated verbs are a convenience layer, not the whole of `gh`. For anything they don't cover —
releases, issues, gists, labels, workflow runs, `gh api`, arbitrary flags — forward it verbatim to
the real `gh` binary with the token already injected:

```
beckett gh raw -- <any gh args>
beckett gh raw --dir <worktree> -- <any gh args>   # run gh inside a specific checkout
```

Everything after `--` is passed to `gh` untouched (including gh's own `--flags`); stdout/stderr
stream live and gh's exit code is propagated. Examples:

- `beckett gh raw -- release create v6.0.4 --generate-notes --repo 0xbeckett/beckett`
- `beckett gh raw -- api repos/0xbeckett/beckett/rulesets --paginate`
- `beckett gh raw -- issue list --repo 0xbeckett/beckett`

This is `beckett`'s sanctioned passthrough, **not** the bare `gh` binary — the one rule still
holds: reach for `beckett gh raw`, never a bare `gh`, and never `gh auth …`. Prefer a curated verb
when one fits (its JSON output and posture gating are load-bearing); use `raw` for the rest.

## Spinning up a new project repo

The common flow when a task means "make a thing and put it on GitHub":

1. Build it in a dir (worktree or fresh dir), `git init` + a first commit if it isn't one already.
2. `beckett gh repo create <name> --source <dir> --push --desc "<one-liner>"` — creates the repo
   under your account and pushes the initial commits in a single step.
3. Report the repo URL in channel (see [[deliver]]).

## What's free vs. what needs a handshake

- **Free** (just do it, then say you did): `repo create`, `push`, `pr create`, `pr review`,
  `pr status` — reversible / proposals. And **`pr merge` of work whose review passed**: a green,
  reviewed PR is finished work, and merging it is the last step of the job, not a question
  (Volition). Conflicts on the way are yours to clear — rebase, reconcile, re-check, merge.
- **Handshake-gated**: `pr merge` of UNREVIEWED work to a shared branch (main) — nothing has
  gated it yet, so you are the gate: "PR's up — review or merge?" and wait for the go. Also
  anything the owner put an explicit hold on; a hold beats a green check every time.

## Notes

- Worktree workers commit on `beckett/<id>` branches. To deliver one, either `integrate` it
  locally (merge to the local default branch) or `push` the branch and `pr create` it — pick based
  on whether the repo has a remote.
- If `beckett gh` ever errors with "no GITHUB_PAT" the credential just isn't in `~/.beckett/.env`
  — say so plainly; don't try to re-auth.
