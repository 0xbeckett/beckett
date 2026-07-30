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
import { PROPOSAL_TTL_DAYS, createProposal, listProposals, readProposal } from "../proposal/store.ts";
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

// ── proposals (issue #37) — the dream ASKS; it never does ──────────────────────────────

/** A synthesis that wants doctrine changed. The only thing it can get is a record. */
const WITH_PROPOSALS = (proposals: unknown[]): string =>
  JSON.stringify({ ...JSON.parse(SYNTHESIS), memories: [], proposals });

test("a dream emits proposals as RECORDS in the queue — no doctrine, persona, or memory is touched", async () => {
  const w = world();
  seedDay(w.paths);
  writeFileSync(w.paths.personaFile, "the original persona\n");
  const personaBefore = readFileSync(w.paths.personaFile, "utf8");

  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({
        text: WITH_PROPOSALS([
          {
            kind: "doctrine-change",
            claim: "stop asking for confirmation on read-only commands",
            rationale: "Three turns last night spent confirming a `ls`.",
            provenance: ["journal:#31"],
          },
        ]),
        outputTokens: 200,
      }),
    }),
  );

  expect(outcome.proposalsRaised.length).toBe(1);
  expect(outcome.proposalsDropped).toEqual([]);
  const proposal = readProposal(w.paths.proposalsDir, outcome.proposalsRaised[0]!)!;
  expect(proposal.kind).toBe("doctrine-change");
  expect(proposal.status).toBe("open");
  expect(proposal.origin).toBe(`dream:${DATE}`);
  expect(proposal.provenance).toEqual(["journal:#31"]);
  // The record is the ONLY thing that moved: persona is byte-identical and no memory was written.
  expect(readFileSync(w.paths.personaFile, "utf8")).toBe(personaBefore);
  expect(outcome.memoriesWritten).toEqual([]);
  // Proposals live outside the memory graph entirely — not real memories, not dream inferences.
  expect([...w.memory.buildGraph().nodes.keys()]).toEqual([]);
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain(`proposals: ${proposal.id}`);
});

test("a proposal is refused for a kind that does not exist, or provenance that was not assembled", async () => {
  const w = world();
  seedDay(w.paths);
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({
        text: WITH_PROPOSALS([
          { kind: "doctrine-change", claim: "cite a dm", rationale: "because", provenance: ["dm:owner"] },
          { kind: "apply-patch", claim: "just do it", rationale: "because", provenance: ["journal:#31"] },
        ]),
        outputTokens: 100,
      }),
    }),
  );
  // An unknown kind fails the schema outright, so the whole reply is retried then kept raw —
  // the queue never sees an invented kind, and nothing is half-applied.
  expect(outcome.proposalsRaised).toEqual([]);
  expect(listProposals(w.paths.proposalsDir, { all: true })).toEqual([]);
});

test("provenance naming a source that was never assembled drops the proposal, on the record", async () => {
  const w = world();
  seedDay(w.paths);
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({
        text: WITH_PROPOSALS([
          { kind: "persona-change", claim: "sound colder", rationale: "a dm said so", provenance: ["dm:owner"] },
        ]),
        outputTokens: 100,
      }),
    }),
  );
  expect(outcome.proposalsRaised).toEqual([]);
  expect(outcome.proposalsDropped[0]).toContain("unknown sources");
  expect(listProposals(w.paths.proposalsDir, { all: true })).toEqual([]);
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain("proposals_dropped");
});

test("the nightly pass sweeps the queue on the way in: undecided proposals expire, they do not pile up", async () => {
  const w = world();
  seedDay(w.paths);
  const stale = createProposal(w.paths.proposalsDir, {
    kind: "ticket",
    claim: "an idea nobody ever answered",
    rationale: "raised a fortnight ago",
    provenance: ["journal:#1"],
    origin: "dream:2026-07-01",
    now: new Date(NOW.getTime() - (PROPOSAL_TTL_DAYS + 1) * 86_400_000),
  });
  const outcome = await runDreamPass(
    depsFor(w, { callModel: async () => ({ text: WITH_PROPOSALS([]), outputTokens: 50 }) }),
  );
  expect(outcome.proposalsExpired).toEqual([stale.id]);
  const stored = readProposal(w.paths.proposalsDir, stale.id)!;
  expect(stored.status).toBe("expired");
  expect(stored.claim).toBe("an idea nobody ever answered");
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain(`proposals_expired: ${stale.id}`);
});

