# Beckett cohesion & performance audit — Kimi K3

## Verdict

Beckett is **not** "all over the place" at the level of bones. The load-bearing seams are
real and mostly honored: one driver base class (`src/drivers/base.ts`), one consolidated
one-shot lane seam (`src/drivers/lane.ts`), one env-stripping rule (`src/env.ts`), one chunker
(`src/discord/chunk.ts`), one config composition root (`src/capability/builtins.ts`).
`bun x tsc --noEmit` is clean, and the perf basics people usually get wrong (preflight
caching at `src/drivers/index.ts:117-127`, preflight/git overlap at
`src/dispatch/dispatcher.ts:2196-2255`, warm memory store served over the bus at
`src/capability/modules/memory.ts:295-300`) are already done.

The "all over the place" feeling comes from three specific things, all provable:

1. **Two half-finished migrations running in parallel** — v5 `CapabilityRegistry` vs v6
   `ExtensionRegistry` with a compat bridge (`src/ext/compat.ts:24`), and the claude→pi
   fleet move that left codex half-retired and three spawn sites bypassing the new lane seam.
2. **Comment archaeology** — 293 live references to spec numbers whose specs are explicitly
   archived ("not to be used as an implementation contract", `specs/README.md`), 648 inline
   issue/ticket references (191 distinct), and a self-declared "frozen contract"
   (`src/types.ts:3`) whose anchored types mostly no longer exist.
3. **Three god-files** — `src/concierge/index.ts` (6,626 LOC; the daemon's entire control
   bus lives inside the chat agent), `src/dispatch/dispatcher.ts` (4,088 LOC, ~55 fields),
   `src/shell/main.ts` (1,037 LOC, ~80 imports).

All three are accretion damage, and all three are fixable by extraction, not rewrite.

## Top 10 findings

### 1. Two plugin registries coexist: v5 `Capability` vs v6 `Extension`, bridged by a lossy projection

- **Where**: `src/capability/index.ts:1-28` (v5 spine), `src/ext/registry.ts` + `src/ext/contract.ts` (v6),
  `src/ext/compat.ts:24-36` (`asCapability` bridge), `src/shell/main.ts:396-621` (organs registered on the
  v6 registry), `src/concierge/index.ts:1775` (the v5 `busRegistry` still serving the bus),
  `src/config.ts:91-102` (config schema composed from the v5 registry).
- **What**: Every organ conceptually exists twice. Organs register on the v6 `ExtensionRegistry` in
  `main.ts`, but the control bus still walks a v5 `CapabilityRegistry` populated by
  `Concierge.buildBusCapabilities`, and config is composed from a third, builtin-only v5 registry
  (`builtinCapabilityRegistry()` at `src/capability/builtins.ts:684`). `asCapability` is explicitly
  "deliberately lossy in ONE direction" (`src/ext/compat.ts:14-17`): v6-native facets silently vanish
  for any surface still reading v5.
- **Evidence**: `grep -rn "new ExtensionRegistry\|new CapabilityRegistry" src` → three live registry
  instances (`src/shell/main.ts:396`, `src/concierge/index.ts:1775`, `src/dispatch/stages.ts:451,917`).
  The v6 contract's own header admits the migration is "phase by phase" (`src/ext/index.ts:6-9`); the v5
  header still says "BOTH entrypoints dispatch through this registry now" (`src/capability/index.ts:20-26`)
  — both claims are true at once, which is the problem.
- **Fix**: Finish the v6 cutover in the order the bridge already anticipates: (a) move the 36 hand-declared
  bus capabilities out of `Concierge` into their organ extensions' `busCommands` facets; (b) point
  `onBusRequest` at the `ExtensionRegistry`; (c) point `composeConfigSchema` at extension `configSchema`
  fragments; (d) delete `src/ext/compat.ts` and `src/capability/` as the bridge header instructs
  ("When Phase 4 retires the standalone CapabilityRegistry, this file goes with it", `src/ext/compat.ts:17-18`).
- **Size**: L, but decomposable into independently landable per-organ steps; mechanical per organ, judgment
  only for the config-schema swap (characterization snapshots at `src/cli/characterization.test.ts` and
  `src/concierge/bus-characterization.test.ts` pin the observable contract, so each step is verifiable).

### 2. The daemon's control plane lives inside the chat agent: `src/concierge/index.ts` is a 6.6k-LOC god-file

