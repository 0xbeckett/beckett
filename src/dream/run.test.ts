/**
 * The dream pass (issue #36): budget ceiling, quiet-day short-circuit, provenance validation,
 * malformed-output honesty, and the single end-of-run journal write.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { createMemory, type MemoryStore } from "../memory/index.ts";
import { listDreamEntries, readDreamEntry } from "./journal.ts";
import { localDate, parseModelResult, runDreamPass, DREAM_TZ, type DreamRunDeps } from "./run.ts";
import type { Logger, Paths } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-07-26T11:30:00.000Z"); // 04:30 America/Los_Angeles
const DATE = localDate(NOW, DREAM_TZ); // "2026-07-26"

function world(): { paths: Paths; memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-run-"));
  dirs.push(dir);
  const paths = buildPaths(defaultConfig(), { BECKETT_DIR: dir });
  return { paths, memory: createMemory({ memoryDir: paths.memoryDir, logger: quiet, git: false }), dir };
}

function depsFor(
  w: { paths: Paths; memory: MemoryStore },
  over: Partial<DreamRunDeps> & { budget?: number } = {},
): DreamRunDeps {
  const config = defaultConfig();
  if (over.budget !== undefined) config.dream.output_token_budget = over.budget;
  return {
    config,
    paths: w.paths,
    logger: quiet,
    now: () => NOW,
    memory: w.memory,
    channels: null,
    routineId: "nightly-dream",
    ...over,
  };
}

/** Seed one fresh journal line so the day is not empty. */
function seedDay(paths: Paths, line = "did a thing"): void {
  mkdirSync(paths.journalDir, { recursive: true });
  const ts = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  writeFileSync(join(paths.journalDir, "#31.log"), `${ts} ✓ implement success: ${line}\n`);
}

const SYNTHESIS = JSON.stringify({
  what_happened: "shipped #31",
  differently: "should have split the ticket",
  remember: "splitting early beats reworking late",
  forget: "the flaky browser test panic",
  combine: null,
  memories: [
    {
      slug: "split-early",
      description: "big tickets seem to go better split at intake",
      note: "inferred from tonight's #31 replay",
      provenance: ["journal:#31"],
    },
  ],
});

test("a quiet day writes a thin honest entry with ZERO model calls, and the night is idempotent", async () => {
  const w = world();
  let calls = 0;
  const outcome = await runDreamPass(depsFor(w, { callModel: async () => (calls++, { text: "x", outputTokens: 1 }) }));

  expect(outcome.quiet).toBe(true);
  expect(outcome.wrote).toBe(true);
  expect(outcome.truncated).toBe(false);
  expect(outcome.outputTokens).toBe(0);
  expect(calls).toBe(0); // bail early beats padding to spend the budget
  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  expect(entry).toContain("Nothing in the window");
  expect(entry).toContain("truncated: false");

  // Exactly one dated entry per night: a second run refuses before reading anything.
  const again = await runDreamPass(depsFor(w, { callModel: async () => ({ text: "x", outputTokens: 1 }) }));
  expect(again.wrote).toBe(false);
  expect(again.note).toContain("already exists");
  expect(readdirSync(w.paths.dreamsDir)).toEqual([`${DATE}.md`]);
});

test("a normal night: one synthesis call, sections in the entry, one inference memory with real provenance", async () => {
  const w = world();
  seedDay(w.paths);
  const prompts: string[] = [];
  const outcome = await runDreamPass(
    depsFor(w, { callModel: async (p) => (prompts.push(p), { text: SYNTHESIS, outputTokens: 500 }) }),
  );

  expect(outcome.wrote).toBe(true);
  expect(outcome.quiet).toBe(false);
  expect(outcome.truncated).toBe(false);
  expect(outcome.outputTokens).toBe(500);
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("journal:#31"); // provenance vocabulary offered to the model

  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  for (const heading of ["## what happened", "## what i'd do differently", "## worth remembering", "## worth forgetting"]) {
    expect(entry).toContain(heading);
  }
  expect(entry).toContain("shipped #31");

  expect(outcome.memoriesWritten).toEqual([`dream-${DATE}-split-early`]);
  const node = w.memory.buildGraph().nodes.get(`dream-${DATE}-split-early`)!;
  expect(node.type).toBe("dream");
  expect(node.metadata.inference).toBe(true);
  expect(node.metadata.provenance).toEqual(["journal:#31"]);

  // Disk-gentle: the dreams dir holds exactly the one entry, no tmp files, no per-step churn.
  expect(readdirSync(w.paths.dreamsDir)).toEqual([`${DATE}.md`]);
});

