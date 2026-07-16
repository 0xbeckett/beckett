# Pre-merge review: PR #114 — `v5-daemon` → `main`

## Verdict: **GO** — behavior-preserving merge is safe; one real (non-blocking) extensibility defect should be a fast-follow ticket.

- **Reviewed:** 2026-07-15 (OPS-187, re-run of the OPS-186 review with the verdict committed to the repo this time)
- **Branch under review:** `v5-daemon` @ `2dbe844` (merge of `main` @ `181d6f6` into the 7-phase stack: phases 0, 1a, 1b, 1c, 2, 3, 4 + absorbed OPS-185 publisher fix)
- **Baseline:** `main` @ `6fad3f5`
- **Net diff:** 30 files, +8,082 / −2,912 (`git diff origin/main...origin/v5-daemon`)
- **Method:** full net-diff read; four parallel adversarial deep-reviews (CLI registry, config composition, concierge bus router + prompt blocks, dispatcher stage registry); merge-overlap archaeology on the OPS-185 fix; type check + targeted suites on the merged tree; **cross-run of the v5 characterization suites against `main`'s own code** to prove the safety net pins baseline behavior rather than snapshotting the new implementation.

---

## 1. Check results

### Type check

| Check | Result |
|---|---|
| `bun x tsc --noEmit` (merged tree @ `2dbe844`) | **PASS** (exit 0, no errors) |

### Test suites (merged tree @ `2dbe844`)

| Suite | Result |
|---|---|
| `src/cli/characterization.test.ts` | **PASS** — 133/133 |
| `src/concierge/bus-characterization.test.ts` | **PASS** — 21/21 |
| `src/capability` (3 files) | **PASS** — 26/26 |
| `src/dispatch` (7 files) | **PASS** — 126/126 |
| `src/agency` (3 files) | **PASS** — 21/21 |
| `src/plane` (5 files) | **PASS** — 63/63 |
| **Total** | **390 pass / 0 fail** (169 snapshots, 915 assertions, 20 files) |

### Cross-run: v5 characterization suites executed against `main`'s code

The CLI + bus characterization tests and snapshots from `v5-daemon` were copied into a
pristine `main` checkout and run against the **old** implementation: **153/154 pass**.
The single failure is the default-TOML snapshot, which differs by exactly the four new
`[supervise]` knobs (`max_rework_cycles = 3`, `max_design_cycles = 2`,
`max_implement_retries = 3`, `max_review_infra_retries = 1`) — the one intentional,
disclosed behavior delta of the whole PR (snapshot rebaselined in `1d46155`, which touches
nothing else). This proves the characterization net genuinely pins `main`'s behavior: both
trees produce byte-identical output on all other 165 snapshots. Independent provenance
check agrees: the snapshots were recorded in Phase 0 commit `c1d49f0`, whose
`src/cli/beckett.ts` and concierge cascade are byte-identical to `origin/main`, and the
test files are unchanged since.

---

## 2. Capability preservation — CONFIRMED, nothing dropped

Explicit confirmation: **no command, bus route, config field, or prompt block was dropped
or semantically changed vs baseline.** The only observable behavior delta anywhere is
`beckett config print-default` emitting the four new `[supervise]` lines (intentional,
Phase 3).

- **CLI: all 31 command groups preserved** (mail, recall, spend, memory, journal, identity,
  gh, dns, secret, deploy, image, eval, site deploy, access, maintainer, federation,
  channels, task, ticket, preset, plan, status, doctor, config print-default,
  discord reply/decline, proactivity, quick, rpc status, reload, persona). Verified by
  mechanical multiset line-diff of `main`'s `src/cli/beckett.ts` against the v5
  `beckett.ts` + `io.ts` + 6 capability modules: every moved line accounted for. Env vars,
  flag defaults (dns proxied/CNAME, mail limit 20, pr merge squash, secret port 8799,
  channels limits 8/30, etc.), exit codes, usage/error strings, and the composed help text
  are byte-identical to `main`.
- **Bus: all 19 concierge routes preserved** (reload, persona, task.created, ticket.filed,
  status, ticket.restaff, ticket.courier, browser.eval, quick.run, quick.list,
  channels.wipe/list/search/recall, proactivity.status/set/off, discord.decline,
  discord.reply) — handler bodies line-identical to `main`'s cascade after registry
  scaffolding is stripped. Owner gate on `proactivity.set auto`, computer-use auth gates
  in `quick.run`, discord turn-claim/dedupe semantics, and the exact unknown-command
  refusal string are all intact. Registry lookup is a synchronous exact-name `Map.get`
  (no async race, no prototype-key hazard, duplicate registration throws).
