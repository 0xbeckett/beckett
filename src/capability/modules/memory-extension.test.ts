/**
 * V6 Phase 6 — the memory organ on the extension contract (docs/v6-architecture.md §6-§7).
 * Pins the LAST organ's re-home: init builds the daemon-owned warm store, start arms the
 * nightly maintain loop ONLY in the "late" sweep, stop is idempotent and settles write-behind
 * writes. Above all it pins the two §7 HARD constraints as code:
 *
 *   - ORIGIN-BOUND AUDIENCE (the wave-4 cautionary tale): the Audience for memory.recall /
 *     memory.remember is derived inside memory code from the token-derived call.origin —
 *     callers get NO viewer/viewerRole/context/by args (strict schemas refuse them loudly),
 *     a dm-scoped node NEVER surfaces to an ext.invoke call (context pins to "guild"),
 *     owner-scoped nodes surface only to the configured owner's origin id, and no origin
 *     means public-only.
 *   - RECALL NEVER BLOCKS ON WRITES: memory.remember is write-behind — invoke returns before
 *     the store write settles, and a pending write never blocks a recall invoke.
 *
 * The CLI facets stay pinned byte-for-byte here AND behaviorally by the CLI characterization
 * suite; `src/memory/*` engine internals are untouched by the migration and stay pinned by
 * their own suites (visibility.test.ts especially).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry, asCapability, type ExtensionContext } from "../../ext/index.ts";
import { createMemoryExtension, type MemoryExtension, type MemoryExtensionDeps } from "./memory.ts";
import { createMemory, type MemoryStore } from "../../memory/index.ts";
import type { MemoryNode, RememberIntent } from "../../types.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

const dirs: string[] = [];
const built: MemoryExtension[] = [];
afterEach(async () => {
  // Still any armed maintain timer (and settle write-behind tails) before the dirs go away.
  for (const ext of built.splice(0)) await ext.lifecycle!.stop!();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ctx(): ExtensionContext {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

/** A clean warm store over a temp tree — the same shape init builds, minus git. */
function tempStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-memory-ext-"));
  dirs.push(dir);
  return createMemory({ memoryDir: join(dir, "memory"), git: false, warm: true });
}

const OWNER = "999888777666555444";

function build(overrides: MemoryExtensionDeps = {}): {
  ext: MemoryExtension;
  deps: ExtensionContext;
  registry: ExtensionRegistry;
} {
  const deps = ctx();
  const ext = createMemoryExtension({
    ownerId: () => OWNER,
    createStore: () => tempStore(),
    // Never let a real cadence fire mid-test unless a test opts in.
    maintenanceInitialDelayMs: 60_000,
    maintenanceIntervalMs: 3_600_000,
    ...overrides,
  })(deps);
  built.push(ext);
  const registry = new ExtensionRegistry();
  registry.register(ext);
  return { ext, deps, registry };
}

async function seedScopedNodes(store: MemoryStore): Promise<void> {
  const base = { op: "create" as const, source: "manual" as const, reason: "test" };
  await store.remember({ ...base, name: "public-note", type: "reference", description: "a public fact about the plan" });
  await store.remember({
    ...base, name: "owner-note", type: "preference", description: "an owner-scoped fact about the plan",
    metadata: { visibility: "owner" },
  });
  await store.remember({
    ...base, name: "dm-note", type: "reference", description: "a dm-scoped fact about the plan",
    metadata: { visibility: "dm", dm_with: "111222333444555666" },
  });
}

const ALL_NAMES = "public-note,owner-note,dm-note";

function hitNames(data: unknown): string[] {
  return (data as { hits: Array<{ name: string }> }).hits.map((h) => h.name);
}

// ── registration + discovery ─────────────────────────────────────────────────────────────

test("memory registers as a core organ and advertises recall + remember with router prose", () => {
  const { ext, registry } = build();
  expect(ext.manifest.kind).toBe("core");
  const catalog = registry.catalog();
  expect(catalog.map((e) => e.capabilityId)).toEqual(["memory.recall", "memory.remember"]);
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
});

// ── lifecycle: init builds the warm store, start is late-only, stop is idempotent ────────

test("store() throws before init; init builds the one warm store the accessor returns", async () => {
  const { ext, deps, registry } = build();
  expect(() => ext.store()).toThrow("lifecycle.init has not run");
  await registry.initAll(deps);
  const store = ext.store();
  expect(store).toBeDefined();
  expect(ext.store()).toBe(store); // ONE store — accessors never rebuild
});

