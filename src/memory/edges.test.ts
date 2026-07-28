/**
 * Typed, dated edges between memories (issue #60).
 *
 * Pins the link-format extension: a `[[name]]` edge can now carry an optional relation type from
 * a closed five-word vocabulary and an optional observation date, while every bare/aliased link
 * keeps parsing and resolving with zero migration. Recall surfaces the type and date on one-hop
 * linked context so an answer can weigh a superseding fact over the one it superseded.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemory,
  parseMemoryFile,
  RELATION_TYPES,
  type MemoryStore,
} from "./index.ts";
import type { Logger, MemoryEdge } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-edges-"));
  tmpDirs.push(dir);
  return createMemory({ memoryDir: dir, logger: quietLog, git: false });
}

/** Parse a synthetic note whose body is `body`, returning just its outgoing edges. */
function edgesOf(body: string): MemoryEdge[] {
  const raw = `---\nname: src\ndescription: >\n  a source note\nmetadata:\n  type: reference\n---\n\n${body}\n`;
  return parseMemoryFile("/tmp/src.md", raw, 0).edges;
}

// ── parsing ────────────────────────────────────────────────────────────────────────────

test("bare [[name]] still parses as an untyped, undated edge", () => {
  const [e, ...rest] = edgesOf("See [[old-plan]] for context.");
  expect(rest).toHaveLength(0);
  expect(e).toMatchObject({ to: "old-plan", field: "body" });
  expect(e!.rel).toBeUndefined();
  expect(e!.date).toBeUndefined();
});

test("[[name|alias]] still parses, alias preserved, untyped", () => {
  const [e] = edgesOf("Ask [[jason|the owner]] about it.");
  expect(e).toMatchObject({ to: "jason", alias: "the owner", field: "body" });
  expect(e!.rel).toBeUndefined();
});

test("a typed edge carries its relation from the closed vocab", () => {
  const [e] = edgesOf("This [[supersedes:old-plan]].");
  expect(e).toMatchObject({ to: "old-plan", rel: "supersedes", field: "body" });
  expect(e!.date).toBeUndefined();
});

test("a typed + dated edge carries both the relation and the observation date", () => {
  const [e] = edgesOf("The rollback [[supersedes:old-plan @2026-07-14]].");
  expect(e).toMatchObject({ to: "old-plan", rel: "supersedes", date: "2026-07-14" });
});

test("an untyped edge can still carry a date", () => {
  const [e] = edgesOf("Noted [[loom-desk @2026-01-02]].");
  expect(e).toMatchObject({ to: "loom-desk", date: "2026-01-02" });
  expect(e!.rel).toBeUndefined();
});

test("all five relation types parse; an invented type is not an edge at all", () => {
  for (const rel of RELATION_TYPES) {
    const [e] = edgesOf(`x [[${rel}:target]] y`);
    expect(e).toMatchObject({ to: "target", rel });
  }
  // `related-to` is not in the closed vocab, so the colon can't belong to a kebab name — the
  // token is simply not a link, and mints no edge (not even a bare one).
  expect(edgesOf("x [[related-to:target]] y")).toHaveLength(0);
});

test("the relation vocabulary is exactly the five closed types", () => {
  expect([...RELATION_TYPES].sort()).toEqual(
    ["about", "caused-by", "contradicts", "part-of", "supersedes"],
  );
});

test("two different typed edges to the same target both survive (rel is part of identity)", () => {
  const edges = edgesOf("It [[supersedes:target]] but is also [[about:target]].");
  expect(edges.map((e) => e.rel).sort()).toEqual(["about", "supersedes"]);
});

test("a dated wikilink inside a frontmatter structural field parses its date", () => {
  const raw =
    `---\nname: v2\ndescription: >\n  the second plan\nmetadata:\n  type: decision\n` +
    `  supersedes: ["[[v1 @2026-07-14]]"]\n---\n\nbody\n`;
  const { edges } = parseMemoryFile("/tmp/v2.md", raw, 0);
  const e = edges.find((x) => x.field === "supersedes");
  expect(e).toMatchObject({ to: "v1", field: "supersedes", date: "2026-07-14" });
});

// ── recall surfacing ─────────────────────────────────────────────────────────────────────

// The linked targets below carry vocabulary DISJOINT from each query, so they surface only via
// one-hop expansion (never as a direct seed) — that is exactly the "linked context" the ticket
// asks recall to annotate with the edge's type and date.

test("recall surfaces the relation type and observation date on linked context", async () => {
  const store = tempStore();
  await store.remember({
    op: "create", name: "old-plan", type: "decision",
    description: "the friday shipping schedule", body: "ship on friday",
    source: "manual", reason: "seed",
  });
  await store.remember({
    op: "create", name: "new-plan", type: "decision",
    description: "the widget rollback choice",
    body: "Hold it. This [[supersedes:old-plan @2026-07-14]].",
    source: "manual", reason: "seed",
  });

  const r = await store.recall({ text: "widget rollback choice", k: 3 });
  const link = r.expanded.find((x) => x.node.name === "old-plan");
  expect(link).toBeTruthy();
  expect(link!.reason).toContain("supersedes");
  expect(link!.reason).toContain("2026-07-14");
});

test("a bare linked edge keeps its plain 'linked … via' reason (no false type/date)", async () => {
  const store = tempStore();
  await store.remember({
    op: "create", name: "desk", type: "env",
    description: "hardware inventory item xyzzy", body: "an ubuntu box",
    source: "manual", reason: "seed",
  });
  await store.remember({
    op: "create", name: "worker", type: "reference",
    description: "the frobnicator batch job", body: "Runs on [[desk]].",
    source: "manual", reason: "seed",
  });
  const r = await store.recall({ text: "frobnicator batch job", k: 3 });
  const link = r.expanded.find((x) => x.node.name === "desk");
  expect(link).toBeTruthy();
  expect(link!.reason).toContain("via");
  expect(link!.reason).not.toContain("observed");
});

test("remember can materialize a typed, dated link and it round-trips through recall", async () => {
  const store = tempStore();
  await store.remember({
    op: "create", name: "cause", type: "reference",
    description: "flaky network packet loss on the switch", body: "packet loss",
    source: "manual", reason: "seed",
  });
  await store.remember({
    op: "create", name: "outage", type: "reference",
    description: "the saturday api downtime incident",
    body: "api was down",
    links: [{ to: "cause", field: "body", rel: "caused-by", date: "2026-07-14" }],
    source: "manual", reason: "seed",
  });
  const r = await store.recall({ text: "saturday api downtime incident", k: 3 });
  const link = r.expanded.find((x) => x.node.name === "cause");
  expect(link).toBeTruthy();
  expect(link!.reason).toContain("caused-by");
  expect(link!.reason).toContain("2026-07-14");
});