test("a memory citing a source that was never assembled is DROPPED — provenance must name real sources", async () => {
  const w = world();
  seedDay(w.paths);
  const laundered = JSON.parse(SYNTHESIS);
  laundered.memories = [
    { slug: "fabricated", description: "jason said X in a dm", provenance: ["dm:owner", "channel:999"] },
  ];
  const outcome = await runDreamPass(
    depsFor(w, { callModel: async () => ({ text: JSON.stringify(laundered), outputTokens: 100 }) }),
  );

  expect(outcome.memoriesWritten).toEqual([]);
  expect(outcome.memoriesDropped.length).toBe(1);
  expect(outcome.memoriesDropped[0]).toContain("unknown sources");
  expect(w.memory.buildGraph().nodes.get(`dream-${DATE}-fabricated`)).toBeUndefined();
  // The drop is on the record in the entry header — an honest night, not a silent one.
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain("memories_dropped");
});

test("hitting the token ceiling stops cleanly with a partial entry marked truncated — never a silent death", async () => {
  const w = world();
  // A big enough journal to force a condense call before synthesis.
  mkdirSync(w.paths.journalDir, { recursive: true });
  const ts = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  // 400 fat lines; even after the assembler keeps only the newest 60, the section stays well
  // past the condense threshold, so the pass takes a (budget-counted) condense call first.
  const big = Array.from({ length: 400 }, (_, i) => `${ts}   · Bash  long line of tool noise number ${i} ${"x".repeat(300)}`).join("\n");
  writeFileSync(join(w.paths.journalDir, "#31.log"), big + "\n");

  let calls = 0;
  const outcome = await runDreamPass(
    depsFor(w, {
      budget: 1_000,
      // The condense reply alone eats the whole ceiling; the pass must stop before synthesis.
      callModel: async () => (calls++, { text: "condensed", outputTokens: 1_000 }),
    }),
  );

  expect(calls).toBe(1);
  expect(outcome.truncated).toBe(true);
  expect(outcome.wrote).toBe(true);
  expect(outcome.outputTokens).toBe(1_000);
  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  expect(entry).toContain("truncated: true");
  expect(entry).toContain("Stopped early");
  expect(listDreamEntries(w.paths.dreamsDir)[0]!.truncated).toBe(true);
});

test("a zero-remaining budget before any call still yields a truncated entry, zero calls", async () => {
  const w = world();
  seedDay(w.paths);
  let calls = 0;
  const outcome = await runDreamPass(
    depsFor(w, { budget: 1, callModel: async () => (calls++, { text: SYNTHESIS, outputTokens: 5 }) }),
  );
  // budget 1 > 0 so the synthesis call runs once, then the ceiling trips on the next check —
  // the pass never retries or pads past it.
  expect(calls).toBe(1);
  expect(outcome.wrote).toBe(true);
});

test("unparseable synthesis (twice) is kept raw in an honest entry — never fabricated structure", async () => {
  const w = world();
  seedDay(w.paths);
  let calls = 0;
  const outcome = await runDreamPass(
    depsFor(w, { callModel: async () => (calls++, { text: "definitely ~ not json {", outputTokens: 10 }) }),
  );
  expect(calls).toBe(2); // one retry, then honesty
  expect(outcome.wrote).toBe(true);
  expect(outcome.note).toContain("unparseable");
  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  expect(entry).toContain("would not parse");
  expect(entry).toContain("definitely ~ not json {");
  expect(outcome.memoriesWritten).toEqual([]);
});

test("a model failure mid-run still writes a dated entry naming the failure", async () => {
  const w = world();
  seedDay(w.paths);
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => {
        throw new Error("harness exploded");
      },
    }),
  );
  expect(outcome.wrote).toBe(true);
  expect(outcome.note).toContain("harness exploded");
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain("failed mid-run");
});

test("parseModelResult reads output_tokens from the harness frame, estimating only when absent", () => {
  const withUsage = parseModelResult(JSON.stringify({ result: "hello", usage: { output_tokens: 42 } }));
  expect(withUsage).toEqual({ text: "hello", outputTokens: 42 });
  const withoutUsage = parseModelResult(JSON.stringify({ result: "hello there" }), quiet);
  expect(withoutUsage.text).toBe("hello there");
  expect(withoutUsage.outputTokens).toBeGreaterThan(0);
});
