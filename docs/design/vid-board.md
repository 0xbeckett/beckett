# Design doc: a VID Plane board for video-production work

**Ticket:** OPS-93 · **Status:** design only (no code/config changes here) · **Requested by:** ro

> ro's framing: "it's really just adding a new table — nothing else changes except
> you can pick where the ticket goes, but it should have a workflow that works best
> with video production."

This doc grounds that ask in how Beckett wires Plane **today**, proposes the concrete
config + CLI changes to route a ticket to a **VID** board instead of the default **OPS**
board, defines a video-production workflow (state set + transitions), and hands a
follow-up build ticket an implementation outline with the open questions called out.

The actual config/code change is a **separate ticket**. This one produces the doc only.

---

## 1. How Plane is wired today (OPS-only)

Beckett talks to a single self-hosted Plane instance and files **every** ticket into one
project. That project's Plane *identifier* is `OPS`, which is why tickets read `OPS-93`.

### 1.1 The config block — the one place a Plane project is named

`src/config.ts` (lines ~243–263) — the entire `[plane]` schema:

```ts
plane: z.object({
  base_url:       z.string().min(1).default("https://plane.0xbeckett.me"),
  workspace_slug: z.string().min(1).default("beckett"),
  project_slug:   z.string().min(1).default("beckett"),   // <- resolves to the OPS project
  poll_secs:      posInt.default(5),
  state_map: z.object({
    backlog:     z.string().min(1).default("Backlog"),
    todo:        z.string().min(1).default("Todo"),
    in_progress: z.string().min(1).default("In Progress"),
    in_review:   z.string().min(1).default("In Review"),
    done:        z.string().min(1).default("Done"),
    cancelled:   z.string().min(1).default("Cancelled"),
  }).default({}),
}).default({}),
```

Note: `base_url`, `workspace_slug`, `project_slug`, `poll_secs`, and `state_map` all come
from `~/.beckett/config.toml`. Only two Plane values ride the environment (never config):
`PLANE_API_TOKEN` (the `X-API-Key` secret) and the optional `PLANE_INTERNAL_URL`
(internal API root that bypasses the public auth gate). `state_map` maps each of Beckett's
six canonical `TicketState`s to a Plane workflow-state **name**; the client resolves
name → UUID at runtime.

### 1.2 Where "OPS" actually comes from

The `OPS` prefix is **not hard-coded in the repo**. `config.plane.project_slug` (`"beckett"`)
is only the *lookup key*; the prefix is the matched Plane project's own `identifier`.

- `src/plane/client.ts` `resolveProject()` (lines ~501–524) fetches all projects in the
  workspace and matches `project_slug` against each project's `identifier`, then `name`,
  then `id` (case-insensitive). The matched project happens to have `identifier = "OPS"`
  and `name = "beckett"`, so slug `"beckett"` matches on **name**, and the resolved
  `projectIdentifier` is `"OPS"`.
- `src/plane/client.ts` `hydrate()` (lines ~425–428) builds the human ref:
  ```ts
  const identifier =
    issue.sequence_id != null && this.projectIdentifier
      ? `${this.projectIdentifier}-${issue.sequence_id}`   // "OPS" + "-" + 93 => "OPS-93"
      : issue.id;
  ```