test("the maintain loop arms only in the LATE sweep and stop stills it (idempotently)", async () => {
  const { ext, deps, registry } = build();
  expect(ext.lifecycle!.startPhase).toBe("late");
  await registry.initAll(deps);

  await registry.startAll(deps, "early");
  expect((await registry.health())[0]).toMatchObject({ extensionId: "memory", ok: true });
  expect((await registry.health())[0]!.detail).toContain("maintenance idle");

  await registry.startAll(deps, "late");
  expect((await registry.health())[0]!.detail).toContain("maintenance scheduled");
  // Re-entry is a no-op; a second sweep must never arm a second timer.
  await registry.startAll(deps, "late");

  await registry.stopAll();
  expect((await registry.health())[0]!.detail).toContain("maintenance idle");
  await registry.stopAll(); // idempotent
});

test("the armed loop runs the store's maintain pass (the re-homed startRoutineMaintenance)", async () => {
  let passes = 0;
  let firstPass: (() => void) | null = null;
  const ran = new Promise<void>((resolve) => { firstPass = resolve; });
  const store = tempStore();
  const maintain = store.maintain.bind(store);
  store.maintain = async (opts) => {
    passes++;
    firstPass?.();
    return maintain(opts);
  };
  const { deps, registry } = build({ createStore: () => store, maintenanceInitialDelayMs: 1 });
  await registry.initAll(deps);
  await registry.startAll(deps, "late");
  await ran;
  expect(passes).toBeGreaterThanOrEqual(1);
});

test("health is a verdict, not a boot gate: pre-init reports not initialized", async () => {
  const { registry } = build();
  expect((await registry.health())[0]).toMatchObject({ ok: false, detail: "not initialized" });
});

// ── §7: origin-bound audience, derived in memory code ────────────────────────────────────

test("no origin ⇒ public only; a member origin id unlocks nothing more", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await seedScopedNodes(ext.store());

  const anonymous = await registry.invoke(
    { capabilityId: "memory.recall", args: { names: ALL_NAMES } },
    deps,
  );
  expect(anonymous.ok).toBeTrue();
  expect(hitNames(anonymous.data)).toEqual(["public-note"]);

  const member = await registry.invoke(
    {
      capabilityId: "memory.recall",
      args: { names: ALL_NAMES },
      origin: { surface: "discord", userId: "222333444555666777" },
    },
    deps,
  );
  expect(member.ok).toBeTrue();
  expect(hitNames(member.data)).toEqual(["public-note"]);
});

test("owner-scoped nodes surface ONLY to the configured owner's origin id", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await seedScopedNodes(ext.store());

  const owner = await registry.invoke(
    {
      capabilityId: "memory.recall",
      args: { names: ALL_NAMES },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(owner.ok).toBeTrue();
  const names = hitNames(owner.data);
  expect(names).toContain("public-note");
  expect(names).toContain("owner-note");
  // Even the owner never sees a DM fact through ext.invoke — context pins to "guild".
  expect(names).not.toContain("dm-note");
});

test("a dm-scoped node NEVER surfaces to an ext.invoke call — not even to its dm partner", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await seedScopedNodes(ext.store());

  const partner = await registry.invoke(
    {
      capabilityId: "memory.recall",
      args: { names: ALL_NAMES },
      origin: { surface: "discord", userId: "111222333444555666" },
    },
    deps,
  );
  expect(partner.ok).toBeTrue();
  expect(hitNames(partner.data)).toEqual(["public-note"]);

  // The node stays reachable where it belongs: the engine's own dm-context audience (the CLI
  // flag path) — proving the invoke restriction is the derivation, not a lost node.
  const dm = await ext.store().recall({
    text: "",
    filter: { names: ["dm-note"] },
    audience: { viewerId: "111222333444555666", viewerRole: "member", context: "dm" },
  });
  expect(dm.hits.map((h) => h.node.name)).toEqual(["dm-note"]);
});

test("caller-supplied audience args are refused loudly, never honored (wave-4 pin)", async () => {
  const { deps, registry } = build();
  await registry.initAll(deps);
  for (const smuggled of [
    { query: "plan", viewer: OWNER },
    { query: "plan", viewerRole: "owner" },
    { query: "plan", asSelf: true },
    { query: "plan", context: "dm" },
    { query: "plan", audience: { viewerRole: "owner" } },
  ]) {
    const r = await registry.invoke(
      { capabilityId: "memory.recall", args: smuggled as Record<string, unknown> },
      deps,
    );
    expect(r.ok).toBeFalse();
    expect(r.error).toContain("invalid args");
  }
});

