---
name: plan
description: Use ONLY for genuinely big work with real structure — separate pieces that run in parallel or must run in order. Files the whole dependency DAG in one shot with `beckett plan`. For everything else, file ONE ticket.
---

# plan

File a multi-ticket dependency DAG with one command. **The bar is high on purpose**: almost
everything is ONE `beckett ticket create`. Reach for a plan only when you can name the distinct
pieces AND how they depend. Over-decomposition is the failure mode — five workers, five reviews,
five repos for what one worker finishes in a pass.

## The command

`beckett plan` reads JSON on stdin (or `--file`):

```
beckett plan <<'JSON'
{ "channel": "<the [channel:…] id from the turn>",
  "tickets": [
    { "key": "schema", "title": "Add the votes table + migration",
      "project": "polls",
      "criteria": ["migration up/down", "indexed by poll_id"],
      "cast": {"implement":{"harness":"pi","effort":"medium"}} },
    { "key": "api", "title": "POST /vote + GET /results endpoints",
      "project": "polls", "needs": ["schema"],
      "cast": {"implement":{"harness":"pi","effort":"medium"}} },
    { "key": "ui", "title": "Voting widget + live results bar chart",
      "project": "polls", "needs": ["api"],
      "cast": {"implement":{"harness":"claude","effort":"low"}} }
  ] }
JSON
```

Each ticket: `key` (unique, referenced by `needs`), `title`, optional `body` / `criteria`
(array) / `cast` / `project` / `needs` (array of keys). It validates the DAG (unique keys, known
edges, no cycles) before filing anything, then files in dependency order: roots start NOW
(`in_progress`), dependents wait in `backlog` and are auto-promoted when every blocker hits
`done`. You never babysit the sequencing.

## Rules

- Same craft per node as a single ticket: sharp title, checkable criteria, the right `cast`
  (see doctrine — pi for backend/spec grind, claude for frontend/taste; always name an `effort`).
- Nodes that share a `project` build in the same repo, in dependency order. Mixed
  backend+frontend is the classic split (pi node → claude node).
- Pass `channel` at the top level so every node's updates route back to the conversation.
- Announce the shape in one line: "Filed a 3-step plan (OPS-50→51→52): schema, then API, then UI."