- **Where**: `src/concierge/index.ts` — class `Concierge` spans lines 1716-5939 (~4.2k LOC);
  `buildBusCapabilities` spans 3159-4208 and declares 36 bus commands inline;
  `onBusRequest` at 4208; twelve late-bound setter injections at 2149-2729
  (`setDispatcherOps`, `setRoutineOps`, `setAgentRegistry`, `setStatusProvider`,
  `setExtensionRegistry`, `setMemoryStore`, `setTicketFiledListener`, `setPrWatchRegistrar`,
  `setQuickRunner`, `setBrowserRuntime`, `setBrowserAgent`, `setBranchStatusProvider`);
  plus unrelated free functions at 5943-6626 (release notes, git helpers, persona seeding,
  ~40 framing/formatting helpers).
- **What**: The file is simultaneously (a) the multi-turn `claude` session driver (`ConciergeSession`,
  585-1607), (b) the Discord turn assembler, (c) the daemon's entire control-bus command surface,
  (d) the changelog/release-note generator, (e) the persona/doctrine store, (f) the cross-channel
  context renderer. Its own header (lines 3-14) describes only (a) and (b) — the file outgrew its
  stated job by ~4k lines. The 12 setters are a symptom: nothing can construct a `Concierge` whole,
  so `main.ts` mutates it into completeness across 300 lines of boot.
- **Evidence**: `grep -c "name: \""` over lines 3159-4210 → 36 bus commands. `awk` on class
  boundaries → `Concierge` = 4,223 lines. Compare: the file's header says "It NEVER spawns workers —
  that is the dispatcher's job", yet the bus surface it hosts includes `ticket.restaff`,
  `ticket.courier`, `quick.run`, `browser.*`, `memory.recall`, `channels.*` — the daemon's whole API.
- **Fix**: Extract in three moves, each behavior-pinned by `bus-characterization.test.ts`:
  (1) move `buildBusCapabilities`/`onBusRequest` into `src/shell/bus.ts` taking the 12 setter
  dependencies as a ctor struct (kills the setters too); (2) move release-notes/git/persona free
  functions to `src/concierge/announce.ts` and `src/concierge/persona.ts` (tests already exist under
  those names); (3) move the framing helpers (lines 6209-6626) to `src/concierge/framing.ts`.
  What remains is session + turn assembly, ~2.5k LOC.
- **Size**: M per move, mechanical; the only judgment is the dependency struct's shape.

### 3. The spec-anchor convention is dead, but 293 references still cite it as the contract

- **Where**: `src/types.ts:1-24` ("Anchored to the specs (see ./specs): Spec 00 – Spec 11");
  `specs/README.md` ("Everything in this folder is archived design history… not to be used as an
  implementation contract"); empty vestigial section headers in `src/types.ts` (SECTIONS 4, 5, 6, 7,
  9, 13, 15 at lines ~197-217, ~247, ~523, ~887).
- **What**: The codebase's single most-authoritative comment — the header of the self-declared
  "frozen contract" — anchors to 12 specs that the specs folder itself disowns. Worse, the specific
  types the header cites as anchored (`TaskState`, `Dag`, `Escalation`, `SmokeAlarm`,
  `AcceptanceCriteria`, `HaikuClassification`, `ReviewVerdict`, …) exist **nowhere** in `src/`.
  The sections that would hold them are empty banners. This is the header-comment convention's real
  cost: not the bytes, but that a stale banner reads as authority and actively misleads.
- **Evidence**: `grep -rln "Spec 0[0-9]\|Spec 1[0-2]" src --include='*.ts' | grep -v test | wc -l` → 26
  files, 293 references. `grep -r "\bDag\b" src` (and 15 sibling names) → 0 non-test files outside
  `types.ts`'s own header. `specs/` contains only `_legacy/`, `_legacy-v2/`, `_legacy-v3/`, `README.md`.
- **Fix**: (a) Rewrite the `types.ts` header to name `docs/ARCHITECTURE.md` as the contract and delete
  the empty section banners; (b) sweep the 293 `Spec NN §M` references: where the spec text is still the
  best statement of intent, re-anchor to `specs/_legacy/...` explicitly *as history* (the dispatcher
  already does this correctly at `src/dispatch/dispatcher.ts:82` and `:104` — "specs/_legacy-v3/V3.md");
  where it isn't, delete the citation and keep the rationale. Do NOT mass-delete the comments.
- **Size**: S for (a); M for (b), mechanical with spot judgment.

### 4. The lane seam consolidated one-shot spawns — and three call sites still hand-roll argv, with hardcoded models