So the prefix is owned by Plane (the project's `identifier`). Changing prefixes = filing
into a **different Plane project** whose identifier is `VID` — not editing a string in
Beckett.

### 1.3 The client is a single-project object

`PlaneClient` caches exactly one project + one set of workflow states:

- `src/plane/client.ts` (lines ~253–258): `projectId`, `projectIdentifier`,
  `statesByName`, `idToTicketState`, `cachedStates` — all singular, one project's worth.
- `apiBase` (lines ~267–268) is `${apiRoot}/api/v1/workspaces/${workspace_slug}`, and
  every issue path hangs off `projects/${this.projectId}/` (`issuesProjectPath()`,
  `issuesPath()`, lines ~563–569).
- `resolveStateId()` / `loadStates()` (lines ~464–559) read the **single** `state_map` and
  the **single** project's `states/` endpoint to build the name↔UUID maps.

### 1.4 One client for the whole system

- **Daemon:** `src/shell/v4-main.ts` (line ~105) constructs one `createPlaneClient({config})`
  and hands that same instance to the poller (which feeds the dispatcher) and the Concierge.
  The poller (`src/plane/poll.ts`) sweeps `listIssueHeads()` / `listIssues()` — both scoped
  to that one project — so the daemon only ever *sees* OPS tickets.
- **CLI:** `src/cli/beckett.ts` builds a fresh single-project client per invocation for both
  the `ticket` group (line ~627) and the `plan` group (line ~815), each from `config.plane`.

### 1.5 The canonical lifecycle the engine keys off

`src/plane/types.ts` (lines ~26–38) fixes six canonical states, and the dispatcher's whole
state machine is written against them:

```ts
export type TicketState =
  "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export const TICKET_TERMINAL = new Set(["done", "cancelled"]);
```

`src/dispatch/dispatcher.ts` behaviour (verified in the file):

| Ticket enters…    | Dispatcher does…                                                        |
|-------------------|-------------------------------------------------------------------------|
| `in_progress`     | spawns the `casting.implement` worker                                    |
| `in_review`       | spawns the `casting.review` reviewer                                     |
| `done`/`cancelled`| terminal — no worker; `done` promotes dependents whose blockers cleared |
| `backlog`/`todo`  | idle/ready — held until `blockedBy` deps all reach `done`, then promoted |

These six states are the **engine**. Any new board still has to express its lifecycle in
terms Beckett's dispatcher understands (see §3).

### 1.6 The `--project` trap — it is NOT the board

**Critical distinction for the implementer.** `beckett ticket create --project <slug>`
already exists, but `--project` today selects the **code repo the ticket builds**
(`~/Projects/<slug>`, published to `0xbeckett/<slug>`), stored in the `beckett-project`
fence in the description. In the `Ticket` type these are two different fields:

- `Ticket.project` — the **code project** (a git repo). Set by `--project`.
- `Ticket.projectId` — the **Plane board** (the queue). Currently always the OPS project.

See `src/plane/types.ts` (lines ~100–107) and `src/cli/beckett.ts` (lines ~675–677).
**Reusing `--project` to pick the board would collide with the existing code-repo meaning.**
The board selector must be a new, distinct flag (§3.2).

---

## 2. Goal

Let a ticket be filed onto either the existing **OPS** dev board or a new **VID** board,
where VID is a distinct Plane project (identifier `VID`, so tickets read `VID-1`, `VID-2`…)
with a workflow tuned for video production. Default routing stays OPS — nothing changes for
existing callers who don't ask for a board.

---

## 3. Proposed design

### 3.1 Config shape: named boards under `[plane]`

Turn the single project into a **map of named boards**, keeping the connection-level fields
(`base_url`, `workspace_slug`, `poll_secs`) shared. Each board carries its own
`project_slug` and `state_map`. A `default_board` names the fallback so existing behaviour
is preserved.

```toml
[plane]
base_url       = "https://plane.0xbeckett.me"
workspace_slug = "beckett"
poll_secs      = 5
default_board  = "ops"

# The existing dev board — behaviour identical to today.
[plane.boards.ops]
project_slug = "beckett"          # resolves to the Plane project with identifier OPS
workflow     = "dev"              # generic dev lifecycle (the default)
[plane.boards.ops.state_map]
backlog     = "Backlog"
todo        = "Todo"
in_progress = "In Progress"
in_review   = "In Review"
done        = "Done"
cancelled   = "Cancelled"

# The new video board.
[plane.boards.vid]
project_slug = "vid"              # a NEW Plane project whose identifier is VID
workflow     = "video"            # selects the video state model (see §4)
[plane.boards.vid.state_map]
# canonical TicketState -> the VID project's Plane workflow-state NAME
backlog     = "Ideas"
todo        = "Scripting"
in_progress = "Production"
in_review   = "Review"
done        = "Published"
cancelled   = "Shelved"
```

**Backward-compatibility rule:** the schema should accept the *old* flat `[plane]` shape
(single `project_slug` + `state_map`) and normalize it to
`boards = { <project_slug or "ops"> : {…} }` with `default_board` pointing at it. That keeps
existing boxes booting untouched while the migration lands. (Validation is strict — an
`.env`/TOML with the flat shape must still parse, so this normalization happens *before*
the strict object check, or the flat keys stay accepted as a deprecated alias.)

### 3.2 CLI surface: a new `--board` flag

Add a `--board <name>` flag to `beckett ticket create` and to `beckett plan` nodes.
Distinct from `--project` (§1.6): `--board` picks the **Plane queue**, `--project` picks the
**code repo**.

```
beckett ticket create --title "…" --board vid [--project my-video-repo] [--state …] …
```

- Absent `--board` ⇒ `config.plane.default_board` (i.e. OPS) — unchanged for every existing
  caller.
- Unknown board name ⇒ loud failure listing valid boards (mirrors the existing
  `resolveProject` "have: …" error style).
- `beckett plan`: a per-node `"board"` key on each DAG ticket, plus an optional top-level
  `"board"` default for the whole plan (sits alongside the existing top-level `"channel"`).

The Concierge reaches these commands via its Bash tool, so the flag is also how the
Concierge routes video asks — its prompt/skill guidance is a separate follow-up (out of
scope here; noted in §6).

### 3.3 Client: make `PlaneClient` board-scoped

`PlaneClient` is already a single-project object (§1.3). The smallest change that preserves
its internals: **construct it against one board's config, and keep one client per board.**

```ts
// today
createPlaneClient({ config, logger })                 // implicitly config.plane (OPS)
// proposed
createPlaneClient({ config, board: "vid", logger })   // scopes project_slug + state_map to VID
```

Inside the client, replace the direct `this.config.plane.project_slug` /
`this.config.plane.state_map` reads with the selected board's values (resolved once in the
constructor). Nothing else about `resolveProject` / `loadStates` / `resolveStateId` changes —
each client still resolves exactly one project and one state map. This is the "nothing else
changes" ro asked for: the client is already single-project; we just tell it *which*.