// ── the overnight spike (issue #38) ─────────────────────────────────────────────────────

import { openLoop } from "../memory/loops.ts";
import { spikePlanProblem } from "./run.ts";
import type { SpikeRecord } from "./spike.ts";

/** Two open loops on the ledger so `loop:alpha` / `loop:beta` are real source ids tonight. */
async function seedLoops(memory: MemoryStore): Promise<void> {
  for (const name of ["alpha", "beta"]) {
    await openLoop(memory, {
      name,
      kind: "commitment",
      due: "2026-08-01",
      source: "self",
      description: `the ${name} loop`,
    });
  }
}

const SPIKE = {
  slug: "pair-probe",
  pair: ["loop:alpha", "loop:beta"],
  question: "are these one problem?",
  rationale: "both reduce to the same rendering step",
  plan: "render one through the other",
};

function fakeRecord(over: Partial<SpikeRecord> = {}): SpikeRecord {
  return {
    id: `spike-${DATE}-pair-probe`,
    date: DATE,
    pair: SPIKE.pair,
    question: SPIKE.question,
    rationale: SPIKE.rationale,
    plan: SPIKE.plan,
    repoRoot: "/repo",
    branch: `dream/spike/${DATE}-pair-probe`,
    worktree: "/w",
    status: "done",
    outputTokens: 700,
    budget: 60_000,
    findingPath: `/spikes/spike-${DATE}-pair-probe/finding.md`,
    diffPath: null,
    proposalId: "prop-2026-07-26-overnight-spike",
    created: NOW.toISOString(),
    gcAt: null,
    note: null,
    ...over,
  };
}

test("no pairing is the common case: one cheap line in the journal, no spike machinery touched", async () => {
  const w = world();
  seedDay(w.paths);
  let spikeCalls = 0;
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({ text: SYNTHESIS, outputTokens: 500 }),
      runSpikeImpl: (async () => (spikeCalls++, fakeRecord())) as never,
    }),
  );

  expect(outcome.spike).toBeNull();
  expect(outcome.spikeNote).toBe("no pairing worth a spike tonight");
  expect(spikeCalls).toBe(0);
  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  expect(entry).toContain("spike: (none — no pairing worth a spike tonight)");
  expect(entry).toContain("No spike tonight — no pairing worth a spike tonight.");
});

test("a valid pairing runs at most ONE spike under a sub-budget carved from the ceiling, and the journal points at its artifact", async () => {
  const w = world();
  seedDay(w.paths);
  await seedLoops(w.memory);
  const withSpike = { ...JSON.parse(SYNTHESIS), spike: SPIKE };
  const budgets: number[] = [];
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({ text: JSON.stringify(withSpike), outputTokens: 500 }),
      runSpikeImpl: (async (spikeDeps: { budget: number; plan: { pair: string[] } }) => {
        budgets.push(spikeDeps.budget);
        expect(spikeDeps.plan.pair).toEqual(["loop:alpha", "loop:beta"]);
        return fakeRecord();
      }) as never,
    }),
  );

  // The sub-budget is min(config carve, what the pass had left) — carved OUT of the ceiling.
  expect(budgets).toEqual([Math.min(defaultConfig().dream.spike_output_token_budget, 150_000 - 500)]);
  expect(outcome.spike!.id).toBe(`spike-${DATE}-pair-probe`);
  // The spike's spend counts against the SAME nightly ceiling as the reflection calls.
  expect(outcome.outputTokens).toBe(500 + 700);

  const entry = readDreamEntry(w.paths.dreamsDir, DATE)!;
  expect(entry).toContain("## overnight spike");
  expect(entry).toContain(`spike: spike-${DATE}-pair-probe [done] artifact: /spikes/spike-${DATE}-pair-probe/finding.md`);
  expect(entry).toContain("never merged, never pushed, never deployed");
  expect(entry).toContain("proposal prop-2026-07-26-overnight-spike");
});

