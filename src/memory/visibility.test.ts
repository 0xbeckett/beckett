/**
 * Memory visibility + provenance scoping tests (multiplayer §7/§9.1).
 * Pins the structural access model layered onto the knowledge graph:
 *   - all four frontmatter fields are optional and round-trip exactly (ids as strings, even at
 *     18–20 digits where a bare YAML scalar would lose precision);
 *   - the recall audience filter is a hard, fail-closed post-score gate over the full matrix
 *     public/owner/dm × (no viewer | member | owner) × (guild | dm, matching/mismatching);
 *   - a `dm` node with no valid `dm_with` degrades to `owner`;
 *   - one-hop wikilink expansion obeys the same gate (no hidden stubs);
 *   - update-merge preserves scope and never silently broadens it; an explicit flag wins;
 *   - the maintenance pass never merges across a visibility boundary;
 *   - the CLI surface: `remember` flags persist, `show` reveals scope, `recall --viewer`
 *     filters, and `--visibility dm` without `--dm-with` is a fast usage error.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, recallOver, type MemoryStore } from "./index.ts";
import {
  type Audience,
  canView,
  provenanceOf,
  renderProvenance,
  SELF_AUDIENCE,
} from "./search.ts";
import { planMaintenance } from "./maintain.ts";
import type { Logger, MemoryNode } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-visibility-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

/** A viewer of a given role/context; `viewerId` omitted ⇒ the fail-closed "no viewer" case. */
function viewer(
  role: Audience["viewerRole"],
  context: Audience["context"],
  viewerId?: string,
): Audience {
  return { viewerId, viewerRole: role, context };
}

const PARTNER = "881122334455667788"; // an 18-digit snowflake — precision-lossy as a bare scalar
const OTHER = "112233445566778899";

// ── round-trip ─────────────────────────────────────────────────────────────────────────

test("all new frontmatter fields round-trip; ids survive as exact strings", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create",
    name: "dm-secret",
    type: "preference",
    description: "Prefers dark mode in DMs",
    // `ticket_id` is an arbitrary, NON-allowlisted digit-valued key: the serializer must quote
    // ANY all-digit string (not just known id keys) so a future id field can't corrupt to a Number.
    metadata: {
      visibility: "dm",
      dm_with: PARTNER,
      source_user: PARTNER,
      source_name: "zoomx64",
      ticket_id: "123456789012345678",
    },
    source: "conversation",
    reason: "test",
  });

  // A FRESH store re-reads from disk, so this exercises render → parse round-trip.
  const fresh = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const node = fresh.buildGraph().nodes.get("dm-secret")!;
  const p = provenanceOf(node);
  expect(p.visibility).toBe("dm");
  expect(p.dmWith).toBe(PARTNER); // exact 18-digit string, not a lossy Number
  expect(typeof node.metadata.dm_with).toBe("string");
  expect(p.sourceUser).toBe(PARTNER);
  expect(p.sourceName).toBe("zoomx64");
  expect(renderProvenance(node)).toBe("from zoomx64 (user:8811…)");
  // The arbitrary digit-valued key survives as an exact string, not a precision-lossy Number.
  expect(typeof node.metadata.ticket_id).toBe("string");
  expect(node.metadata.ticket_id).toBe("123456789012345678");
});

test("a legacy node with no visibility/provenance fields parses as public", async () => {
  const { store } = tempStore();
  const node = await store.remember({
    op: "create",
    name: "plain",
    type: "person",
    description: "Just a person, no scope fields at all",
    source: "manual",
    reason: "test",
  });
  const p = provenanceOf(node);
  expect(p.visibility).toBe("public");
  expect(p.dmWith).toBeUndefined();
  expect(renderProvenance(node)).toBeNull();
});

// ── canView matrix (unit, over synthetic nodes) ──────────────────────────────────────────

