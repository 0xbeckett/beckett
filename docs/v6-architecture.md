# Beckett v6 — core boundary & the extension contract

> **Status: foundation design + skeleton (issue #82).** This is the architecture everything
> else in v6 migrates onto — the *structure*. Its sibling [`docs/v6.md`](v6.md) is the *thesis*
> (the SENSE→ATTEND→INTEND→ACT→LEARN→IMPROVE loop, the license, the milestones). Where v6.md
> says "memory is an extension" or "flows are data", this doc defines the one seam that makes
> those claims mechanical. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) remains authoritative for
> the running v5.x system until organs actually migrate.
>
> The code half of this ticket is the skeleton under [`src/ext/`](../src/ext/): the contract
> ([`contract.ts`](../src/ext/contract.ts)), the registry ([`registry.ts`](../src/ext/registry.ts)),
> and a trivial example extension ([`example.ts`](../src/ext/example.ts)) proving it dispatches.
> Nothing under `src/ext/` is wired into the live daemon. This ticket is the foundation, **not**
> the migration — the migration is filed separately once this lands.

---

## 1. The diagnosis: a half-finished spine, no seam for the @mention flow

The north star for v6 is Jason's, said repeatedly: the codebase is *"shoddily stacked on top of
stuff rather than plug n play."* That is not a vibe — it is visible in the tree. v5 already
*started* the unification the right way with the capability spine (`src/capability/index.ts`), but
the migration is explicitly half-finished, and two other plug-in mechanisms never joined it. The
real picture:

