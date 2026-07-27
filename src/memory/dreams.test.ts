/**
 * Dream-namespace containment (issue #36). These tests deliberately TRY to violate the two
 * load-bearing properties and must fail to:
 *
 *   1. a dream can never launder an inference into a fact (forced type/inference/provenance,
 *      visible inference marking on every recall surface);
 *   2. a dream can never edit or delete an existing memory (create-only, namespace-locked name
 *      shape, no path input, no merge/dedup into non-dream nodes).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemory, DREAM_NAME_RE, isInferenceNode, type MemoryStore } from "./index.ts";
import { recallCliOutput } from "./recall-cli.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dreams-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

const DREAM = {
  name: "dream-2026-07-26-jason-prefers-terse-updates",
  description: "jason seems to prefer terse ticket updates late at night",
  body: "Inferred from tonight's replay; two long updates got no reply, the short one did.",
  provenance: ["channel:123", "journal:#31"],
  reason: "test",
};

test("rememberDream forces type=dream, inference:true, provenance, and source=derived", async () => {
  const { memory, dir } = store();
  const node = await memory.rememberDream(DREAM);
  expect(node.type).toBe("dream");
  expect(node.metadata.inference).toBe(true);
  expect(node.metadata.provenance).toEqual(["channel:123", "journal:#31"]);
  expect(node.source).toBe("derived");
  expect(isInferenceNode(node)).toBe(true);
  // On disk, in the dream namespace folder, with the markers in the frontmatter.
  const raw = readFileSync(join(dir, "dreams", `${DREAM.name}.md`), "utf8");
  expect(raw).toContain("type: dream");
  expect(raw).toContain("inference: true");
  expect(raw).toContain("provenance:");
  // The always-loaded index carries the inference flag too.
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("[inference]");
});

test("a dream memory needs real provenance and a description — no bare assertions", async () => {
  const { memory } = store();
  await expect(memory.rememberDream({ ...DREAM, provenance: [] })).rejects.toThrow(/provenance/);
  await expect(memory.rememberDream({ ...DREAM, provenance: ["  "] })).rejects.toThrow(/provenance/);
  await expect(memory.rememberDream({ ...DREAM, description: " " })).rejects.toThrow(/description/);
});

test("the name shape is namespace-locked: nothing outside dream-YYYY-MM-DD-* is writable", async () => {
  const { memory } = store();
  for (const name of [
    "jason", // a person node's name — the laundering target
    "doctrine", // nothing doctrine-shaped is reachable either
    "dream-jason", // prefix without the date
    "dream-2026-07-26", // date without a slug
    "Dream-2026-07-26-x", // case matters (kebab-only)
    "dream-2026-07-26-../persona", // traversal (rejected by shape, never joined)
    "/etc/passwd",
  ]) {
    expect(DREAM_NAME_RE.test(name)).toBe(false);
    await expect(memory.rememberDream({ ...DREAM, name })).rejects.toThrow(/invalid dream node name/);
  }
});

test("create-only: a dream can never edit an existing memory — not even another dream", async () => {
  const { memory, dir } = store();
  await memory.rememberDream(DREAM);
  const before = readFileSync(join(dir, "dreams", `${DREAM.name}.md`), "utf8");
  await expect(
    memory.rememberDream({ ...DREAM, description: "second write trying to overwrite" }),
  ).rejects.toThrow(/create-only/);
  expect(readFileSync(join(dir, "dreams", `${DREAM.name}.md`), "utf8")).toBe(before);
});

test("a dream write leaves every existing memory file byte-identical (no merge, no backlink rewrite)", async () => {
  const { memory, dir } = store();
  // A REAL observed fact with content very close to the dream's — the exact shape remember()'s
  // similarity dedup would merge into. rememberDream must not.
  await memory.remember({
    op: "create",
    name: "jason-update-style",
    type: "preference",
    description: "jason seems to prefer terse ticket updates late at night",
    body: "Observed directly.",
    metadata: {},
    source: "conversation",
    reason: "seed",
  });
  const factPath = join(dir, "prefs", "jason-update-style.md");
  const factBefore = readFileSync(factPath, "utf8");

  // The dream even LINKS to the fact — the backlink refresh that remember() would run on the
  // target is deliberately skipped, so the fact's file must not change by a byte.
  await memory.rememberDream({
    ...DREAM,
    body: "Same inference, citing [[jason-update-style]].",
  });

  expect(readFileSync(factPath, "utf8")).toBe(factBefore);
  // And the fact node itself is untouched in the graph (still a preference, still observed).
  const fact = memory.buildGraph().nodes.get("jason-update-style")!;
  expect(fact.type).toBe("preference");
  expect(fact.body).toContain("Observed directly.");
  expect(isInferenceNode(fact)).toBe(false);
});

test("recall visibly marks dream-derived hits as inference, in text and JSON", async () => {
  const { memory } = store();
  await memory.rememberDream(DREAM);
  const request = { text: "", names: [DREAM.name], flags: {} as Record<string, string | boolean>, audience: SELF_AUDIENCE };

  const text = (await recallCliOutput(memory, { ...request, flags: {} })) as string;
  expect(text).toContain("INFERENCE");
  expect(text).toContain("NOT an observed fact");
  expect(text).toContain("channel:123"); // the sources ride the hit

  const json = (await recallCliOutput(memory, { ...request, flags: { json: true } })) as {
    hits: Array<{ name: string; inference?: boolean; inferred_from?: string[] }>;
  };
  const hit = json.hits.find((h) => h.name === DREAM.name)!;
  expect(hit.inference).toBe(true);
  expect(hit.inferred_from).toEqual(["channel:123", "journal:#31"]);
});

test("a non-dream hit is NOT marked as inference", async () => {
  const { memory } = store();
  await memory.remember({
    op: "create",
    name: "loom-desk",
    type: "env",
    description: "the box beckett runs on",
    metadata: {},
    source: "env-scan",
    reason: "seed",
  });
  const text = (await recallCliOutput(memory, {
    text: "",
    names: ["loom-desk"],
    flags: {},
    audience: SELF_AUDIENCE,
  })) as string;
  expect(text).not.toContain("INFERENCE");
});