- **Config: all 94 pre-existing leaf fields preserved** with identical defaults, types,
  validation (strictness per-section identical), section ordering, and error strings.
  Proof chain: the example-drift test pins `deploy/config.toml.example ==
  defaultConfigToml()` on both branches, and the example's diff is exactly the +4 knob
  lines. The four new knobs' defaults match the old hardcoded dispatcher constants
  (3/2/3/1) and every consumer keeps the same comparison-operator direction
  (`>=`, `<`, `<=`, `<=`), so boundary semantics are unchanged.
- **Prompt blocks: all 3 worker-persona blocks preserved in order** (github publishing
  guidance → design-only line → deploy durability recipe, priorities 10/20/30).
  Empirically executed old concatenation vs new composed path: **byte-identical in all
  four stage×deploy combinations**. No other capability module contributes a prompt block,
  so nothing new leaks into worker personas.
- **Dispatcher: all ~30 state-machine transition paths preserved** (11 event routes, all
  finish handlers, spawn-failure/backoff ladder, stall ladder, restaff, promotion,
  outboxes, checkpoint loop, crash recovery). Retry counters mutate and persist in the
  same order; no new `await` between spawn dedup reservation and `spawnGuarded` (no new
  double-spawn window); unknown-stage fallbacks match old behavior.

## 3. OPS-185 / phase merge overlap — semantically coherent

The merge `2dbe844` re-absorbed the OPS-185 publisher fix (non-main `targetBranch` publish
funnel) into the refactored branch. Verified beyond textual cleanliness:

- `src/plane/cast.ts`, `src/agency/index.ts`, `src/plane/client.ts`, `src/plane/types.ts`,
  `src/shell/v4-main.ts` are **byte-identical to `main`** in the merged tree — the fix
  (TARGET_BRANCH fence parsing/validation/serialization, `pushToBranch`,
  `integrationTarget`) survives verbatim.
- All four OPS-185 touchpoints in the refactored `src/dispatch/dispatcher.ts` survive:
  deps type (`:159`), ticket field (`:418`), both publish call sites spreading
  `ticket.targetBranch` (`:2429`, `:2601`), and the compare-link base (`:2498`). The stage
  registry did **not** duplicate the publish path (no `targetBranch` handling needed in
  `stages.ts` — publishing stayed in the dispatcher), so there is no second, stale copy.
- The OPS-185 tests added by the merge (`publish.test.ts` +53, `cast.test.ts` +39,
  `dispatcher.test.ts` +29) all pass on the merged tree.

## 4. Findings

No blockers. One major (extensibility defect, not a behavior regression — the production
path is unaffected). Ratings: **real** = verified against the code; **uncertain** =
plausible but depends on conditions not currently reachable.

### Major

1. **[real] `spawnWorker` ignores the dispatcher's injected stage registry (split-brain seam).**
   `src/dispatch/dispatcher.ts:139` accepts `deps.stages?: StageRegistry` and `:566` uses
   it for staffing/casting/finish handling, but `src/dispatch/spawn.ts:406-407` builds the
   worker prompt and system append from the module-level singleton `stageRegistry` —
   `doSpawn` never passes `this.stages` through. A stage registered only on an injected
   registry is staffed and finish-handled by its definition, yet its worker silently
   receives the generic fallback prompt/persona. **No production impact today** (the
   daemon uses the default registry), but it half-wires the refactor's own extension
   contract. *Fix:* add `stages: StageRegistry` to `SpawnWorkerArgs` and pass
   `this.stages` from the dispatcher, or delete the `deps.stages` override so exactly one
   registry exists. Recommend a fast-follow ticket; not a merge blocker.

### Minor

2. **[real] `src/dispatch/stages.ts:275-280` — `register()` guards duplicate stage names but not duplicate `entryState`.**
   Two stages claiming `entryState: "in_progress"` register fine and `forState`
   (`:288-293`) silently returns the first. *Fix:* collision-check `entryState` in
   `register()`.