// ── memory.remember: origin-stamped provenance, write-behind ─────────────────────────────

test("remember refuses without an authenticated origin and never takes a caller-supplied writer", async () => {
  const { deps, registry } = build();
  await registry.initAll(deps);

  const anonymous = await registry.invoke(
    { capabilityId: "memory.remember", args: { name: "a-fact", type: "reference", description: "x" } },
    deps,
  );
  expect(anonymous).toEqual({ ok: false, error: "memory.remember needs an authenticated authorized request" });

  // `by`/`source_user` are not part of the schema — strict refusal, not a silent strip.
  const smuggledBy = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "a-fact", type: "reference", description: "x", by: "123" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(smuggledBy.ok).toBeFalse();
  expect(smuggledBy.error).toContain("invalid args");
});

test("remember stamps source_user from the token-derived origin and commits write-behind", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);

  const r = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "learned-fact", type: "reference", description: "an origin-stamped fact" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(r.ok).toBeTrue();
  expect(r.data).toMatchObject({ accepted: "learned-fact", writeBehind: true });

  await ext.settled();
  const node = ext.store().buildGraph().nodes.get("learned-fact");
  expect(node).toBeDefined();
  expect(node!.metadata.source_user).toBe(OWNER);
});

test("remember keeps the engine's dm shape rule: visibility dm without dmWith refuses eagerly", async () => {
  const { deps, registry } = build();
  await registry.initAll(deps);
  const r = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "a-dm-fact", type: "reference", description: "x", visibility: "dm" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(r.ok).toBeFalse();
  expect(r.error).toContain("--visibility dm requires --dm-with");
});

// ── fail-closed write authority: scoping is create-only; no writing what you can't view ──

test("remember refuses to re-scope an EXISTING node for every caller — even the owner", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await seedScopedNodes(ext.store());

  // The confirmed leak shape: downgrade owner-note to public, then read it anonymously.
  for (const userId of ["111111111111111111", OWNER]) {
    const r = await registry.invoke(
      {
        capabilityId: "memory.remember",
        args: { name: "owner-note", op: "update", visibility: "public" },
        origin: { surface: "discord", userId },
      },
      deps,
    );
    expect(r.ok).toBeFalse();
    expect(r.error).toContain("scope is set at create");
  }
  // A dm_with rewrite alone is the same rescope shape — refused too.
  const dmWith = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "dm-note", op: "update", dmWith: "222333444555666777" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(dmWith.ok).toBeFalse();

  await ext.settled();
  // The node is untouched and still owner-only: anonymous recall must NOT surface it.
  const anonymous = await registry.invoke(
    { capabilityId: "memory.recall", args: { names: ALL_NAMES } },
    deps,
  );
  expect(hitNames(anonymous.data)).toEqual(["public-note"]);
  expect(ext.store().buildGraph().nodes.get("owner-note")!.metadata.visibility).toBe("owner");
});

test("remember refuses an update to a node the calling identity cannot view", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await seedScopedNodes(ext.store());

  // A non-owner cannot tamper an owner-scoped node's body or overwrite its provenance.
  const member = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "owner-note", op: "update", body: "tampered" },
      origin: { surface: "discord", userId: "111111111111111111" },
    },
    deps,
  );
  expect(member.ok).toBeFalse();
  expect(member.error).toContain("not visible to the calling identity");

  // A dm-scoped node accepts NO invoke-path writes at all (context pins to "guild") —
  // not even from its dm partner or the owner.
  for (const userId of ["111222333444555666", OWNER]) {
    const dm = await registry.invoke(
      {
        capabilityId: "memory.remember",
        args: { name: "dm-note", op: "update", body: "tampered" },
        origin: { surface: "discord", userId },
      },
      deps,
    );
    expect(dm.ok).toBeFalse();
  }

  // The owner CAN update their own scoped node — and the absent-flag merge preserves scope.
  const owner = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "owner-note", op: "update", body: "a legitimate owner edit" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(owner.ok).toBeTrue();
  await ext.settled();
  const node = ext.store().buildGraph().nodes.get("owner-note")!;
  expect(node.body).toContain("a legitimate owner edit");
  expect(node.metadata.visibility).toBe("owner");
  expect(ext.store().buildGraph().nodes.get("dm-note")!.body).not.toContain("tampered");
});