| Plug-in mechanism | File(s) | What plugs in | Status |
|---|---|---|---|
| **Capability spine** | `src/capability/index.ts` (one `CapabilityRegistry` class, instantiated 5×: CLI `cli/beckett.ts`, bus `concierge/index.ts`, stages `dispatch/stages.ts`, builtins `capability/builtins.ts`, config `config.ts`) | CLI verbs, bus commands, prompt blocks, config fragments — and worker stages, which are *built on top of* the same class | intended spine, **migration incomplete** |
| Agent registry | `src/agent/registry.ts` + `src/agent/store.ts` | a named worker persona (`agents.json`, live-reloaded) | separate mechanism (#66/#55) |
| Harness drivers | `src/drivers/index.ts` | a harness (claude/codex/pi) | separate mechanism (the original good seam) |

So it is not "four peer registries" — it is one good spine (`CapabilityRegistry`, which
`dispatch/stages.ts` already reuses via `new CapabilityRegistry()`) that **hasn't finished eating
the cascades it was built to replace**, plus two adjacent tables (agents, drivers) that never
joined, plus a scatter of ad-hoc stores (`src/hooks/registry.ts`, `src/routine/store.ts`,
`src/task/store.ts`, `src/discord/workspaces.ts`). The incompleteness is documented in the code
itself: `Concierge.onBusRequest` still notes that a bus command's `handle` "is optional on the
spine only so a declaration can exist before its body migrates out of a cascade"
(`src/concierge/index.ts`), and `cli/beckett.ts` is a 2,272-line file still carrying verb bodies
the spine was meant to absorb. **That half-migration is the stacking.**

The capability spine is genuinely good, but it only covers CLI/bus/prompt/config surfaces. It has
no notion of **lifecycle** (a stateful organ that owns a subprocess or an index), no **invocation**
entrypoint (how the concierge hands an @mention to an organ), and no **discovery catalog** (what an
organ advertises so the concierge can *route* to it). Those three gaps are exactly what the
@mention-first interaction flow needs and exactly what v6 adds — while *finishing* the unification
the spine started and pulling agents + drivers into it.

v6's answer is not another registry. It is **one** contract that finishes the spine and subsumes
the agents and drivers tables into it.

---

## 2. Definitions: what is "core", what is an "extension"

**The core is the invariant machine that must exist for Beckett to run and that everything else
plugs into.** It is the part you cannot remove without the daemon ceasing to be Beckett:

- the **daemon lifecycle** — boot, wiring, shutdown (`src/shell/main.ts`, `src/shell/control-bus.ts`);
- the **event ingress + routing** — Discord I/O and access gating (`src/discord/*`), and the
  perception/dispatch path that turns an event into a turn or a ticket;
- the **one Concierge** — the long-lived agent that owns voice and judgment (`src/concierge/*`).
  v6.md is emphatic and this doc holds the line: **one** agent owns voice and effort-sizing; no
  Chat/Concierge split;
- the **work substrate** — the shared queue and its projection (`src/tracker/*`, `src/bored/*`,
  `src/task/*`), the dispatcher state machine and worker spawning (`src/dispatch/dispatcher.ts`,
  `src/dispatch/spawn.ts`, `src/worker/worktree.ts`), and the harness drivers (`src/drivers/*`);
- the **license** — the action-class gate every outward action passes through (`src/agency/index.ts`);
- **config + types + logging** (`src/config.ts`, `src/types.ts`);
- and the **extension registry itself** (`src/ext/`, new in v6).

**An extension is a self-contained capability that plugs into the core through one contract.** It
declares what it can do, how it is invoked, its lifecycle, and its license posture — and the core
discovers and dispatches to it without any bespoke wiring. Memory, browser, social/publishing,
image, mail, github, secret, quick, routines — and, crucially, **worker stages and agent personas**
— are all extensions. An extension can be removed and the daemon still boots; the core cannot.

Two sharp consequences:

1. **Core organs register through the *same* contract**, tagged `kind: "core"`. The boundary is
   not "core is hand-wired, extensions use the registry." Everything uses the registry; the tag
   just marks what is load-bearing. That is what makes the boundary machine-checkable instead of
   a comment.
2. **The Concierge is core, but almost everything it *does* is reached through extensions.** The
   concierge's job shrinks to: perceive → size → **discover the right extension from the catalog**
   → dispatch → speak. It stops hard-coding "if browser, shell `beckett browser`; if memory,
   call recall." Slash commands are dead (Jason); discovery is the concierge reading capability
   descriptions and routing, never prefix-matching a command.

---

## 3. The one contract

The full types are in [`src/ext/contract.ts`](../src/ext/contract.ts); the shape:

```ts
interface Extension {
  manifest: {
    id: string;              // kebab-case registry key ("memory", "browser")
    version: string;         // for the v6 improve/rollback loop
    summary: string;
    actionClass: ActionClass;// default license posture (FREE / HANDSHAKE_GATED / ALWAYS_ASK)
    kind?: "core" | "extension";
  };

  // --- v6: discovery + dispatch (the plug-n-play core, NEW) ---
  capabilities?: ExtensionCapability[]; // { id, description, input?: ZodSchema, examples? }
  invoke?: (call, ctx) => Promise<ExtensionResult>;

  // --- v6: lifecycle (stateful organs, NEW) ---
  lifecycle?: { init?; start?; stop?; health? };

  // --- v5 facets, subsumed UNCHANGED ---
  cliVerbs?; busCommands?; promptBlock?; configSchema?; configKey?;
}
```

Four moving parts answer the four questions the ticket asks the contract to answer:

- **Lifecycle** — `lifecycle.{init,start,stop,health}`. Stateless organs (github, image) declare
  none. Stateful ones (memory holds retrieval indices; browser owns a host subprocess) implement
  what they need. The registry orchestrates `initAll`/`startAll`/`stopAll`/`health` in
  registration order (reverse for teardown), so `shell/main.ts` boots and drains extensions
  uniformly instead of hand-sequencing each organ's setup.
- **Invocation** — one `invoke(call, ctx)` entrypoint per extension. The registry validates the
  call (capability exists, args match the capability's zod `input`) *before* the body runs, so an
  organ never re-parses raw input. One entrypoint, not one method per action, is what lets the
  concierge dispatch generically.
- **Capabilities** — `capabilities[]`, each with a **natural-language `description`** and optional
  `examples`. This is machine-readable-for-an-LLM: it is what the concierge reads to decide *which*
  extension services an @mention. `actionClass` per capability overrides the manifest default.
- **Discovery / dispatch** — `ExtensionRegistry.catalog()` renders every advertised capability
  into a compact block the concierge folds into its system prompt; `ExtensionRegistry.invoke()`
  routes a chosen call to the owning extension. This *is* #55's "modular concierge prompting,"
  generalized from agents to every organ (see §6).

**Collision safety is kept from the capability spine.** `register()` refuses — loudly,
attributing both sides — a duplicate extension id, a duplicate capability id (global namespace),
a CLI-verb or bus-command clash, or two extensions claiming the same config key. An extension that
advertises a capability but declares no `invoke` is refused at registration, not at dispatch. The
existing characterization-snapshot discipline (`src/cli/characterization.test.ts`,
`src/concierge/bus-characterization.test.ts`) carries straight over: the migration is provable the
same way the v5 capability refactor was.

**The registry routes; it never widens a license.** `invoke()` deliberately does **not** call the
agency gate. Action-class enforcement stays in the core (`src/agency`), upstream of dispatch, per
v6.md's rule that no component may widen its own license. The registry resolves *what* to call; the
core decides *whether it may*.

---

## 4. Mapping the current codebase onto the split

Concrete, by real module. Three buckets: **core** (registers with `kind:"core"`, or is the spine
itself), **extension** (migrates onto the contract), **prune/merge** (dead or duplicated).

### Core — the invariant machine

| Module | Role |
|---|---|
| `src/shell/main.ts`, `src/shell/control-bus.ts` | daemon boot/wiring/shutdown; the CLI↔daemon socket |
| `src/discord/*` | event ingress + access gating (`access.ts` has redteam tests — stays core) |
| `src/concierge/*` | the one long-lived agent: voice, effort-sizing, ticket filing, ambient/triage, sessions |
| `src/tracker/*`, `src/bored/*`, `src/task/*` | the shared queue (the event bus) + user-facing projection |
| `src/dispatch/dispatcher.ts`, `spawn.ts`, `events.ts`, `advance-outbox.ts` | the state machine, worker spawning, telemetry ledger, durable outboxes |
| `src/worker/worktree.ts` | the only place that shells `git worktree`; scope-guard |
| `src/drivers/*` | harness driver registry (the original good seam) |
| `src/agency/index.ts` | the action-class gate — the security choke point (`classify()` is pure/total, fail-closed) |
| `src/config.ts`, `src/types.ts` | typed config + shared vocabulary |
| `src/ext/*` | **new** — the unified extension registry the above dispatch through |

### Extensions — migrate onto the contract

| Today | Becomes | Facets it declares |
|---|---|---|
| `src/memory/*`, `src/moss-local/*` | `memory` extension | lifecycle (index init + nightly `maintain`), capabilities (`memory.recall`, `memory.remember`), config, prompt block. **Zoom owns this lane in flight — see §7; do not touch it now.** |
| `src/browser/*` | `browser` extension | lifecycle (owns the host subprocess `isolated.ts`/`host.ts`), capabilities (`browser.exec`, `browser.task`), ALWAYS_ASK-ish posture on outward actions |
| `src/agency/{imagegen,cloudflare}.ts`, star/publish helpers, `capability/modules/*` | `image`, `dns`+`deploy`, `github`, `mail`, `secret`, `social` extensions | capabilities + existing config/prompt facets — most are *already* `Capability` modules, so this is a near-mechanical lift |
| `src/quick/*` | `quick` extension | capability (`quick.run`), no ticket — dispatched by the concierge, exactly the invoke path |
| `src/routine/*` | `routines` extension | lifecycle (`scheduler.ts` is a `start()` loop), capabilities (schedule/list), config |
| `src/dispatch/stages.ts` (`implement`/`review`/`design`/`design_check`) | worker-stage facet of extensions | a stage is an extension facet; `reviewStage` + `reviewTierFor` (`self` vs `fresh`) become data, enabling v6.md's per-ticket **flows** |
| `src/agent/*` (`agents.json` live registry) | agent-persona facet | **subsumed by the contract — see §6.** Keep the live-reload store; re-home the seam. |

Note the surprises the audit surfaced, now baked in above: **there is no `src/social/`** — the
"social/star/publishing" organ lives in `src/agency/*` (`setRepoStar`, `ensurePublished`) plus
`src/dispatch/publish-outbox.ts`. And **there is no standalone "review" module** — review is the
`reviewStage` in `src/dispatch/stages.ts`, gated by `reviewTierFor`. The migration order (§8)
names these by their real homes so nobody hunts for a directory that isn't there.

### Prune / merge

An audit pass (extension-aware importer counts, not a naive grep) found the tree is *less* dead
than it looks — most flagged directories are alive. The real targets:

- **Slash commands — a product cut, not yet reflected in code.** Jason: slash commands are dead as
  the interaction model (@mention is the flow). But the audit is unambiguous that the Discord
  slash surface is *fully live in code today*, so this must be pruned deliberately, not assumed
  gone. The concrete sites: `BECKETT_SLASH_COMMANDS` + `syncSlashCommands()` + the `onCommand`
  interaction routing in `src/discord/gateway.ts`; the `onCommand(command)` controller in
  `src/concierge/index.ts` (handling `task create`/`workspace`/`show`/`branch`/`stats`); the
  `onCommand`/`DiscordCommand` types in `src/types.ts`; and `src/concierge/commands.test.ts` (note:
  there is *no* `commands.ts` — the behavior lives in `concierge/index.ts`). Removing these is a
  **dedicated pre-v6 or Phase-4 ticket**, not part of this foundation, but the doc names the sites
  so the cut is scoped, not archaeological. (Unrelated: the `--disable-slash-commands` flag at
  `concierge/index.ts` disables the spawned `claude` CLI's *own* slash commands and stays.)
- **`src/code-stats/` — the one genuinely dead-ish module.** Zero importers inside `src/`; reached
  only by `scripts/ops/code-stats-harvest.ts` and the `code-stats:refresh` package script. It is a
  standalone maintenance tool the daemon never touches. If the feature is abandoned, prune the dir
  + its script + the package entry together. Everything else the north-star flagged (`bored`,
  `mail`, `moss-local`, `eval`, `test`) is alive with real importers — **do not prune those.**
- **Legacy on-disk shims, prunable once data is confirmed migrated:** `foldLegacyPlaneSection()`
  (`src/config.ts`, the OPS-191 Plane→tracker fold), the `x-shitpost` legacy routine shape
  (`src/routine/types.ts`, `plan.ts`), and the legacy single-session mode in
  `src/concierge/session-pool.ts`. These are back-compat only; each drops when no live box carries
  the old shape. Out of scope for this foundation; listed so they aren't forgotten.
- **Finish the half-migration, don't add a registry.** `src/capability/index.ts` is not deleted —
  it is the *ancestor* of `src/ext/`, and its facet types (`CliVerb`, `BusCommand`, `PromptBlock`)
  are imported by the contract verbatim. The prune here is the *cascades the spine never finished
  eating*: the remaining verb bodies in `cli/beckett.ts` and the `onBusRequest` handlers still
  living outside the registry (the code admits it). They collapse into extension `invoke`s during
  migration; the standalone `CapabilityRegistry` retires once its last consumer reads from the
  extension registry.
- **Deduplicate the three driver stream parsers.** `src/drivers/{claude,codex,pi}.ts` each hand-roll
  their own `switch (obj.type)` NDJSON frame parser over a shared `base.ts`. Merging the per-frame
  normalization into `drivers/base.ts` is a clean, contained speed/clarity win (see §8) — a driver
  is an extension facet in v6, and this dedup rides that migration.
- `src/rpc/daemon.ts` (Discord rich-presence "Playing Beckett") is a cosmetic side process, not in
  the routing path — it stays as-is, out of scope, neither core-critical nor an extension.

---

## 5. Reconciliation with #55 and the capability spine

**#55 (live agent registry + modular concierge prompting) is subsumed, not forked.** The extension
contract's discovery mechanism *is* modular concierge prompting generalized:

- #55's `LiveAgentRegistry` (`src/agent/registry.ts`) live-reloads `agents.json` so `beckett agent
  add/rm` needs no restart. **Keep that store and its live-reload semantics verbatim** — it is the
  backing store for the **agent-persona facet** of an extension. An "agent" is a named worker
  persona an extension (or the core cast machinery) can spawn; v6 does not reinvent it.
- #55's modular concierge prompting builds a discovery surface *for agents*. v6's
  `ExtensionRegistry.catalog()` builds the same surface *for every organ*. Where #55 renders "here
  are the agents you can cast," v6 renders "here are the capabilities you can dispatch to," and
  agents are one row-type among them.

**The reconciliation ask:** #55 should land its agent registry as-is, then re-home its concierge
prompting under `catalog()` rather than maintaining a second agent-only prompt composer. If #55 is
still mid-flight when the memory phase (§8) begins, the two do not collide — agents and memory are
different facets — but the *prompting* code should converge on one catalog. This doc flags it so we
reconcile deliberately instead of shipping two prompt composers.

The v5 **capability spine** (`src/capability/`) is the direct ancestor and stays load-bearing until
its consumers cut over. The contract imports its facet types; the migration lifts its modules, one
at a time, behind the same green characterization snapshots.

---

## 6. Phased migration order

Each phase is shippable and reversible on its own. Ordered by *lowest coupling to the hot path
first*, so the seam is proven on a leaf organ before anything load-bearing moves. Invocation never
breaks: `@beckett do X` works identically at every phase.

- **Phase 0 — this ticket.** Land `src/ext/` (contract + registry + example), typechecked and
  tested, wired into nothing. ✅
- **Phase 1 — `image` + `secret` (leaf, stateless).** Migrate the two simplest existing
  `Capability` modules onto the extension contract, add their `capabilities[]` + `invoke`, and have
  **one** live call site (`cli/beckett.ts`) read from the extension registry for them. Proves the
  seam end-to-end on organs that cannot break a turn. Characterization snapshots stay green.
- **Phase 2 — `browser`.** First stateful organ: `lifecycle.{init,start,stop,health}` wraps the
  host subprocess (`isolated.ts`/`host.ts`). The concierge dispatches to `browser.exec` via the
  catalog instead of shelling a hard-coded path. Proves lifecycle + health under the doctor.
- **Phase 3 — `quick` + `routines`.** `quick.run` through `invoke`; `routines` proves a `start()`
  background loop (`scheduler.ts`) under registry orchestration. Both are concierge-dispatched, not
  state-machine organs, so they exercise the invocation path without touching the dispatcher.
- **Phase 4 — `social`/`image`/`dns`/`deploy`/`github`/`mail` catalog cutover.** Move the remaining
  capability modules and retire the standalone `CapabilityRegistry`: the CLI, the bus, and the
  worker system append all read from `ExtensionRegistry`. Slash-command handling is pruned here;
  discovery is fully the catalog.
- **Phase 5 — worker stages become an extension facet.** `implement`/`review`/`design`/`design_check`
  register as stage facets; `reviewStage`/`reviewTierFor` become data. This is the enabler for
  v6.md's per-ticket **flows** (a DAG over registry stages) — but flows themselves are a separate
  v6.5 ticket. Accuracy guard: the four built-in stages migrate **byte-identical** (every comment,
  transition, cap default), the way v5.9 moved them into `stages.ts`.
- **Phase 6 — `memory`.** Last, and deliberately so: **Zoom owns the live memory/session lane**
  (retrieval, stale-session, reply-context injection) right now. Memory migrates onto the contract
  only after Zoom's in-flight work lands, and the migration is a pure re-home of an already-working
  organ (capabilities `memory.recall`/`memory.remember`, lifecycle around the index + nightly
  `maintain`), with visibility scoping unchanged and fail-closed (§7).
- **Concierge is never "migrated."** It is core. What changes is that it *reads the catalog and
  dispatches* instead of hard-coding each organ. That change rides Phases 1–4 incrementally (each
  organ it stops hard-coding), not a big-bang concierge rewrite.

---

## 7. The zoom / memory boundary (do-not-collide)

Zoom owns the live memory + session lane: retrieval, stale-session handling, reply-context
injection (`src/memory/*` recall path, `src/concierge/reply-context.ts`, session pooling). **This
ticket changes none of it.** The design treats memory as an extension and describes how it plugs
in (Phase 6), but the memory migration is explicitly *last* and *after* Zoom's work lands. Two
invariants the contract must preserve when memory finally migrates, both hard constraints:

- **Visibility scoping stays fail-closed and code-enforced.** `src/memory/*` enforces
  public/owner/dm audience scoping in code. The extension contract carries this as the memory
  extension's own concern, invoked *behind* the license gate — the registry does not flatten or
  bypass it. No "unified memory store" that drops the audience model (v6.md non-goal).
- **Recall never blocks a turn on writes.** The async write-behind property (v6.md § Learn) is a
  property of the memory extension's `invoke`, not something the registry can accidentally
  serialize. The dispatch path is `await registry.invoke(...)` for reads; writes stay
  fire-and-forget inside the extension.

---

## 8. Efficiency, speed, and the accuracy floor

Where the stacking costs latency or duplicated work today, and what the core design removes:

- **Per-organ hard-wiring on the concierge turn.** Today the concierge decides what to do by
  bespoke branching and shelling out to hard-coded paths (`beckett browser`, `beckett quick`).
  Every new organ adds branches to the hot path. The catalog + single `invoke` collapse that to one
  dispatch, and — because the catalog is data — the concierge's routing prompt is composed once, not
  re-hand-edited per organ. Fewer branches on the turn, less prompt drift.
- **Per-organ boot glue → one lifecycle.** Boot wiring in `shell/main.ts` hand-sequences each
  organ's setup; the doctor probes each organ its own way. `initAll`/`startAll`/`health` over one registry
  removes the per-organ boot glue and gives the doctor (and v6.md's post-deploy observation window)
  one uniform health surface instead of N bespoke probes.
- **Duplicated prompt/effort logic.** v5.9 already centralized `defaultEffortFor` after it was
  duplicated verbatim across `spawn.ts` and `dispatcher.ts`; the worker system append still composes
  capability prompt blocks. v6 makes that composition the *only* path (`registry.composePrompt`),
  killing the last string-surgery prompt builders. Prompt construction is currently scattered across
  `concierge/triage.ts`, `concierge/index.ts::composeSystemPrompt`, `memory/agent-recall.ts`,
  `dispatch/stages.ts`, `quick/index.ts`, and `browser/agent.ts` with no shared composer — the
  catalog + prompt-block composition give the concierge one.
- **Three hand-rolled driver stream parsers.** `src/drivers/{claude,codex,pi}.ts` each re-implement
  a `switch (obj.type)` NDJSON frame parser over the shared `base.ts`. That is triplicated
  normalization on the hottest path (every model frame). Folding it into `drivers/base.ts` removes
  the duplication with zero behavior change — a pure win, since the frames are already normalized
  identically three times.
- **Validation at the seam, not in every body.** Args are validated once by the registry against
  each capability's zod `input`, so organs stop re-parsing raw argv/bus payloads — less code, one
  place for the check.

**Accuracy is a hard constraint and nothing above trades it for speed.** Three explicit rejections:

1. **No skipping the license gate for latency.** `invoke()` routing is separate from
   `agency.classify()` enforcement precisely so speed work on dispatch can never accidentally
   bypass the gate. Fail-closed stays fail-closed.
2. **No collapsing the review tiers to go faster.** `reviewTierFor`'s `self` (low/medium, one pass)
   vs `fresh` (high/xhigh, separate reviewer) is an *accuracy* decision keyed to effort, not a speed
   knob. It migrates byte-identical in Phase 5; a "skip fresh review to shave latency" change would
   be rejected.
3. **No flattening memory visibility for a faster recall.** Fail-closed audience scoping is
   correctness, not overhead (§7).

Any future speed proposal that touches these three goes through v6.md's validate gate with the
golden-behavior suite, not through this refactor.

---

## 9. Non-goals (inherited from v6.md, restated for the boundary)

- **No Chat/Concierge split.** One agent owns voice and judgment. The contract makes the concierge
  *thinner* (it dispatches to extensions) without splitting it.
- **No new registry.** v6 *removes* registries by finishing the capability spine and folding the
  agents + drivers tables into it; it does not add another.
- **No big-bang.** Organs migrate one phase at a time, each shippable, behind green snapshots.
- **No self-widening license.** The registry routes; the agency gate decides. They stay separate.
- **No unified-memory flattening.** Working context, the knowledge graph, and lessons keep their
  different lifetimes and audiences; visibility scoping stays fail-closed.