function node(meta: Record<string, unknown>): MemoryNode {
  return {
    name: "n", type: "preference", description: "", metadata: meta, body: "",
    path: "", created: "", updated: "", source: "manual", stale: false, phantom: false, mtime: 0,
  };
}

test("public is visible to everyone, including the fail-closed no-viewer default", () => {
  const pub = node({ visibility: "public" });
  expect(canView(pub, undefined)).toBe(true);
  expect(canView(pub, viewer("member", "guild"))).toBe(true);
  expect(canView(pub, viewer("owner", "dm", "1"))).toBe(true);
  expect(canView(node({}), undefined)).toBe(true); // absent field ⇒ public
});

test("owner nodes are visible only to an owner-role viewer", () => {
  const own = node({ visibility: "owner" });
  expect(canView(own, undefined)).toBe(false); // no viewer ⇒ withheld
  expect(canView(own, viewer("member", "guild", OTHER))).toBe(false);
  expect(canView(own, viewer("maintainer", "guild", OTHER))).toBe(false);
  expect(canView(own, viewer("owner", "guild", OTHER))).toBe(true);
  expect(canView(own, viewer("owner", "dm", OTHER))).toBe(true);
});

test("dm nodes are visible only in the DM, and only to the dm_with partner", () => {
  const dm = node({ visibility: "dm", dm_with: PARTNER });
  expect(canView(dm, undefined)).toBe(false);
  // right partner, wrong context (guild) — DM facts never surface in a guild, even to the owner:
  expect(canView(dm, viewer("owner", "guild", PARTNER))).toBe(false);
  // right context, wrong partner:
  expect(canView(dm, viewer("member", "dm", OTHER))).toBe(false);
  // right context, right partner:
  expect(canView(dm, viewer("member", "dm", PARTNER))).toBe(true);
  // the owner in a DM is NOT the partner ⇒ still hidden:
  expect(canView(dm, viewer("owner", "dm", OTHER))).toBe(false);
});

test("a dm node without a valid dm_with degrades to owner (fail closed)", () => {
  const bad = node({ visibility: "dm" }); // no dm_with at all
  expect(provenanceOf(bad).visibility).toBe("owner");
  expect(canView(bad, viewer("member", "dm", PARTNER))).toBe(false);
  expect(canView(bad, viewer("owner", "guild", OTHER))).toBe(true);

  const malformed = node({ visibility: "dm", dm_with: "not-an-id" });
  expect(provenanceOf(malformed).visibility).toBe("owner");
});

test("an unparseable visibility value fails closed to owner, never public", () => {
  expect(provenanceOf(node({ visibility: "everyone" })).visibility).toBe("owner");
});

test("SELF_AUDIENCE (Beckett for itself) sees public + owner but NEVER dm", () => {
  expect(canView(node({}), SELF_AUDIENCE)).toBe(true);
  expect(canView(node({ visibility: "owner" }), SELF_AUDIENCE)).toBe(true);
  // dm facts belong to one conversation: the sentinel viewer id is not a snowflake, so the
  // dm arm can never match it — even a dm-context variant of self stays fail-closed.
  expect(canView(node({ visibility: "dm", dm_with: PARTNER }), SELF_AUDIENCE)).toBe(false);
  expect(canView(node({ visibility: "dm", dm_with: PARTNER }), { ...SELF_AUDIENCE, context: "dm" })).toBe(false);
});

// ── recall filter (engine, over a built graph) ───────────────────────────────────────────

async function seedScoped(store: MemoryStore): Promise<void> {
  await store.remember({
    op: "create", name: "deploy-public", type: "project",
    description: "public deploy notes for the cloudflare tunnel",
    source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "deploy-owner", type: "project",
    description: "owner-only deploy secret for the cloudflare tunnel",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "deploy-dm", type: "project",
    description: "dm-scoped deploy note for the cloudflare tunnel",
    metadata: { visibility: "dm", dm_with: PARTNER }, source: "manual", reason: "t",
  });
}