3. **[real] `src/dispatch/dispatcher.ts:1065`, `:2828` — a stage registered with a held/terminal `entryState` (`todo`/`backlog`/`design_review`/`done`/`cancelled`) would bypass park/done/cancel handling** and break spawn-retry cancellation. Unreachable with the four built-ins. *Fix:* assert at `register()` that `entryState` is a staffable state.
4. **[real] `src/cli/beckett.ts:1645` — `hit.verb.run!(…)` non-null assertion on an optional field**; a verb registered without a handler dies with a raw TypeError instead of a clean failure. *Fix:* explicit guard with a `fail(...)` message (same pattern applies at `src/concierge/index.ts:2858` for `hit.command.handle!`).
5. **[real] `src/capability/index.ts:284-291` — `resolveCliVerb` caps verb matching at 2 tokens** while `register()` accepts any depth; a future 3-token verb would silently never match. *Fix:* reject >2-token names at registration or derive the cap from the longest registered name.
6. **[real] `src/dispatch/stages.ts:66-71` — `retryCapsFor`'s `?? 3/2/3/1` fallbacks duplicate the schema defaults**; drift seed if the schema changes. *Fix:* drop the fallbacks (the fields are non-optional on `Config["supervise"]`, `src/types.ts:632-643`).
7. **[real] `src/config.ts:96-98`, `:180`, `:191` — `composeConfigSchema` returns `z.ZodTypeAny` and `loadConfig` casts `as Config`**; the compile-time proof lives only in the `satisfies` clause on the builtin fragment table (`src/capability/builtins.ts:564`). A future non-builtin registry gets an unchecked cast. *Fix:* make the composition generic over the fragment table or validate only the builtin registry's typed schema.
8. **[uncertain] `src/capability/builtins.ts:575-592` — config-fragment capability ids collide with CLI capability ids** (`github`, `plane`, …). Safe today (two separate registries); merging them into one registry — the spine's stated end-state — will throw duplicate-id errors (loud, not silent). *Fix:* fold the config fragments into their feature modules or namespace them.
9. **[uncertain] `src/capability/modules/github.ts:125` — the github prompt block renders `""` when `ctx.slug` is falsy** and gets dropped, where old code emitted guidance with the empty slug interpolated. Requires an empty ticket identifier; unreachable in practice. No fix needed unless empty slugs are possible.
10. **[real] Test-coverage gaps in the safety net** (does not weaken this PR's verdict, since handler bodies are verbatim moves): CLI suite doesn't pin `identity set`/`memory remember`/`access grant` happy paths (`src/cli/characterization.test.ts`); bus suite never exercises token-correlated gates (owner-gate arm, computer-use gates, turn-claim) beyond their refusal paths (`src/concierge/bus-characterization.test.ts`); the persona snapshot covers 3 of 4 stage×deploy combos (`src/dispatch/__snapshots__/stages.test.ts.snap` — the missing design/no-deploy combo was verified byte-identical manually). *Fix:* add the listed hermetic cases and the fourth snapshot.
11. **[real, informational] Fleet-policy hardcodes remain in the dispatcher** — `recordSpend` only tracks `implement`/`review` (`src/dispatch/dispatcher.ts:2084`), the classed-failure ladder is implement-only, and `restaff`'s error text hardcodes the stage list (`:1293-1298`). Pre-existing behavior preserved exactly; noted because it bounds the "add a stage without touching dispatcher.ts" story.

## 5. Extensibility assessment

The registry seam is genuine: a new capability lights up CLI dispatch, help text, bus
commands, its own config slice, and a worker prompt block from one module
(`docs/extending-capabilities.md` matches the code), and a new stage resolves staffing,
casting, prompts, done-parsing, and finish handling through `stages.ts` without touching
the dispatcher's control flow. Three couplings temper it: the injected-registry path is
half-wired (finding 1), stage registration under-validates (findings 2–3), and shared
fleet policy still hardcodes stage names (finding 11). All are cheap follow-ups on top of
a sound surface.

## 6. Hard-to-reverse risks once merged + deployed

- **The four `[supervise]` knobs become public config surface.** Deployed configs may set
  them; renaming or re-semanticizing later is a breaking config change. Names and
  semantics look right — accept consciously.
- **`docs/extending-capabilities.md` + the `Capability`/`StageDefinition` shapes become
  the extension contract.** Post-merge shape changes break third-party modules. The
  duplicate-id collision (finding 8) is the one wart worth fixing before anyone builds on
  the merged registry.
- **The live daemon's dispatch state machine is swapped wholesale.** Mitigated: transition
  paths, counters, and persistence ordering verified equivalent; runtime-state maps are
  shared by reference so crash recovery reads the same shapes. Residual risk is confined
  to the uncovered token-correlated paths (finding 10); recommend a short observation
  window after deploy.
- **Repo hygiene (pre-existing on `main`, not this PR):** `main` @ `6fad3f5` carries two
  stray review snapshots under `.review/` (~4,000 lines) that will persist through the
  merge. Recommend a separate cleanup commit; do not fold it into this PR.

## 7. Bottom line

The refactor does what it claims: every command, route, config field, prompt block, and
dispatch transition on `main` is preserved (one disclosed additive config delta), the
characterization net provably pins baseline behavior on both trees, and the OPS-185
absorb is semantically coherent at all four dispatcher touchpoints. **GO for merge**, with
finding 1 (spawn/registry split-brain) filed as an immediate follow-up ticket.
