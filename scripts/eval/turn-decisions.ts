/**
 * `bun run eval:turns` — the turn-decision behavioral eval (issue #78).
 *
 * Scores fixture turns against the decision Beckett's turn brain makes under the REAL operating
 * doctrine (`src/concierge/concierge.md`) + seeded persona. Exits non-zero when a fixture's decision
 * regresses, so a doctrine edit that makes Beckett worse fails the build.
 *
 * Usage:
 *   bun run eval:turns                       # score every fixture once, gate on any failure
 *   bun run eval:turns --model=anthropic/claude-sonnet-4.5
 *   bun run eval:turns --runs=3              # majority vote per fixture (steadier signal)
 *   bun run eval:turns --allow=1             # tolerate up to N failing fixtures before the gate trips
 *   bun run eval:turns --case=owner          # only fixtures whose id/family contains "owner"
 *
 * Needs OpenRouter credentials (OPENROUTER_API_KEY + OPENROUTER_REFERER) to reach a model.
 */
import { OpenRouterProvider } from "../../src/eval/openrouter.ts";
import { loadTurnFixtures, runTurnDecisionEval, type FixtureResult } from "../../src/eval/turn-decisions.ts";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length);
}

// Sonnet-4.5 is the default: prod-tier judgment that reads the doctrine closely and gives a stable
// green baseline (no false failures), which is what a regression gate needs. Override with --model
// or TURN_EVAL_MODEL. A weaker model (e.g. haiku) is cheaper but flakes on the subtler fixtures.
const DEFAULT_MODEL = process.env.TURN_EVAL_MODEL || "anthropic/claude-sonnet-4.5";

const model = arg("model") ?? DEFAULT_MODEL;
const runs = Number(arg("runs") ?? "1");
if (!Number.isInteger(runs) || runs < 1 || runs > 9) {
  throw new Error(`--runs must be an integer 1..9 (got ${JSON.stringify(arg("runs"))})`);
}
const allowedFailures = Number(arg("allow") ?? "0");
if (!Number.isInteger(allowedFailures) || allowedFailures < 0) {
  throw new Error(`--allow must be a non-negative integer (got ${JSON.stringify(arg("allow"))})`);
}
const caseFilter = arg("case")?.toLowerCase();

const all = await loadTurnFixtures(arg("fixtures"));
const fixtures = caseFilter
  ? all.filter((f) => f.id.toLowerCase().includes(caseFilter) || f.family.toLowerCase().includes(caseFilter))
  : all;
if (fixtures.length === 0) throw new Error(`no fixture matched --case=${JSON.stringify(caseFilter)}`);

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  // A skip is neutral, not a pass: say so loudly and exit 0 so forked-PR runners (no secrets) aren't
  // blocked. The gate is enforced wherever the credentials exist (the trusted repo's CI).
  console.error(
    "SKIP: no OPENROUTER_API_KEY in env — the turn-decision eval cannot reach a model here.\n" +
      "      Set OPENROUTER_API_KEY + OPENROUTER_REFERER (repo secrets) to enforce the gate.",
  );
  process.exit(0);
}

const provider = new OpenRouterProvider();

function report(r: FixtureResult): void {
  const status = r.ok ? "PASS" : r.parseFailed ? "ERR " : "FAIL";
  const got = r.output ? `${r.output.decision}/${r.output.action}` : r.error ? `error: ${r.error}` : "unparseable";
  const want = `${r.fixture.expect.decision}/[${r.fixture.expect.actions.join("|")}]`;
  console.log(`${status} ${r.fixture.id} (${r.fixture.family})  got=${got} want=${want}  ${r.elapsedMs}ms`);
  if (!r.ok && r.output?.message) console.log(`       message: ${JSON.stringify(r.output.message.slice(0, 160))}`);
}

console.log(`turn-decision eval — model=${model} runs=${runs} fixtures=${fixtures.length} allow=${allowedFailures}\n`);
const summary = await runTurnDecisionEval({
  provider,
  fixtures,
  model,
  runs,
  allowedFailures,
  onResult: report,
});

console.log(
  "\n" +
    JSON.stringify(
      {
        model: summary.model,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        parseFailures: summary.parseFailures,
        byFamily: summary.byFamily,
        gate: { passed: summary.gatePassed, allowedFailures: summary.allowedFailures },
      },
      null,
      2,
    ),
);

if (!summary.gatePassed) {
  console.error(`\nGATE FAILED: ${summary.failed} fixture(s) regressed (allowed ${summary.allowedFailures}).`);
  process.exitCode = 1;
} else {
  console.log(`\nGATE PASSED: ${summary.passed}/${summary.total} fixtures hold.`);
}
