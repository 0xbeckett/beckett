/**
 * `bun scripts/eval/turn-decisions-compare.ts --models=<slug1>,<slug2>,...` — sweep the
 * turn-decision behavioral eval (`src/eval/turn-decisions.ts`, issue #78) across several models
 * and print a side-by-side comparison, instead of the single-model CI gate in
 * `scripts/eval/turn-decisions.ts`.
 *
 * Built for issue #128 (concierge → Sonnet-5 @ medium): before trusting the cheap seat for chat,
 * this is the tool to point at "does Sonnet-5 still hold the same doctrine judgments Opus-5 did?"
 * It is DELIBERATELY informational only — it does not exit non-zero and is NOT wired into
 * `eval:turns`. "Model A beats model B" is a different question from "did this doctrine edit
 * regress," which is what the CI gate answers. Reuses `runTurnDecisionEval` completely unmodified
 * (it already takes `model: string` per call, src/eval/turn-decisions.ts:225-239) — zero edits to
 * the production eval module.
 *
 * NOT RUN as part of writing this file (it costs real OpenRouter budget: fixtures × models ×
 * runs). Documented invocation:
 *
 *   OPENROUTER_API_KEY=... OPENROUTER_REFERER=... \
 *     bun scripts/eval/turn-decisions-compare.ts --models=<opus-slug>,<sonnet-slug>,<haiku-slug> --runs=3
 *
 * No default `--models` is baked in. The existing single-model gate's own default
 * ("anthropic/claude-sonnet-4.5", scripts/eval/turn-decisions.ts:27) is already NOT the same
 * string as Beckett's internal harness alias ("claude-sonnet-5") — the two naming schemes don't
 * line up by pattern-matching, and OpenRouter's actual catalog slugs for opus-5/haiku-4-5 were not
 * confirmed while writing this script. Guessing a default here would silently benchmark the wrong
 * model. `--models` is required; the script refuses to run without it.
 */
import { OpenRouterProvider } from "../../src/eval/openrouter.ts";
import { loadTurnFixtures, runTurnDecisionEval, type TurnEvalSummary } from "../../src/eval/turn-decisions.ts";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length);
}

/** Split and validate the required `--models` flag. Exported so the test can drive it without argv. */
export function parseModelsArg(raw: string | undefined): string[] {
  const models = (raw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new Error(
      "--models is required (comma-separated OpenRouter slugs) — no default is baked in; " +
        "see the header comment for why.",
    );
  }
  return [...new Set(models)];
}

/**
 * Render a fixture-id × model pass/fail table plus a totals row and a per-model family
 * breakdown. Pure and network-free — the only thing this script has worth unit-testing, since
 * `runTurnDecisionEval` itself is exhaustively covered by src/eval/turn-decisions.test.ts.
 */
export function formatComparisonTable(summaries: TurnEvalSummary[]): string {
  if (summaries.length === 0) return "(no models given)";

  const fixtureIds = summaries[0]!.results.map((r) => r.fixture.id);
  const idWidth = Math.max(2, ...fixtureIds.map((id) => id.length));
  const modelWidth = Math.max(5, ...summaries.map((s) => s.model.length));

  const lines: string[] = [];
  const header = ["fixture".padEnd(idWidth), ...summaries.map((s) => s.model.padEnd(modelWidth))];
  lines.push(header.join("  "));
  lines.push(header.map((h) => "-".repeat(h.length)).join("  "));

  for (const id of fixtureIds) {
    const cells = summaries.map((s) => {
      const r = s.results.find((res) => res.fixture.id === id);
      const cell = r ? (r.ok ? "PASS" : r.parseFailed ? "ERR " : "FAIL") : "?   ";
      return cell.padEnd(modelWidth);
    });
    lines.push([id.padEnd(idWidth), ...cells].join("  "));
  }

  lines.push(header.map((h) => "-".repeat(h.length)).join("  "));
  const totals = summaries.map((s) => `${s.passed}/${s.total}`.padEnd(modelWidth));
  lines.push(["TOTAL".padEnd(idWidth), ...totals].join("  "));

  lines.push("");
  lines.push("By family:");
  const families = Object.keys(summaries[0]!.byFamily);
  for (const family of families) {
    const perModel = summaries
      .map((s) => `${s.model}=${s.byFamily[family]?.passed ?? 0}/${s.byFamily[family]?.total ?? 0}`)
      .join("  ");
    lines.push(`  ${family}: ${perModel}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const models = parseModelsArg(arg("models"));
  const runs = Number(arg("runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) {
    throw new Error(`--runs must be an integer 1..9 (got ${JSON.stringify(arg("runs"))})`);
  }
  const caseFilter = arg("case")?.toLowerCase();

  const all = await loadTurnFixtures(arg("fixtures"));
  const fixtures = caseFilter
    ? all.filter((f) => f.id.toLowerCase().includes(caseFilter) || f.family.toLowerCase().includes(caseFilter))
    : all;
  if (fixtures.length === 0) throw new Error(`no fixture matched --case=${JSON.stringify(caseFilter)}`);

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error(
      "SKIP: no OPENROUTER_API_KEY in env — this comparison sweep cannot reach a model here.\n" +
        "      Set OPENROUTER_API_KEY + OPENROUTER_REFERER, then see the header comment for the\n" +
        "      documented invocation. This costs real budget: fixtures × models × --runs calls.",
    );
    process.exit(0);
  }

  const provider = new OpenRouterProvider();
  console.log(`turn-decision comparison — models=${models.join(", ")} runs=${runs} fixtures=${fixtures.length}\n`);

  const summaries: TurnEvalSummary[] = [];
  for (const model of models) {
    console.log(`scoring ${model}...`);
    const summary = await runTurnDecisionEval({ provider, fixtures, model, runs });
    summaries.push(summary);
  }

  console.log(`\n${formatComparisonTable(summaries)}`);
  // Informational only — never exitCode 1 here. See header comment: this is not the CI gate.
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exit(1);
  });
}