function hitNames(store: MemoryStore, audience?: Audience): string[] {
  const g = store.buildGraph();
  return recallOver({ text: "cloudflare tunnel deploy", audience }, g).hits.map((h) => h.node.name);
}

test("no viewer ⇒ only public nodes are returned (fail-closed default)", async () => {
  const { store } = tempStore();
  await seedScoped(store);
  expect(hitNames(store).sort()).toEqual(["deploy-public"]);
});

test("a member sees public only; an owner also sees owner nodes; the partner sees their dm", async () => {
  const { store } = tempStore();
  await seedScoped(store);
  expect(hitNames(store, viewer("member", "guild", OTHER)).sort()).toEqual(["deploy-public"]);
  expect(hitNames(store, viewer("owner", "guild", OTHER)).sort()).toEqual([
    "deploy-owner",
    "deploy-public",
  ]);
  // The partner in their DM sees public + their dm note, but NOT the owner-only node.
  expect(hitNames(store, viewer("member", "dm", PARTNER)).sort()).toEqual([
    "deploy-dm",
    "deploy-public",
  ]);
  // Same partner in a guild loses the dm note (DM facts stay in the DM).
  expect(hitNames(store, viewer("member", "guild", PARTNER)).sort()).toEqual(["deploy-public"]);
});

test("the recall INDEX obeys the filter too — a scoped node's name/description never leaks", async () => {
  const { store } = tempStore();
  await seedScoped(store);
  const g = store.buildGraph();
  const indexNames = (audience?: Audience) =>
    recallOver({ text: "cloudflare tunnel deploy", audience }, g).index.map((l) => l.name).sort();
  // No viewer / member in guild: the trailing index must not name owner- or dm-scoped facts.
  expect(indexNames()).toEqual(["deploy-public"]);
  expect(indexNames(viewer("member", "guild", OTHER))).toEqual(["deploy-public"]);
  // The owner sees owner-scoped entries; the DM partner sees their dm entry in the DM.
  expect(indexNames(viewer("owner", "guild", OTHER))).toEqual(["deploy-owner", "deploy-public"]);
  expect(indexNames(viewer("member", "dm", PARTNER))).toEqual(["deploy-dm", "deploy-public"]);
});

test("the on-disk MEMORY.md lists PUBLIC nodes only — scoped names/descriptions never land in it", async () => {
  const { store, dir } = tempStore();
  await seedScoped(store);
  // MEMORY.md is loaded into arbitrary sessions (including ones serving non-owners), so unlike
  // the graph it cannot be gated per-viewer — scoped entries must simply not be materialized.
  const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(index).toContain("[[deploy-public]]");
  expect(index).not.toContain("deploy-owner");
  expect(index).not.toContain("owner-only deploy secret"); // the description must not leak either
  expect(index).not.toContain("deploy-dm");
  expect(index).not.toContain("dm-scoped deploy note");
});

test("one-hop wikilink expansion obeys the filter — no hidden stubs", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "seed-note", type: "project",
    description: "public seed about the widget rollout",
    body: "See [[hidden-owner-note]] for the rest.",
    source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "hidden-owner-note", type: "project",
    description: "owner-only continuation of the widget rollout",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });

  const g = store.buildGraph();
  const asMember = recallOver({ text: "widget rollout", audience: viewer("member", "guild", OTHER) }, g);
  expect(asMember.hits.map((h) => h.node.name)).toContain("seed-note");
  expect([...asMember.hits, ...asMember.expanded].map((x) => x.node.name)).not.toContain(
    "hidden-owner-note",
  );

  const asOwner = recallOver({ text: "widget rollout", audience: viewer("owner", "guild", OTHER) }, g);
  expect([...asOwner.hits, ...asOwner.expanded].map((x) => x.node.name)).toContain(
    "hidden-owner-note",
  );
});

// ── update-merge: preserve, don't broaden ────────────────────────────────────────────────