### 3.4 Daemon: one poller + dispatcher per board

The daemon sees only OPS today because it holds one client (§1.4). To watch VID too, run a
poller per board, all feeding the **same** dispatcher (the dispatcher is board-agnostic —
it keys off canonical `TicketState`s and `Ticket.projectId`, which already distinguishes
boards). Concretely in `src/shell/v4-main.ts`:

- For each configured board, `createPlaneClient({config, board})` + `createPlanePoller`.
- Point all pollers' event streams at the one dispatcher.
- The dispatcher already carries `Ticket.projectId`, so when it writes state/comments back
  it must use the client for *that* ticket's board — pass a `client-for-board` resolver
  instead of a single `client`. (This is the one genuinely cross-cutting change; see
  risks §5.)

For a **v1 that ships fast**, an acceptable simplification is: only the **CLI/Concierge**
can file onto VID, and the daemon polls both boards but treats VID with the same generic
engine (see §4.2). Full per-board workflow automation is the richer follow-up.

---

## 4. The video-production workflow

ro wants `scripting → voiceover → render → review → published`, not the generic dev flow.
The tension: the dispatcher engine is hard-wired to **six canonical states** (§1.5), and a
`state_map` is a strict 1:1 (one canonical state → one Plane state name, via
`resolveStateId`). So there are two honest ways to deliver a video workflow, and this doc
recommends starting with the simpler one.

### 4.1 Option A — relabel + group (RECOMMENDED for v1)