test("a pairing that names non-loop or unassembled sources is dropped in one line — no worktree, no harness", async () => {
  const w = world();
  seedDay(w.paths);
  const laundered = { ...JSON.parse(SYNTHESIS), spike: { ...SPIKE, pair: ["journal:#31", "loop:phantom"] } };
  let spikeCalls = 0;
  const outcome = await runDreamPass(
    depsFor(w, {
      callModel: async () => ({ text: JSON.stringify(laundered), outputTokens: 100 }),
      runSpikeImpl: (async () => (spikeCalls++, fakeRecord())) as never,
    }),
  );
  expect(spikeCalls).toBe(0);
  expect(outcome.spike).toBeNull();
  expect(outcome.spikeNote).toContain("spike dropped");
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain("spike: (none — spike dropped");
});

test("a ceiling already spent abandons the spike with a note — the journal is never the thing sacrificed", async () => {
  const w = world();
  seedDay(w.paths);
  await seedLoops(w.memory);
  const withSpike = { ...JSON.parse(SYNTHESIS), spike: SPIKE };
  let spikeCalls = 0;
  const outcome = await runDreamPass(
    depsFor(w, {
      budget: 500, // synthesis eats exactly the ceiling; nothing is left for the spike
      callModel: async () => ({ text: JSON.stringify(withSpike), outputTokens: 500 }),
      runSpikeImpl: (async () => (spikeCalls++, fakeRecord())) as never,
    }),
  );
  expect(spikeCalls).toBe(0);
  expect(outcome.wrote).toBe(true);
  expect(outcome.spikeNote).toContain("abandoned before start");
  expect(readDreamEntry(w.paths.dreamsDir, DATE)!).toContain("spike abandoned before start");
});

test("spikePlanProblem spells out the bar: distinct, assembled, loop-shaped sources with a written why", () => {
  const known = new Set(["loop:a", "loop:b", "calibration:c", "journal:#1"]);
  const base = { slug: "s", pair: ["loop:a", "loop:b"], question: "q?", rationale: "because together" };
  expect(spikePlanProblem(base, known)).toBeNull();
  expect(spikePlanProblem({ ...base, pair: ["loop:a", "calibration:c"] }, known)).toBeNull();
  expect(spikePlanProblem({ ...base, pair: ["loop:a", "loop:a"] }, known)).toContain("DISTINCT");
  expect(spikePlanProblem({ ...base, pair: ["loop:a", "loop:zzz"] }, known)).toContain("unknown sources");
  expect(spikePlanProblem({ ...base, pair: ["loop:a", "journal:#1"] }, known)).toContain("open loops or calibration");
  expect(spikePlanProblem({ ...base, pair: ["calibration:c", "calibration:c2"] }, new Set([...known, "calibration:c2"]))).toContain(
    "at least one side must be an open loop",
  );
  expect(spikePlanProblem({ ...base, question: " " }, known)).toContain("question");
  expect(spikePlanProblem({ ...base, rationale: "" }, known)).toContain("rationale");
});

test("parseModelResult reads output_tokens from the harness frame, estimating only when absent", () => {
  const withUsage = parseModelResult(JSON.stringify({ result: "hello", usage: { output_tokens: 42 } }));
  expect(withUsage).toEqual({ text: "hello", outputTokens: 42 });
  const withoutUsage = parseModelResult(JSON.stringify({ result: "hello there" }), quiet);
  expect(withoutUsage.text).toBe("hello there");
  expect(withoutUsage.outputTokens).toBeGreaterThan(0);
});
