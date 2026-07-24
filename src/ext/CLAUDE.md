# Extension seam conventions (`src/ext/`)

The one v6 contract every organ migrates onto (docs/v6-architecture.md). Read this before
migrating an organ or touching the registry. Phase 1 (`image`, `secret` in
`src/capability/modules/`) is the reference implementation — copy its shape.

## Invariants — do not break these

- **`invoke` must never exit the process.** `out`/`fail` from `cli/io.ts` call
  `process.exit` — they are CLI-surface only. An extension's business logic lives in throwing
  cores; the CLI verb wrapper adapts throws to `fail` (via `main()`'s catch), `invoke` adapts
  them to `{ ok: false, error }`. The daemon will dispatch `invoke` in-process from Phase 2 on.
- **The registry routes; it never widens a license.** No agency/`classify()` calls inside
  `ExtensionRegistry.invoke` or any extension body reached through it — action-class
  enforcement stays in the core, upstream of dispatch.
- **Migration is behavior-preserving until Phase 4.** The CLI/bus surface of a migrating organ
  stays byte-identical: same messages, same ordering of checks, same exit codes. The
  characterization suites (`src/cli/characterization.test.ts`,
  `src/concierge/bus-characterization.test.ts`) are the proof — a red snapshot is a behavior
  change to call out, never something to regenerate silently.
- **Validation happens at the seam.** Every advertised capability gets a zod `input`; the
  registry validates before `invoke` runs, so extension bodies never re-parse raw input.
  Surface-specific parsing (argv flags) stays in the surface wrapper.
- **Capability descriptions are router prose.** The concierge reads them to route @mentions —
  write what the capability does AND when to reach for it, with `examples`. Not a usage string.
- **Fail-first preflight.** Env/credential checks run before any side effect (systemd writes,
  tunnel deploys), so a creds-less box refuses cleanly from every surface.

## Migrating an organ (the Phase 1 recipe)

1. Rewrite its module to export a `createXExtension: ExtensionFactory` — manifest
   (`version` from day one), `capabilities[]` + `invoke`, and the carried v5 facets
   (`cliVerbs`, `busCommands`, `promptBlock`, `configSchema`/`configKey`, `cliHelp`,
   `skillDoc`) unchanged.
2. Factor the business logic into throwing cores shared by the CLI wrapper and `invoke`.
   Keep every historical error message verbatim.
3. Keep the old `createXCapability` as `(deps) => asCapability(createXExtension(deps))` for
   the v5 factory table (`modules/index.ts`) until Phase 4 retires it.
4. Register the extension in the consuming surface's `ExtensionRegistry` and project it into
   the v5 spine slot with `asCapability` — same position, so help order is unchanged.
5. Stateful organs (Phase 2+) implement `lifecycle.{init,start,stop,health}`; stateless ones
   declare none. Teardown runs in reverse registration order.
6. Test: registration + catalog, invoke validation refusals, preflight refusal, projection
   shape (see `src/capability/modules/extensions.test.ts`), and run both characterization
   suites.

## Phase order (docs/v6-architecture.md §6)

0 skeleton ✅ · 1 image+secret ✅ · 2 browser (first lifecycle) · 3 quick+routines ·
4 catalog cutover + retire `CapabilityRegistry`/`asCapability` · 5 worker stages as facets ·
6 memory (last; only after the in-flight memory lane lands — visibility stays fail-closed,
recall never blocks a turn on writes).