Keep Beckett's six-state engine; give the VID **Plane project** a video-shaped set of
workflow states, and map the six canonical states onto them via `state_map`. The extra
video granularity that Beckett doesn't itself drive lives as Plane states in the *same
workflow group*, moved by humans/agents inside the "started" phase.

Proposed VID Plane states (with Plane's state *group* in parens) and the canonical mapping:

| VID Plane state | Plane group | Canonical `TicketState` | Who moves it |
|-----------------|-------------|--------------------------|--------------|
| Ideas           | backlog     | `backlog`                | Beckett (files here / holds on deps) |
| Scripting       | unstarted   | `todo`                   | Beckett (ready) → human/agent starts |
| Voiceover       | started     | *(→ `in_progress`)*      | human/agent (intra-production) |
| Render          | started     | *(→ `in_progress`)*      | human/agent (intra-production) |
| Production      | started     | `in_progress`            | Beckett (the state it sets/reads) |
| Review          | started/…   | `in_review`              | Beckett (spawns reviewer) |
| Published       | completed   | `done`                   | Beckett (terminal, publishes repo) |
| Shelved         | cancelled   | `cancelled`              | Beckett/human (terminal) |

Because `resolveStateId` maps a canonical state to **one** name, Beckett can only *set*
`Production` (not Voiceover/Render individually). `reverseState` maps UUID→canonical and
tolerates many-to-one, so humans moving a ticket into Voiceover or Render read back as
`in_progress` and the engine keeps working. Net: the board *looks* like a video pipeline to
humans; Beckett drives the coarse lifecycle; the fine production stages are human/agent
hand-offs. This is the literal "just a new table, pick where it goes" delivery.

**Transitions (Option A):** `Ideas → Scripting → (Voiceover ↔ Render) → Review → Published`,
with `Review → Scripting/Render` as the rework loop and `* → Shelved` as the abort. Beckett
sees only `backlog → todo → in_progress → in_review → done` (+ `cancelled`), i.e. the exact
dev transitions — the difference is purely the labels and the human-driven inner stages.

### 4.2 Option B — a real per-board state machine (follow-on)

If we later want Beckett to *drive* each video stage (e.g. auto-run a TTS worker on
Voiceover, a render worker on Render), we need genuinely more states than the six canonical
ones. That means:

- extend `TicketState` (or add a per-board `states` list + a transition graph in config),
- teach the dispatcher board-aware transitions (which stage spawns which worker; `render`
  is terminal-ish, `published` is done), and
- give `casting` video-shaped stage keys (`script`, `voiceover`, `render`) alongside
  `implement`/`review`.

This is substantially more invasive and touches the core state machine — explicitly **out
of scope for v1** and flagged as the larger follow-up. Recommend shipping Option A first,
learning from real video tickets, then deciding if Option B's automation is worth it.

### 4.3 How it differs from the generic dev flow

| | Dev (OPS) | Video (VID) |
|---|---|---|
| Prefix | `OPS-N` | `VID-N` |
| Unit of work | a code change in a repo | a video artifact |
| "In progress" means | a coding worker edits + commits | scripting/voiceover/render (human/agent) |
| "In review" means | adversarial diff review vs. criteria | watch-through / approval |
| "Done" means | merged, repo published to GitHub | video published |
| Rework loop | `in_review → in_progress` | `Review → Scripting/Render` |
| Beckett automation | full (implement + review workers) | coarse in v1 (Option A); per-stage later (Option B) |

---

## 5. Open questions & risks

1. **Does Beckett *produce* video, or just *track* it?** The whole shape depends on this.
   v1 (Option A) assumes track + coarse automation; if ro wants agents to actually write
   scripts / generate voiceover / render, that's Option B and a much bigger build.
2. **Dispatcher write-back is board-scoped.** Today one `client` is shared everywhere. Any
   multi-board daemon must route `setState`/`addComment` for a ticket to *its* board's
   client (via `Ticket.projectId`). This is the one real cross-cutting change and the most
   likely source of a "wrote to the wrong board" bug — needs a test.
3. **Strict config validation.** `ConfigSchema` is `.strict()` and boots loudly on unknown
   keys. The boards migration must either keep accepting the flat `[plane]` shape as a
   deprecated alias or ship the config.toml change and the code change in the *same deploy*
   (the repo already treats schema/example drift as a failing test — see
   `defaultConfigToml`).
4. **`state_map` is 1:1.** Beckett can only *set* one Plane state per canonical state, so in
   Option A it can't move a ticket into Voiceover vs. Render itself — those are human/agent
   moves. If that's unacceptable, Option B is required.
5. **The VID Plane project must exist first.** Someone has to create the project in Plane
   (identifier `VID`) with the workflow states named exactly as `state_map` expects, and
   Beckett's API token must have access. `resolveProject` fails loudly if the slug doesn't
   match — good, but it's a manual prerequisite, not something the build ticket can do in
   code.
6. **Cross-board dependencies (`beckett plan`).** `blockedBy` uses ticket identifiers and
   the dependency-promotion logic looks up state by identifier. A VID ticket blocked by an
   OPS ticket (or vice-versa) needs the dispatcher to see both boards' tickets when it
   resolves blockers. Out of scope for v1 unless needed; note it.
7. **Concierge routing.** Deciding *when* to file to VID vs OPS is a Concierge/prompt
   concern, separate from the plumbing. This doc only guarantees the `--board` lever exists;
   teaching the Concierge to pull it is a follow-up.
8. **Poll cost.** N boards = N pollers = N× the (already cheap, `listIssueHeads`-based)
   sweeps every `poll_secs`. Fine for 2 boards; note it before someone adds ten.

---

## 6. Implementation outline (for the follow-up build ticket)

Roughly in dependency order. Each step is independently testable.

1. **Create the VID Plane project** (manual, prerequisite): project identifier `VID`,
   workflow states matching the chosen `state_map` (Option A names), token access verified.
2. **Config schema** (`src/config.ts`): introduce `[plane.boards.<name>]` +
   `default_board`; normalize the legacy flat `[plane]` into a single `ops` board for
   backward-compat; regenerate `deploy/config.toml.example` via
   `bun src/cli/beckett.ts config print-default`. Add schema tests for both shapes.
3. **Board-scoped client** (`src/plane/client.ts`): accept a `board` in `PlaneClientDeps`,
   read `project_slug`/`state_map` from that board. No change to resolve/load/state logic.
4. **CLI** (`src/cli/beckett.ts`): add `--board` to `ticket create` (and `plan` node
   `"board"` key); resolve to `default_board` when absent; loud error on unknown board;
   update the usage strings. Keep `--project` meaning the code repo (do not touch).
5. **Daemon** (`src/shell/v4-main.ts`): construct one client + poller per configured board;
   feed all pollers into the single dispatcher; give the dispatcher a board→client resolver
   keyed on `Ticket.projectId` for write-backs. (Or the v1 simplification in §3.4.)
6. **Tests:** a VID ticket files with a `VID-` identifier; `setState`/`reverseState`
   round-trip through the VID `state_map`; write-back lands on the right board; flat-config
   still boots.
7. **(Deferred — Option B):** per-board state machine + video-stage casting, only if v1
   shows we need Beckett to drive individual production stages.

### Files this build will touch

- `src/config.ts` — board map schema + legacy normalization
- `src/plane/client.ts` — board-scoped construction
- `src/cli/beckett.ts` — `--board` flag on `ticket create` / `plan`
- `src/shell/v4-main.ts` — per-board poller wiring + dispatcher board resolver
- `src/dispatch/dispatcher.ts` — board-aware write-backs (only if daemon watches VID)
- `deploy/config.toml.example` — regenerated
- tests alongside each of the above

Nothing in *this* ticket edits any of them — this is the design only.