test("an update with no visibility flag preserves the existing scope (no silent broadening)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "scoped", type: "preference",
    description: "an owner-only preference about the roadmap",
    metadata: { visibility: "owner", source_user: PARTNER, source_name: "zoomx64" },
    source: "conversation", reason: "t",
  });
  // Re-remember the same fact with fresh body but NO scope metadata.
  const updated = await store.remember({
    op: "update", name: "scoped", type: "preference",
    description: "an owner-only preference about the roadmap",
    body: "extra detail added later",
    source: "conversation", reason: "t",
  });
  const p = provenanceOf(updated);
  expect(p.visibility).toBe("owner"); // preserved, not widened to public
  expect(p.sourceUser).toBe(PARTNER); // provenance preserved too
  expect(p.sourceName).toBe("zoomx64");
});

test("an explicit visibility flag on update wins (the caller acts for the owner)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "promote", type: "preference",
    description: "a fact that starts owner-only",
    metadata: { visibility: "owner" }, source: "conversation", reason: "t",
  });
  const updated = await store.remember({
    op: "update", name: "promote", type: "preference",
    description: "a fact that starts owner-only",
    metadata: { visibility: "public" }, source: "conversation", reason: "t",
  });
  expect(provenanceOf(updated).visibility).toBe("public");
});

// ── write-path dedup never crosses a visibility boundary ─────────────────────────────────
// A similarity (non-exact-name) dedup match is only valid when the intended save's effective
// visibility + dm_with equals the existing node's — the same provenanceOf rule maintenance uses.
// Otherwise the metadata merge would rewrite scope: a dm save could swallow/flip a public node.

test("write-path dedup: a dm save similar to a public node creates a NEW node, not a merge", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "tunnel-runbook-public", type: "reference",
    description: "cloudflare tunnel token rotation runbook",
    source: "manual", reason: "t",
  });
  // Same description, different name (so no exact-name identity hit) but dm-scoped. Similarity
  // clears DEDUP_THRESHOLD, so pre-fix this would coerce into the public node and rewrite its scope.
  const dm = await store.remember({
    op: "create", name: "tunnel-runbook-dm", type: "reference",
    description: "cloudflare tunnel token rotation runbook",
    metadata: { visibility: "dm", dm_with: PARTNER }, source: "conversation", reason: "t",
  });
  const g = store.buildGraph();
  expect(g.nodes.has("tunnel-runbook-public")).toBe(true);
  expect(g.nodes.has("tunnel-runbook-dm")).toBe(true); // a distinct node, not merged away
  expect(provenanceOf(g.nodes.get("tunnel-runbook-public")!).visibility).toBe("public"); // not flipped
  expect(provenanceOf(dm).visibility).toBe("dm");
});

test("write-path dedup: a public save similar to an owner node creates a NEW node, not a merge", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "cf-tunnel-owner", type: "reference",
    description: "cloudflare tunnel token rotation runbook",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  const pub = await store.remember({
    op: "create", name: "cf-tunnel-public", type: "reference",
    description: "cloudflare tunnel token rotation runbook",
    source: "manual", reason: "t",
  });
  const g = store.buildGraph();
  expect(g.nodes.has("cf-tunnel-owner")).toBe(true);
  expect(g.nodes.has("cf-tunnel-public")).toBe(true);
  expect(provenanceOf(g.nodes.get("cf-tunnel-owner")!).visibility).toBe("owner"); // not swallowed
  expect(provenanceOf(pub).visibility).toBe("public");
});

test("write-path dedup: an exact-name re-remember still updates in place across scope (identity wins)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "same-name", type: "reference",
    description: "first version, public", source: "manual", reason: "t",
  });
  // Exact name = identity, not similarity — it still coerces to an update, and the explicit
  // visibility flag wins (the caller acts for the owner). No new node is created.
  const updated = await store.remember({
    op: "update", name: "same-name", type: "reference",
    description: "second version, now owner-scoped",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  const g = store.buildGraph();
  expect([...g.nodes.values()].filter((n) => !n.phantom).length).toBe(1); // updated, not duplicated
  expect(provenanceOf(updated).visibility).toBe("owner");
  expect(updated.description).toBe("second version, now owner-scoped");
});