- **Where**: the seam: `src/drivers/lane.ts:1-56` (built in #125 explicitly because "each of those four
  lanes hand-rolled its own `claude -p` argv"); the bypasses: `src/concierge/triage.ts:265-297`
  (`classifyViaClaude`), `src/memory/agent-recall.ts:324-360` (`claudeInvoker`) and `:387-420`
  (`piInvoker`), `src/concierge/channel-profiles.ts:77`. Hardcoded seats: `src/memory/agent-recall.ts:53-54`
  (`LUNA_MODEL = "gpt-5.6-luna"`, `HAIKU_MODEL`) with no config key.
- **What**: The exact drift #125 was created to stop continues outside the four lanes it covered. The
  triage classifier, the memory recall agent, and the channel profiler each construct their own
  `claude -p … --tools "" --no-session-persistence --safe-mode --disable-slash-commands --no-chrome`
  argv by hand. The memory agent additionally hardcodes its two model seats in source — a fleet model
  change (the #121/#85.1 scenario) requires editing `agent-recall.ts`, while every other lane moved to
  config. `piInvoker` also re-implements pi's PATH prefixing that `piChildPath` already owns
  (`src/drivers/pi.ts:172-173` vs `src/memory/agent-recall.ts` ~:378-381).
- **Evidence**: `grep -n '"-p"' src/concierge/triage.ts src/memory/agent-recall.ts src/concierge/channel-profiles.ts`
  → three independent spawn sites; `grep "buildLaneCommand"` shows the consolidated consumers
  (`src/dream/run.ts:41`, `src/quick/index.ts:19`, `src/agent/invoke.ts:32`, `src/browser/agent.ts:41`)
  — the seam works where it's used; it just isn't used everywhere the same shape occurs.
- **Fix**: Either widen `LaneName` with a `"triage" | "memory" | "profile"` seat each, or (smaller)
  extract the common one-shot `claude -p`/`pi -p` invocation from `lane.ts` into an exported
  `runOneShot(seat, {system, user, timeoutMs})` the three sites call. Move `LUNA_MODEL`/`HAIKU_MODEL`
  into config under the memory extension's fragment. Touches 4 files + `builtins.ts` + snapshots.
- **Size**: M, mostly mechanical; needs judgment on whether these are "lanes" (config-pinnable) or
  fixed internal seats (then at least dedupe the argv).

### 5. The same lenient JSON-extraction regex is implemented five times

- **Where**: `src/concierge/triage.ts:230-235`, `src/memory/agent-recall.ts:271-299` (`extractJsonObject`),
  `src/browser/agent.ts:1138-1150`, `src/drivers/pi.ts:1119-1135`, `src/eval/turn-decisions.ts:183`.
- **What**: The "raw JSON → ```json fence → last balanced `{…}`" fallback chain for pulling structured
  output out of a harness's final message is copy-pasted with minor drift (one has `\s*` before the
  closing fence, one is case-insensitive, the brace-slicing order differs). This is precisely the code
  whose edge cases matter (a model emitting trailing prose after the JSON) and whose five copies will
  diverge the next time someone fixes one.
- **Evidence**: `grep -rn '```(?:json)' src --include='*.ts' | grep -v test` → 5 hits;
  `grep -rn 'indexOf("{")\|lastIndexOf("}")' src` → the same 4 production sites.
- **Fix**: One exported `extractJsonObject(text): unknown | null` (the `agent-recall.ts:271` version is
  the most complete — promote it, e.g. to `src/json-extract.ts` or next to `parseLaneOutput` in
  `lane.ts`), re-point all five. Pure mechanical; each site has tests.
- **Size**: S, mechanical.

### 6. `channel-moss.ts` is an admitted copy of `memory/moss.ts` — and contains a literal NUL byte

- **Where**: `src/concierge/channel-moss.ts:8` ("This is the exact transplant of the memory subsystem's
  Moss wiring (`src/memory/moss.ts`)"); original at `src/memory/moss.ts:1-29`.
- **What**: The whole Moss lifecycle — open, reset-on-corrupt, content-hash diff-sync, hybrid
  dense+keyword scoring with the same `RANKING_SEMANTIC_WEIGHT = 0.75` (`src/memory/moss.ts:39` /
  `src/concierge/channel-moss.ts:37`) — exists twice, once for memory nodes, once for channel entries.
  The copy even inherits the same calibration commentary. Additionally, `channelDocId` embeds a literal
  NUL byte in the source (`src/concierge/channel-moss.ts:82`), which makes the entire file read as
  **binary** to grep/git tooling (`file src/concierge/channel-moss.ts` → "data"; every grep in this
  audit printed "binary file matches").
- **Evidence**: side-by-side headers and constants; `python3 -c` byte scan → 1 NUL at byte 4085, in the
  template literal `` `${channelId}\x00${messageId}` `` written as a raw NUL instead of `\0`.
- **Fix**: (a) one-line: write the separator as an escape (`"\0"`) so the file is text again.
  (b) Extract the shared Moss lifecycle into `src/moss-local/sync.ts` parameterized on
  `docId/text/exists` — both call sites keep their gating differences (visibility is enforced outside
  Moss in both, by design). (b) is optional; (a) is not.
- **Size**: S for (a), M for (b), (b) needs judgment on the parameterization seam.

### 7. The concierge doctrine system prompt has tripled since the last token audit — 56KB (~14k tokens) per session launch

- **Where**: `src/concierge/concierge.md` (914 lines, 56,240 chars); composed per launch at
  `src/concierge/index.ts:1572-1598` (`composeSystemPrompt`) and appended at `:1080-1081`; session
  rotation re-pays it at `rotate_at_tokens` default 160k (`src/capability/builtins.ts:541`).
- **What**: The doctrine is the cached prefix of every concierge session, so warm turns pay ~0.1× —
  that defense (from the OPS-43 audit) still holds. But the audit measured it at **18,660 chars ≈
  4,665 tokens**; it is now **56,240 chars ≈ 14k tokens**, 3× growth, *plus* five more blocks that
  didn't exist then: extension catalog, open-loops ledger, proposals queue, calibration bar, persona
  (`src/concierge/index.ts:1577-1596`). Every rotation/recycle/relaunch re-creates the cache (full
  price), and per-channel session scope (`concierge.session_scope = "channel"`) multiplies the number
  of live sessions that each carry this prefix. Beyond cost: 914 lines of operating doctrine is past
  the point where a model reliably attends to all of it.
- **Evidence**: `wc -c src/concierge/concierge.md` → 56,240; `docs/token-audit-ops-43.md` table row
  "`concierge.md` doctrine | ~4,665 … 18,660 chars ≈ 4,665 tokens". No config or test caps doctrine
  size — growth is unguarded.
- **Fix**: (a) Split `concierge.md` into a slim always-loaded core (voice, gates, ticket discipline —
  target ≤20k chars) and skill-doc-style on-demand sections the session reads when relevant (the repo
  already has the lazy skill-doc pattern; `src/capability/index.ts:17` cites it). (b) Add a doctrine
  size guard (a test asserting `< N` chars) so growth is a deliberate act. (c) Re-run the OPS-43-style
  audit per release; the bench infrastructure exists (`scripts/bench/startup.ts` is the model).
- **Size**: M, mostly judgment (what's core vs on-demand); the guard test is S.

### 8. Memory writes re-read the entire corpus 2-3× per operation

- **Where**: `src/memory/index.ts` — `rememberLocked` calls `buildGraph()` at :376 and again at :426
  ("Rebuild the graph from disk"); `maintain` calls it at :543, :567, :576; `buildGraph` at :707-730
  `readFileSync`s every markdown file in the store, synchronously.
- **What**: One `remember` = two full O(corpus) parse passes (dedup scan, write, rebuild-for-backlinks),
  plus a `graphStamp()` (`:692-704`) that `statSync`s every file on every warm recall. At hundreds of
  memory files this is hundreds of sync reads per write — and memory writes happen inside concierge
  turns, so this is turn latency. The recall side is already well optimized (warm graph + Moss handle,
  `:222-255`, `:304-309`); the write side was left behind.
- **Evidence**: `grep -n "buildGraph()" src/memory/index.ts` → 8 call sites, 2 inside a single
  `remember` path, 3 inside a single `maintain`. `buildGraph` body at :712-730 is a sync
  `readFileSync` loop over `listMarkdownFiles()`.
- **Fix**: Keep the parsed `rawCache` (already maintained at `:721`) and mutate the warm graph
  incrementally on write: after `atomicWrite`, patch the affected node/edges into the cached graph
  instead of rebuilding; reserve `buildGraph` for cold open and stamp-mismatch. `maintain`'s loop can
  rebuild once at the end. Touches `src/memory/index.ts` only; the memory test suite
  (`src/memory/memory.test.ts`, `edges.test.ts`) pins backlink behavior.
- **Size**: M, needs care (the invalidation comment at `:680-686` shows the author knows the race);
  not mechanical.

### 9. Synchronous filesystem I/O on the Discord ingest hot path; 16 files hand-roll the same atomic write

- **Where**: per-message append `src/concierge/channel-context.ts:594-599` (`mkdirSync` + `writeFileSync`
  per inbound Discord message); per-turn full watermark rewrite `src/concierge/channel-context.ts:388`
  (`persistWatermarks` rewrites all channels' watermarks on every `markSeen`); per-check sync reads in
  `src/discord/access.ts:48-49,181-182`, `src/discord/identity.ts:69-70`, `src/discord/peers.ts:40`.
  The tmp+rename atomic-write pattern is re-implemented in 16 files (e.g. `channel-context.ts:279-283`,
  `identity.ts:98-100`, `dispatcher.ts`, `advance-outbox.ts`, `publish-outbox.ts`, `proposal/store.ts`…).
- **What**: Every Discord message Beckett sees costs ≥1 synchronous write (plus a watermark rewrite per
  turn) on the daemon's event loop, and every "who is this user" check (access, identity, maintainer,
  peers) re-reads and re-parses its file synchronously — inside turn handling. Bun makes this
  survivable at current scale; it is still 394 sync-fs call sites across non-test `src/` with no shared
  helper, so the atomic-write invariant (tmp + rename) is re-derived, and can be gotten wrong, 16 times.
- **Evidence**: `grep -rln "tmp.*renameSync\|renameSync(tmp" src | grep -v test` → 16 files;
  `grep -c` sync fs builtins over non-test src → 394.
- **Fix**: Two small extractions, not an async crusade: (a) `src/fsutil.ts` exporting
  `writeFileAtomic(path, body)` and `readJsonFile(path)`; migrate the 16 sites mechanically.
  (b) Cache the four tiny id-files in memory with mtime-based reload (the memory subsystem's
  `graphStamp` pattern at `src/memory/index.ts:692` is the in-repo precedent), so per-message
  authorization is a memory read. Leave the per-message JSONL append sync — it's append-only and small.
- **Size**: S for (a), S for (b); both mechanical.

### 10. Vestigial surface: half-retired codex, legacy `[plane]` shim, hardcoded channel snowflakes, v4 naming

- **Where**: codex: declared "the REPLACEMENT for codex" in `src/drivers/pi.ts:7-8`, excluded from lanes
  (`src/types.ts:47-50`, `src/capability/builtins.ts:82-84`), yet still the third entry in the default
  `fallback_order` (`src/capability/builtins.ts:124-125`) with a 537-line driver. Legacy tracker shim:
  `[plane]`→`[tracker]` fold in `src/config.ts:143-154,196` for a backend removed in OPS-191 (the
  removal is documented at `src/types.ts` tracker comment and `src/tracker/client.ts:3-5`). Hardcoded
  instance-specific Discord channel IDs in source: `src/concierge/index.ts:140,178,1653`
  (`STARTUP_CHANNEL_ID`/`CARDS_CHANNEL_ID`/`DISPATCH_EVENT_CHANNEL_ID` — the same snowflake twice,
  :140 and :1653). Naming: daemon logs "beckett v4 online" (`src/shell/main.ts`) and the run script is
  `v4` (`package.json`) at version 6.14.0.
- **What**: Each item is small; together they are exactly the "which of these is real?" tax the owner
  is feeling. A fork operator cannot tell whether codex is supported (it's in the fallback chain), what
  `[plane]` does (nothing, but it's still parsed), or whether the hardcoded snowflakes are theirs
  (they're not — they belong to the original instance, and the config schema has a proper
  `announce.changes_channel_id` pattern for exactly this).
- **Evidence**: citations above; `grep -rn "1525690195234521179\|1520658476974735490" src` → 3 source
  hits; the OPS-43 audit's file references (`src/plane/poll.ts`) no longer exist, confirming the
  backend is gone while its config shim lives on.
- **Fix**: (a) Decide codex: either remove it from the default `fallback_order` and mark the driver
  deprecated in its header, or delete driver + config block (the harness registry makes this a
  one-line registration removal plus schema); keep `[plane]` folding for one more release with a
  loud deprecation warning, then delete `foldLegacyPlane` (`src/config.ts:150-156`). (b) Move the
  three channel IDs into config (the `announce.changes_channel_id` pattern) with the current values
  as this instance's config, not source defaults. (c) Rename the log line/script to match version 6 —
  or pin "v4" as a deliberate product name in the README; today it's just drift.
- **Size**: S each, mechanical except the codex decision (judgment, one paragraph of ADR).

## Duplication inventory

| Concept | Implementations | Files | Recommended home |
|---|---|---|---|
| One-shot harness argv/env (`claude -p` / `pi -p` ask-and-exit) | 4: lane seam + 3 hand-rolled | `src/drivers/lane.ts`; `src/concierge/triage.ts:265`; `src/memory/agent-recall.ts:324,387`; `src/concierge/channel-profiles.ts:77` | `src/drivers/lane.ts` (export a `runOneShot`) |
| Lenient JSON extraction (fence → balanced braces) | 5 | `src/concierge/triage.ts:230`; `src/memory/agent-recall.ts:271`; `src/browser/agent.ts:1138`; `src/drivers/pi.ts:1119`; `src/eval/turn-decisions.ts:183` | new `src/json-extract.ts` (promote agent-recall's) |
| Moss index lifecycle (open/reset/diff-sync/hybrid score) | 2, one an admitted copy | `src/memory/moss.ts`; `src/concierge/channel-moss.ts:8` | `src/moss-local/` shared sync helper |
| Plugin registry (CLI verbs, bus commands, config fragments, prompt blocks) | 2 + lossy bridge | `src/capability/index.ts`; `src/ext/registry.ts`; `src/ext/compat.ts:24` | `src/ext/` (finish v6) |
| Atomic tmp+rename file write | 16 files | e.g. `src/concierge/channel-context.ts:279-283`; `src/discord/identity.ts:98-100`; `src/dispatch/advance-outbox.ts`; `src/proposal/store.ts` | new `src/fsutil.ts` |
| Poller skeleton (interval + `poke` coalescing) | 3 (two near-verbatim) | `src/tracker/poll.ts:395-397,409-413`; `src/github/poll.ts:507-512,526-528`; `src/mail/listener.ts:109-116` | shared `src/poller.ts` base (small; do only if a 4th appears) |
| Tiny id-file stores (load/parse/save lines or JSON) | 4+ | `src/discord/access.ts`, `maintainers.ts`, `peers.ts`, `identity.ts` | shared cached kv helper + `fsutil` |
| pi PATH prefix (`~/.local/bin:~/.bun/bin`) | 2 | `src/drivers/pi.ts:172-173`; `src/memory/agent-recall.ts` (~:378-381) | `src/env.ts` |
| English stopword list | 2 | `src/memory/search.ts:30-47`; `src/moss-local` `STOP_WORDS` (used at `src/concierge/index.ts:102,6365`) | `src/moss-local` |
| Per-harness "thinking/effort" flag mapping | 3 (justified per-driver, but the lane table duplicates it) | `src/drivers/claude.ts:331-334`; `src/drivers/pi.ts:536-538`; `src/drivers/codex.ts:274`; table at `src/drivers/lane.ts:25-42` | keep as-is (documented deliberate divergence) |

## Performance findings (with cost mechanism)

1. **Doctrine prefix 3× growth → cache-create cost and attention dilution.** Mechanism: every
   concierge session launch/rotation re-sends the composed system prompt uncached; at 56k chars × N
   channel-scoped sessions × rotations at 160k summed input tokens (`src/capability/builtins.ts:541`),
   this is a recurring full-price ~14k-token write per session, on top of five new per-launch blocks
   (`src/concierge/index.ts:1577-1596`). See finding 7.
2. **Memory write amplification.** Mechanism: 2-3 full-corpus sync re-parses per write
   (`src/memory/index.ts:376,426,543,567,576` + sync loop at :712-730). Turn latency, grows linearly
   with store size. See finding 8.
3. **Sync fs per Discord message + per authz check.** Mechanism: event-loop stalls on the ingest path
   (`src/concierge/channel-context.ts:594`, `:388`; `src/discord/access.ts:48`; `identity.ts:69`).
   Small today, unbounded with message rate. See finding 9.
4. **Boot is almost entirely serial.** `src/shell/main.ts:741-940`: `concierge.start()` →
   `statusDashboard.start()` → `replayAdvances` → `replayPublishes` → `reconcileDependents` →
   `recoverFromCrash` → extension sweeps → pollers, mostly `await`ed one at a time. Much of the
   ordering is genuinely load-bearing (recovery before staffing, pollers last — the comments say why),
   but `statusDashboard.start()` (:796), the PR re-watch loop (:799-824), and the AgentMail poller
   (:885-906) are independent and could overlap recovery. Expected win: seconds on cold boot, not
   minutes — low priority.
5. **Ambient triage spawns a fresh CLI per candidate burst.** Mechanism: `classifyViaClaude`
   (`src/concierge/triage.ts:265`) pays CLI process startup + model RTT per triage decision (this is
   inherent to the "subscription CLIs only" constraint, and Cerebras is offered as the fast path,
   `src/concierge/triage.ts:308+`). Worth noting only because finding 4's dedup would make swapping
   seats config-driven here too.
6. **Minor: unbounded `ownCommentIds` growth.** `src/dispatch/dispatcher.ts:558,3982` adds every posted
   comment id and never evicts (the marker fallback at :3991 makes the set an optimization only).
   Megabytes over a long daemon lifetime; note, don't fix urgently.
7. **Already good (do not re-litigate):** CLI cold start is benched and lazy-routed
   (`scripts/bench/startup.ts:9-17`, `src/cli/spine.ts`); harness preflight is 5-min cached and
   overlapped with git provisioning (`src/drivers/index.ts:117-127`,
   `src/dispatch/dispatcher.ts:2196-2255`); warm memory recall is served over the bus so the CLI
   doesn't rebuild the graph per call (`src/capability/modules/memory.ts:295-300`); per-turn context
   injection is hard-budgeted with separate budgets per block
   (`src/concierge/index.ts:5186-5253`, `cross_channel_budget_tokens`).

## Sequenced cleanup plan

Each step is independently landable and testable; ordered cheapest-and-safest first.

1. **Fix the NUL byte in `src/concierge/channel-moss.ts:82`** (write `"\0"` as an escape). One line;
   restores grep/git text tooling on the file.
2. **Extract `extractJsonObject`** (finding 5). Five call-site swaps, all covered by existing tests.
3. **Re-anchor `src/types.ts`** (finding 3a): new header naming `docs/ARCHITECTURE.md`, delete the
   empty SECTION banners. Then sweep the 293 spec references file-by-file, re-anchoring to
   `specs/_legacy/` explicitly-as-history where the rationale is still load-bearing.
4. **Extract `src/fsutil.ts` + migrate the 16 atomic-write sites; add mtime-cached id-file loads**
   (finding 9). Mechanical; add one fsutil unit test.
5. **Move hardcoded channel snowflakes to config** (finding 10b) and decide codex's status in writing
   (finding 10a); delete the `[plane]` fold after one deprecation cycle.
6. **Doctrine split + size guard** (finding 7): slim core + on-demand sections; add a
   `concierge.md`-size assertion test. Re-measure with an OPS-43-style audit to prove the delta.
7. **Consolidate the three hand-rolled one-shot spawns onto `lane.ts`** (finding 4), moving memory
   agent seats into config. Behavior-pinned by `triage.test.ts`, `agent-recall.test.ts`,
   `channel-profiles.test.ts`.
8. **Memory write-path incremental graph update** (finding 8). The riskiest perf change here; do it
   after the test suite is green on steps 1-7, with `memory.test.ts`/`edges.test.ts` as the gate.
9. **Extract the bus surface from `Concierge`** (finding 2, moves 1-3 in order). Each move gated by
   `bus-characterization.test.ts` snapshots staying byte-identical.
10. **Finish the v6 extension cutover** (finding 1): per-organ bus-command migration, then
    config-schema composition, then delete `src/ext/compat.ts` and the v5 spine. Lands last because
    steps 2 and 9 shrink what has to be migrated.

## What is actually GOOD and must not be "cleaned up"

- **The driver/lane split is correct and well-argued.** `src/drivers/lane.ts:16-23` explains precisely
  why one-shot lanes don't reuse `HarnessDriver` (a driver demands worktree/scope/envelope/done-schema;
  a lane has none) and consolidates exactly the part that drifted (per-harness CLI surface) while
  leaving lifecycle to the lanes. The side-by-side flag table (`lane.ts:25-42`) and the explicit
  `unsupported`-gap reporting instead of silent degradation are exemplary. The problem isn't the seam —
  it's the three sites that don't use it (finding 4).
- **`src/env.ts` is the model for how to kill duplication.** Its header even names the sin it replaced
  ("hand-copied six times across the tree", `src/env.ts:4`). One prefix-based rule, one allowlist with
  the reason attached (`ANTHROPIC_OAUTH_TOKEN`, `src/env.ts:29-34`).
- **`src/types.ts` as an implementation-free contract is genuinely good** — types, unions, interfaces,
  no logic, and the `Harness` open-union with registry inversion (`src/types.ts:32-38`) is exactly
  right. It's the *stale header and empty sections* that are the problem, not the file's discipline.
- **The fail-closed privacy architecture is consistent and deliberate**: Moss is never the authority
  (memory: `src/memory/moss.ts:9-13`; channels: `src/concierge/channel-moss.ts:16-19`), visibility is
  enforced in code on every hit, DM/guild boundaries are re-checked at every layer
  (`src/concierge/index.ts:5197-5203`). This repetition is *intentional defense in depth*, not drift.
- **The heavy header-comment convention is paying for itself where it documents *why*.** The pi.ts
  steering history (why `agent_settled` and not `agent_end`, `src/drivers/pi.ts:62-70`), the
  checkpoint race explanation (`src/memory/index.ts:680-686`), the "never weakens this default" notes —
  these are load-bearing institutional memory that prevented real bugs (several comments name the bug
  they prevent). At ~16.5% comment lines (18,948 of 115,062), the convention is a tax only where it
  (a) cites dead specs (finding 3) or (b) narrates ticket history instead of current truth. Keep the
  convention; fix the anchoring.
- **Characterization/snapshot suites as migration rails.** `src/cli/characterization.test.ts`,
  `src/concierge/bus-characterization.test.ts`, and the `__snapshots__` dirs mean every extraction
  above is provable byte-for-byte. This is what makes the cleanup plan safe without a rewrite.
- **Budgeted context injection.** The cross-channel block has its own token budget, repeat suppression,
  relevance floor, and DM gating (`src/concierge/index.ts:5186-5253`). This is the right way to grow
  prompt surface — contrast with the unguarded doctrine growth (finding 7).
- **Bus-first warm stores.** Memory recall over the control bus with cold-direct fallback
  (`src/capability/modules/memory.ts:295-308`) and the channels `busOrDirect` pattern
  (`src/cli/core.ts:656-702`) keep CLI invocations cheap without a second consistency model.

## Anti-recommendations

1. **"Rewrite the dispatcher as a generic state-machine library."** `src/dispatch/dispatcher.ts` is
   4,088 lines, but it is one coherent domain (staffing/retry/recovery lifecycle) with the outboxes
   already extracted (`advance-outbox.ts`, `publish-outbox.ts`). A generic FSM would lose the
   ticket-specific invariants the comments encode (e.g. spawn-cap discard race at :2415). Extract
   preview/screenshot wiring if anything; do not re-architect.
2. **"Delete the giant header comments / adopt a terse comment style repo-wide."** The headers that
   hurt are the stale anchors, not the rationale. Mass deletion would destroy the failure-mode
   knowledge (why `agent_settled`, why the NUL-separated doc id, why the prefix-strip env rule) that
   this codebase demonstrably relies on — several comments name the exact regression they prevent.
3. **"Merge v5 and v6 by making every call site dual-register."** That triples the registration
   surface. The bridge (`src/ext/compat.ts`) exists precisely so migration is one-directional; finish
   the migration instead of stabilizing the midpoint.
4. **"Move memory to SQLite / a vector DB."** Markdown-canonical with a derived, deletable index is a
   deliberate, stated decision (`src/memory/moss.ts:15-19`) that makes the store git-able,
   human-editable, and self-healing. The perf problems (finding 8) are incremental-update problems,
   not storage-engine problems.
5. **"Make all the sync fs async."** 394 sync call sites, most writing <1KB append-only records on a
   single-user daemon. Blanket async conversion churns everything for unmeasurable gain. Fix the two
   hot paths (finding 9) and leave the rest.
6. **"Fold `ConciergeSession` back into `ClaudeDriver` to remove the 'duplicated' spawn logic."** The
   header at `src/concierge/index.ts:18-26` explains the real semantic difference: the driver latches
   terminal on the first `result`; a chat session treats each `result` as a turn boundary. This is
   near-identical code with opposite lifecycle semantics — the classic case where dedup creates a
   worse abstraction.
7. **"Split `src/concierge/index.ts` mechanically by line count (e.g. every 500 lines)."** The file
   has real seams (bus surface / session / framing / release-notes). Split along those (finding 2);
   arbitrary cuts just move the incoherence.
8. **"Ban inline issue numbers in comments."** The 648 ticket references are often the only record of
   *why* a non-obvious decision exists (e.g. `ANTHROPIC_OAUTH_TOKEN`, `src/env.ts:14-21`). The fix for
   stale anchors is re-anchoring, not de-contextualizing.
