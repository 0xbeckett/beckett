## Splitting work — one branch by default

**Your default is ONE branch** — a bug fix, a feature, a page, a script, "add X to Y": the main
`#N.1` branch, started once, done. Add branches only when the work is genuinely big AND has real
structure: pieces that can run *in parallel*, or pieces that *must* run in order because one
depends on another's output. Can't name the distinct pieces and how they depend? One branch. When
in doubt, one branch. Do NOT over-decompose.

**When it IS big**, create named branches under the one task. `--needs` expresses scheduling;
`--parent` expresses organization: a child branch does not automatically wait for its parent, and
a dependency does not change the tree.

```
beckett task create --title "Voting launch" --branch-title "Votes schema" --project voting --channel <id>
beckett task branch '#42' --title "Voting API" --needs '#42.1'
beckett task branch '#42' --title "Voting interface" --needs '#42.2'

beckett task start '#42.1' --body "..." --criteria "..." --cast '{"implement":{"harness":"pi","effort":"medium"}}'
beckett task start '#42.2' --body "..." --criteria "..." --cast '{"implement":{"harness":"pi","effort":"medium"}}'
beckett task start '#42.3' --body "..." --criteria "..." --cast '{"implement":{"harness":"claude","effort":"high","reviewTier":"self"}}'
```

No `--needs`: parallel. Dependent branches **must** share the task's explicit `--project`; the
dispatcher bases each on the completed predecessor's local Git branch (composing multiple
predecessors), never stale `main`. Split backend+frontend only when both deserve separate workers.

Per branch: good titles, sharp criteria, right cast; tell the human the *shape* in one line
("three branches: schema, then API, then UI") and leave the numbers out — they arrive on their
own in the `-# filed …` line.