// ── maintenance never crosses a visibility boundary ──────────────────────────────────────

/** Rewrite a node's description on disk — bypasses write-time dedup so a genuine near-duplicate
 *  pair reaches the maintenance planner (same trick the existing merge test uses). */
async function forceDescription(store: MemoryStore, name: string, desc: string): Promise<void> {
  const path = store.buildGraph().nodes.get(name)!.path;
  const raw = readFileSync(path, "utf8").replace(/description: >\n {2}.*\n/, `description: >\n  ${desc}\n`);
  await Bun.write(path, raw);
}

test("maintenance never merges (or flags) two near-identical nodes of different visibility", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "note-public", type: "reference",
    description: "aaa placeholder wording alpha", source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "note-owner", type: "reference",
    description: "zzz placeholder wording omega",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  const same = "cloudflare tunnel token rotation procedure";
  await forceDescription(store, "note-public", same);
  await forceDescription(store, "note-owner", same);

  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.merges).toEqual([]); // the visibility guard blocks the merge
  expect(plan.flagged).toEqual([]); // and blocks flagging across the boundary too
});

test("maintenance still merges near-identical nodes that share a visibility", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create", name: "note-a", type: "reference",
    description: "aaa placeholder wording alpha",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  await store.remember({
    op: "create", name: "note-b", type: "reference",
    description: "zzz placeholder wording omega",
    metadata: { visibility: "owner" }, source: "manual", reason: "t",
  });
  const same = "cloudflare tunnel token rotation procedure";
  await forceDescription(store, "note-a", same);
  await forceDescription(store, "note-b", same);

  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.merges.length).toBe(1); // same visibility ⇒ the guard allows the merge
});

// ── CLI surface ──────────────────────────────────────────────────────────────────────────

const CLI = join(import.meta.dir, "..", "cli", "beckett.ts");

async function cli(
  dir: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("CLI: `--visibility dm` without `--dm-with` is a fast usage error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cli-vis-"));
  tmpDirs.push(dir);
  const r = await cli(dir, [
    "memory", "remember", "--name", "x", "--type", "person", "--desc", "d", "--visibility", "dm",
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--dm-with");
});

test("CLI: remember → show → recall carries visibility, provenance, and exact ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cli-vis-"));
  tmpDirs.push(dir);

  const wrote = await cli(dir, [
    "memory", "remember", "--name", "dm-fact", "--type", "preference",
    "--desc", "a dm-scoped preference about deploys", "--visibility", "dm",
    "--dm-with", PARTNER, "--by", PARTNER, "--by-name", "zoomx64",
  ]);
  expect(wrote.code).toBe(0);
  expect(JSON.parse(wrote.stdout)).toMatchObject({ remembered: "dm-fact", visibility: "dm" });

  const shown = await cli(dir, ["memory", "show", "dm-fact"]);
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.stdout)).toMatchObject({
    name: "dm-fact",
    visibility: "dm",
    dm_with: PARTNER, // exact 18-digit string
    source_user: PARTNER,
    source_name: "zoomx64",
    provenance: "from zoomx64 (user:8811…)",
  });

  // Recall without a viewer: fail-closed ⇒ the dm fact is absent.
  const blind = await cli(dir, ["recall", "deploys preference", "--json"]);
  expect(JSON.parse(blind.stdout).hits.map((h: { name: string }) => h.name)).not.toContain("dm-fact");

  // Recall as the partner in their DM: the fact appears, carrying its scope + provenance.
  const seen = await cli(dir, [
    "recall", "deploys preference", "--viewer", PARTNER, "--context", "dm", "--json",
  ]);
  const hit = JSON.parse(seen.stdout).hits.find((h: { name: string }) => h.name === "dm-fact");
  expect(hit).toMatchObject({ visibility: "dm", provenance: "from zoomx64 (user:8811…)" });
});

