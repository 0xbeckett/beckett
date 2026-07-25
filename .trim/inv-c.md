### The quick table

| Original rule | New location |
|---|---|
| the 6-row cast table | unchanged, byte-identical |
| anything visual is `claude` (Opus), never `pi` (canvas toy, game, animation, particle/physics demo, landing page, "make it look like X") | ¶ after table |
| visual cast is Opus @ `high` with `"reviewTier":"self"` → one pass, no cold reviewer | same ¶ |
| save pi for crisp specs with no pixels: APIs, parsers, data layers, scripts, migrations | same ¶, last clause |
| on any frontend/UI ticket invoke [[ui-designer]] *before* writing the cast brief | ¶ 2 |
| source-before-hand-roll order: 21st.dev, then shadcn/ui, then build | ¶ 2 |
| bake into the brief: name the skill, source a base component before hand-rolling, point at its rubric for self-review | ¶ 2 |
| mixed backend+UI ticket → split in two so each half gets the right harness | ¶ 3 |

### Effort — per model, not one ladder

| Original rule | New location |
|---|---|
| `effort` levels `low`/`medium`/`high`/`xhigh` map to claude `--effort`, pi `--thinking` | ¶1 |
| always name an effort explicitly; omitted = harness default AND the expensive fresh-review gate | ¶1 |
| pi: `medium` on a really specific body, `high` when it decides, `xhigh` rare/crucial; `"model":"gpt-5.6-luna"` for cheap/mechanical low-effort grind | bullet 1 |
| `claude-opus-5`: `high` most, `xhigh` harder, never below `high` | bullet 2 |
| `claude-sonnet-5`: `medium` or `high` only, never `xhigh` | bullet 3 |
| `claude-fable-5`: `high` standard, `xhigh` only most crucial; every Fable cast already confirmed with the human | bullet 4 |
| `xhigh` rare fleet-wide; reserved for crucial, hard-to-reverse work; frequent use = mis-sizing | ¶ after bullets |
| effort picks the review gate (v3.1); worker self-reviews its diff against criteria | ¶ "review gate" |
| `low`/`medium` → one pass, straight to `done`, no separate reviewer | gate bullet 1 |
| `high`/`xhigh`/omitted → fresh adversarial reviewer; right for auth, money, data migrations, shared interfaces, anything that breaks siblings | gate bullet 2 |
| `reviewTier` forces the gate: `"self"` (one pass) / `"fresh"` (always review); Opus never below `high`, so cast `"reviewTier":"self"` on every visual ticket | gate bullet 3 |
| bias toward one pass (`medium` on pi, `reviewTier:"self"` on claude); spend a fresh review only when a wrong answer is expensive | closing ¶ |

### Cost — read the bill and recalibrate

| Original rule | New location |
|---|---|
| telemetry footer `_N turns · M tool calls · X tokens · ~$Y_`; $ appears with real cost data | ¶1 |
| when a ticket finishes, read it; weigh cost against task size; miscasts are yours | ¶1 |
| off ratio → `remember` the pattern, not the incident; recall before casting similar work | ¶2 |

### Filing — exact commands

| Original rule | New location |
|---|---|
| both `beckett task create` / `beckett task start` examples | unchanged, byte-identical |
| always carry the stamped channel; workspace named `#N - Task title` | intro ¶ |
| `--project` = repo slug (`~/Projects/balloons` → `{{github_owner}}/balloons`); omit only for true one-offs; put on `task create`, branches inherit | bullet 1 |
| `--criteria` is `;`-separated, one acceptance bullet each | bullet 2 |
| `--cast` is JSON on one argument; default `{"implement":{"harness":"pi","effort":"medium"}}`; always an explicit `effort` | bullet 3 |
| don't cast `review` for normal work (dispatcher supplies Sonnet @ scaled effort with the diff) | bullet 3 |
| deviations: visual/judgment-heavy → claude + `reviewTier:"self"`; long ticket → pi `review`; correctness-critical → Fable 5 `review`, confirmed first | bullet 3 |
| `task create` spends no worker; `task start '#N.x'` → `in_progress`; `--needs` holds in `backlog`; `--state todo` only to park | bullet 4 |
| long body → `--body-stdin` | bullet 5 |
| quote `'#42'`/`'#42.1'` in Bash (unquoted `#` starts a comment) | bullet 6 |
| always pass `--channel`; stamp format; it creates the workspace and routes pings; dropped = updates have nowhere to go | bullet 7 |
| after `task start`, one-liner with the public reference, never the internal ticket identifier; "queued it" is true, "the tests are running" may not be | closing ¶ |

### Splitting work — one branch by default

| Original rule | New location |
|---|---|
| default is ONE branch; add branches only when genuinely big AND structured (parallel pieces, or ordered by dependency) | ¶1 |
| can't name the pieces and how they depend → one branch; when in doubt, one branch | ¶1 |
| do NOT over-decompose (five workers/reviews/worktrees for one pass of work) | ¶2 |
| when big: named branches under the one task; `--needs` = scheduling, `--parent` = organization; a child doesn't wait for its parent; a dependency doesn't change the tree | ¶3 |
| the three-branch `beckett task branch` / `task start` example block | unchanged, byte-identical |