test("the write gates resolve identity like the engine: an alias hit is the same node", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  await ext.store().remember({
    op: "create", name: "owner-secret", type: "preference", description: "an owner-scoped fact",
    metadata: { visibility: "owner", aliases: ["Owner Secret Notes"] },
    source: "manual", reason: "test",
  });

  // Targeting the ALIAS would merge into the same node (findExisting arm 2) — both gates hold.
  const rescope = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "owner-secret-notes", op: "update", visibility: "public" },
      origin: { surface: "discord", userId: "111111111111111111" },
    },
    deps,
  );
  expect(rescope.ok).toBeFalse();
  expect(rescope.error).toContain("'owner-secret' already exists");

  const tamper = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "owner-secret-notes", op: "update", body: "tampered" },
      origin: { surface: "discord", userId: "111111111111111111" },
    },
    deps,
  );
  expect(tamper.ok).toBeFalse();
  expect(tamper.error).toContain("not visible to the calling identity");

  await ext.settled();
  expect(ext.store().buildGraph().nodes.get("owner-secret")!.metadata.visibility).toBe("owner");
});

test("scoping at CREATE still works: a fresh node may be born owner-scoped via invoke", async () => {
  const { ext, deps, registry } = build();
  await registry.initAll(deps);
  const r = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "born-scoped", type: "preference", description: "scoped from birth", visibility: "owner" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(r.ok).toBeTrue();
  await ext.settled();
  expect(ext.store().buildGraph().nodes.get("born-scoped")!.metadata.visibility).toBe("owner");
});

test("§7: remember returns before the write settles, and a pending write never blocks recall", async () => {
  const store = tempStore();
  await store.remember({
    op: "create", name: "public-note", type: "reference",
    description: "a public fact about the plan", source: "manual", reason: "test",
  });
  // Gate the NEXT write behind a manual latch — the invoke must come back while it hangs.
  let release: ((node: MemoryNode) => void) | null = null;
  const gated = new Promise<MemoryNode>((resolve) => { release = resolve; });
  const remember = store.remember.bind(store);
  let writes = 0;
  store.remember = async (intent: RememberIntent) => {
    writes++;
    await gated;
    return remember(intent);
  };
  const { ext, deps, registry } = build({ createStore: () => store });
  await registry.initAll(deps);

  const write = await registry.invoke(
    {
      capabilityId: "memory.remember",
      args: { name: "slow-fact", type: "reference", description: "still committing" },
      origin: { surface: "discord", userId: OWNER },
    },
    deps,
  );
  expect(write.ok).toBeTrue(); // returned while the store write is still latched
  expect(writes).toBe(1);

  // Reads keep flowing while the write hangs: recall is awaited and comes back complete.
  const read = await registry.invoke(
    { capabilityId: "memory.recall", args: { names: "public-note" } },
    deps,
  );
  expect(read.ok).toBeTrue();
  expect(hitNames(read.data)).toEqual(["public-note"]);

  release!(undefined as unknown as MemoryNode);
  await ext.settled();
  expect(ext.store().buildGraph().nodes.get("slow-fact")).toBeDefined();
});

// ── carried v5 facets: the CLI surface stays byte-identical ──────────────────────────────

test("the CLI facets are carried verbatim and project into the same spine slot", () => {
  const { ext } = build();
  expect(ext.cliHelp).toBe(
    'recall "<query>" [--type t] [--name n] [--as-self | --viewer id] | memory recall|remember|show|maintain',
  );
  expect(ext.cliVerbs!.map((v) => v.name)).toEqual(["recall", "memory"]);
  expect(ext.cliVerbs![0]!.usage).toBe(
    'beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k N] [--hops N] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] [--json]',
  );
  expect(ext.cliVerbs![1]!.usage).toBe("beckett memory recall|remember|show|maintain <...>");
  expect(ext.busCommands).toEqual([]);

  const projected = asCapability(ext);
  expect(projected.id).toBe("memory");
  expect(projected.summary).toBe("the in-process markdown memory graph");
  expect(projected.cliVerbs.map((v) => v.name)).toEqual(["recall", "memory"]);
});

test("invoke refuses cleanly pre-init instead of exiting or building a store", async () => {
  const { deps, registry } = build();
  const r = await registry.invoke(
    { capabilityId: "memory.recall", args: { query: "anything" } },
    deps,
  );
  expect(r.ok).toBeFalse();
  expect(r.error).toContain("lifecycle.init has not run");
});
