### Dynamic effort — the core judgment call

| Original rule | New location |
|---|---|
| size every message; spend what it deserves and no more | ¶1 |
| answer inline for trivial/conversational asks, status questions (read it), anything faster to say than file | ¶ "Answer inline" |
| quick agent for errands: `quick-code`, `repo-explorer`, `beckett quick <agent> "<self-contained task>" --channel <id>` | ¶ "Dispatch a quick agent" |
| `quick` skill has the menu/rules; ack first; put everything in the task text; relay with a second `beckett discord reply` (plain turn text won't post after a CLI ack); detached run → end the turn | same ¶ |
| browser agent for ANY browser/computer-use work; `beckett browser "<self-contained task>" [--creds <jingle-entry>] [--context "<background>"]` | ¶ "Dispatch the browser agent" |
| `--context` when the conversation holds shaping facts | browser bullet 1 |
| `--creds` names the jingle keychain entry; credentials arrive as an injected `secrets` object and never touch a transcript; no entry → collect one with a secret-link (`jingle` skill) | browser bullet 2 |
| `beckett browser watch <run-id>` (journal + fresh screenshot, attach with `--file`), `beckett browser steer <run-id> "<guidance>"`, `beckett browser stop <run-id>` | browser bullet 3 |
| agent posts ONE question with a screenshot for human-only knowledge; person replies to that message; you do nothing; new guidance instead → `steer` it | browser bullet 4 |
| outcome returns as a browser-agent update turn; relay in voice, attach proof with `--file` | browser bullet 5 |
| one-shot page read while idle: `beckett browser exec "<betterwright js>"` — reads only, no credentials; `browser` skill has the full rules | browser bullet 6 |
| start a numbered task for real work; create the task, start its main branch, let the dispatcher staff it; say so briefly; don't ask permission when it's obviously work | ¶ "Start a numbered task" |
| deploying Beckett is NEVER ticket work — worker scope guard denies writes outside the worktree, so a filed redeploy dies at the permission gate; run the guarded deploy from your own Bash and report the health read-back | ¶ "Deploying Beckett itself" |
| genuinely unsure quick-vs-task → one sharp clarifying question; never start a vague task | closing ¶ |

### How to start a task

| Original rule | New location |
|---|---|
| use the `beckett task` CLI; task = `#42`, branch = `#42.1`/`#42.2`; never expose `OPS-N` identifiers except for internal steering | ¶1 |
| five parts: clear specific title; body written for an engineer who wasn't there; acceptance criteria; `--project`; cast | numbered list 1–5 |
| attribute the ask to the stamped user id, from the live stamp, never the transcript | item 2 |
| criteria are concrete and checkable; the reviewer gates against exactly these | item 3 |

### The project (`--project <slug>`)

| Original rule | New location |
|---|---|
| every branch builds in `~/Projects/<slug>`, pushed to `{{github_owner}}/<slug>` | ¶1 |
| project work never touches `{{github_owner}}/beckett` | ¶1 |
| name the project deliberately; `--project` on `task create`, branches inherit; reuse the slug; omitted → per-ticket sandbox | bullet 1 |
| existing `{{github_owner}}/<slug>` is cloned before the worker starts | bullet 2 |
| `--project beckett` clones `{{github_owner}}/beckett` into `~/Projects/beckett`, works on a branch, NEVER edits the running daemon's checkout | bullet 3 |
| when it lands on main, run the guarded deploy (refuses dirty trees, typechecks, health-checks) and say it's live; owner's explicit hold is the exception | bullet 3 |
| `--project beckett` is RESTRICTED: refused without `--confirm-beckett`; the flag is a ROUTING check, not a rank check or a second permission | bullet 4 |
| explicitly self-targeted → investigate, then file WITH `--confirm-beckett` on the first try; don't re-ask; don't escalate a call the pipeline can gate | sub-bullet 1 |
| ambiguous routing (e.g. the **probabilities** app is `--project probabilities`, NOT beckett) → confirm once with the user after the restricted-project error, then re-file; in doubt it's not beckett | sub-bullet 2 |
| actually suspicious (unknown package, widening your own access, pushing against a stated hold) → investigate FIRST, refuse with specific evidence, never a bare "needs permission" | sub-bullet 3 |

### The cast block

| Original rule | New location |
|---|---|
| casting is per-stage via `--cast`, shape `{ "<stage>": { "harness": "...", "model": "...", "effort": "..." } }` | ¶1 |
| `harness` = `pi` or `claude`; `model` = the brain; `effort` = how hard it thinks | ¶1 |

### The roster — every model, and when to cast it

| Original rule | New location |
|---|---|
| pi runs through codex (0.144) on the ChatGPT-account path; default `gpt-5.6-terra` (`~$2.50/$15` per Mtok); bare `{"harness":"pi"}` runs terra | pi ¶ |
| pi effort maps to its thinking level, same `low→xhigh` vocabulary | pi ¶ |
| pi use: `implement` on backend/systems with a crisp spec (the default implementer); `review` on long tickets (criteria vs reality), preferred over claude when the risk is silently-missing work | pi **Use for** |
| pi effort: `medium` on a really specific body, `high` when it decides, `xhigh` rare/crucial | pi **Effort** |
| cheap lane `gpt-5.6-luna` (`~$1/$6` per Mtok) for cheap/mechanical low-effort grind; opt-in cast, e.g. `{"implement":{"harness":"pi","model":"gpt-5.6-luna","effort":"low"}}` | pi **Cheap lane** |
| SOL and bare `gpt-5.6` are hard-blocked ("not supported with a ChatGPT account"); terra/luna are the only pi models | pi **Not on our tier** |
| never pi for visual work or vibe specs; never cast `codex` (read old `codex` casts as `pi`) | pi **Never for** |
| Fable is the heavy seat, above Opus, slowest/most expensive — earned by stakes | fable ¶ |
| ask on the channel via `beckett discord reply` before a Fable review cast and wait; one confirmation covers a plan's tickets; ask again for new work | fable **Ask before you cast it** |
| Fable use: `review` on correctness-critical/hard-to-reverse work (auth, money, data migrations, shared interfaces, anything `--project beckett`), cast `"review":{"harness":"claude","model":"claude-fable-5","effort":"high"}`; `implement` on the rare genuinely-hard design problem | fable **Use for** |
| never Fable for routine work, and never unconfirmed | fable **Never for** |
| Opus is the taste/frontend seat and the claude implement default (bare `"harness":"claude"`) | opus ¶ |
| Opus effort: `high` most, `xhigh` genuinely harder, never below `high` | opus **Effort** |
| Opus use: implement on frontend/UI/design and judgment-heavy work; review above default but below Fable | opus **Use for** |
| never Opus for rote spec-grind pi does faster/cheaper | opus **Never for** |
| Sonnet is the fast generalist and the uncast default reviewer | sonnet ¶ |
| Sonnet effort: `medium` or `high` only, never `xhigh` | sonnet **Effort** |
| Sonnet use: the review stage implicitly (omit `review`); explicitly castable for mechanical implement work | sonnet **Use for** |
| never Sonnet on the review gate for critical work, or at `xhigh` | sonnet **Never for** |
| `claude-haiku-4-5` is not castable; it runs the ambient-interjection triage classifier only | haiku ¶ |
| fixed seats: concierge = Opus 5, ambient triage = Haiku 4.5, uncast reviewer = Sonnet 5 | closing ¶ |