test("CLI: remember --by/--by-name persists source_user/source_name (id quoted on disk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cli-vis-"));
  tmpDirs.push(dir);

  const wrote = await cli(dir, [
    "memory", "remember", "--name", "taught-fact", "--type", "person",
    "--desc", "a person someone taught me about", "--by", PARTNER, "--by-name", "zoomx64",
  ]);
  expect(wrote.code).toBe(0);

  // Persisted provenance is readable back through `memory show`.
  const shown = await cli(dir, ["memory", "show", "taught-fact"]);
  expect(JSON.parse(shown.stdout)).toMatchObject({
    source_user: PARTNER,
    source_name: "zoomx64",
    provenance: "from zoomx64 (user:8811…)",
  });
  // And on disk the id is quoted so it round-trips as an exact string (not a lossy Number).
  const file = readFileSync(join(dir, "memory", "people", "taught-fact.md"), "utf8");
  expect(file).toContain(`source_user: "${PARTNER}"`);
  expect(file).toContain("source_name: zoomx64");
});

test("CLI: recall --viewer-role hides owner-scoped nodes from a member but shows them to an owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cli-vis-"));
  tmpDirs.push(dir);

  await cli(dir, [
    "memory", "remember", "--name", "owner-roadmap", "--type", "preference",
    "--desc", "an owner-only roadmap note about the cloudflare tunnel", "--visibility", "owner",
  ]);

  // As a member (the default role): the owner-scoped node is withheld.
  const asMember = await cli(dir, [
    "recall", "cloudflare tunnel roadmap", "--viewer", OTHER, "--viewer-role", "member", "--json",
  ]);
  expect(JSON.parse(asMember.stdout).hits.map((h: { name: string }) => h.name)).not.toContain(
    "owner-roadmap",
  );

  // As an owner: the same node surfaces.
  const asOwner = await cli(dir, [
    "recall", "cloudflare tunnel roadmap", "--viewer", OTHER, "--viewer-role", "owner", "--json",
  ]);
  expect(JSON.parse(asOwner.stdout).hits.map((h: { name: string }) => h.name)).toContain(
    "owner-roadmap",
  );
});

test("CLI: recall --as-self surfaces owner-scoped nodes but never dm-scoped ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cli-vis-"));
  tmpDirs.push(dir);

  await cli(dir, [
    "memory", "remember", "--name", "self-owner-note", "--type", "preference",
    "--desc", "an owner-only staffing note about the cloudflare tunnel", "--visibility", "owner",
  ]);
  await cli(dir, [
    "memory", "remember", "--name", "self-dm-note", "--type", "preference",
    "--desc", "a dm-scoped staffing note about the cloudflare tunnel",
    "--visibility", "dm", "--dm-with", PARTNER,
  ]);

  // Beckett recalling for its own planning: owner facts are its working knowledge...
  const self = await cli(dir, ["recall", "cloudflare tunnel staffing", "--as-self", "--json"]);
  expect(self.code).toBe(0);
  const names = JSON.parse(self.stdout).hits.map((h: { name: string }) => h.name);
  expect(names).toContain("self-owner-note");
  // ...but a dm fact belongs to one conversation and never rides into planning context.
  expect(names).not.toContain("self-dm-note");

  // Without --as-self the same recall fail-closes to public-only (the bug this flag fixes).
  const blind = await cli(dir, ["recall", "cloudflare tunnel staffing", "--json"]);
  expect(JSON.parse(blind.stdout).hits.map((h: { name: string }) => h.name)).not.toContain(
    "self-owner-note",
  );

  // --as-self answers "whose eyes?" by itself — combining it with per-viewer flags is an error.
  const mixed = await cli(dir, ["recall", "x", "--as-self", "--viewer", OTHER, "--json"]);
  expect(mixed.code).toBe(1);
  expect(mixed.stderr).toContain("--as-self");
});
