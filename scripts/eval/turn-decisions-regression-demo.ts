/**
 * `bun run eval:turns:regression` — proof that the turn-decision eval catches a doctrine regression.
 *
 * It scores the denial-diagnosis fixtures twice: once under the REAL doctrine (expected to pass),
 * once under a doctrine where a single rule has been deliberately sabotaged — "A denial is a lead"
 * inverted into "a denial is a dead end, just report it" — and asserts the sabotage flips at least
 * one decision and trips the gate. If the clean run doesn't pass or the sabotaged run doesn't fail,
 * THIS script exits non-zero: the eval would not be doing its job.
 *
 * This is the #78 acceptance demo ("a deliberate doctrine regression is demonstrated to fail it"),
 * kept in the repo as a runnable artifact. It never writes to concierge.md — the regression is
 * applied to an in-memory copy via the harness's `doctrine` override.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenRouterProvider } from "../../src/eval/openrouter.ts";
import { loadTurnFixtures, runTurnDecisionEval, type FixtureResult } from "../../src/eval/turn-decisions.ts";

const model = process.env.TURN_EVAL_MODEL || "anthropic/claude-sonnet-4.5";

const DOCTRINE_PATH = join(import.meta.dir, "..", "..", "src", "concierge", "concierge.md");
const realDoctrine = readFileSync(DOCTRINE_PATH, "utf8");

// The exact real rule the eval protects. If the doctrine wording drifts, this anchor stops matching
// and the demo fails loudly rather than silently testing nothing.
const REAL_RULE =
  "- **A denial is a lead, not a verdict.** Read the actual error and name the gate before you say";
if (!realDoctrine.includes(REAL_RULE)) {
  console.error(
    "Regression demo anchor is stale: the 'A denial is a lead' rule was reworded in concierge.md.\n" +
      "Update REAL_RULE in scripts/eval/turn-decisions-regression-demo.ts to the new wording.",
  );
  process.exit(1);
}

// Sabotage: replace the whole denial paragraph with the opposite instruction.
const SABOTAGED_RULE =
  "- **A denial is a dead end.** If a command fails, just tell the person it failed in one line and\n" +
  "  move on. Do not read the error, name the gate, re-route, or file about it — diagnosing denials\n" +
  "  is not your job.";
const denialParagraphStart = realDoctrine.indexOf(REAL_RULE);
const denialParagraphEnd = realDoctrine.indexOf("\n\n", denialParagraphStart);
const sabotagedDoctrine =
  realDoctrine.slice(0, denialParagraphStart) + SABOTAGED_RULE + realDoctrine.slice(denialParagraphEnd);

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.error("SKIP: no OPENROUTER_API_KEY — the regression demo needs a live model to prove the flip.");
  process.exit(0);
}

const provider = new OpenRouterProvider();
const fixtures = (await loadTurnFixtures()).filter((f) => f.family === "denial-diagnosis");
console.log(`Regression demo — model=${model}, ${fixtures.length} denial-diagnosis fixtures\n`);

function line(tag: string) {
  return (r: FixtureResult) =>
    console.log(
      `  [${tag}] ${r.ok ? "PASS" : "FAIL"} ${r.fixture.id}  ` +
        `got=${r.output ? `${r.output.decision}/${r.output.action}` : "unparseable"} ` +
        `want=${r.fixture.expect.decision}/[${r.fixture.expect.actions.join("|")}]`,
    );
}

console.log("1) Real doctrine (baseline — expected to hold):");
const clean = await runTurnDecisionEval({ provider, fixtures, model, runs: 2, onResult: line("real") });

console.log("\n2) Sabotaged doctrine ('a denial is a dead end' — expected to regress):");
const broken = await runTurnDecisionEval({
  provider,
  fixtures,
  model,
  runs: 2,
  doctrine: sabotagedDoctrine,
  onResult: line("sabotaged"),
});

const flipped = fixtures.filter((f) => {
  const before = clean.results.find((r) => r.fixture.id === f.id);
  const after = broken.results.find((r) => r.fixture.id === f.id);
  return before?.ok && !after?.ok;
});

console.log(
  `\nBaseline gate: ${clean.gatePassed ? "PASSED" : "FAILED"} (${clean.passed}/${clean.total}). ` +
    `Sabotaged gate: ${broken.gatePassed ? "PASSED" : "FAILED"} (${broken.passed}/${broken.total}). ` +
    `Fixtures flipped by the regression: ${flipped.map((f) => f.id).join(", ") || "none"}.`,
);

const demoProven = clean.gatePassed && !broken.gatePassed && flipped.length >= 1;
if (!demoProven) {
  console.error(
    "\nDEMO INCONCLUSIVE: expected the real doctrine to pass and the sabotaged doctrine to fail with\n" +
      "at least one flipped fixture. The eval is not reliably catching this regression — investigate.",
  );
  process.exitCode = 1;
} else {
  console.log("\nDEMO PROVEN: the eval passes on the real doctrine and fails on the deliberate regression.");
}
