/**
 * Beckett — deps-update rehearsal (`scripts/ops/deps-update-rehearsal.ts`)
 * =======================================================================================
 * Runs the REAL {@link runDepsUpdate} — real `git clone`, real package-manager update, real
 * typecheck, real test suite — with only the `beckett gh` calls and the Discord post STUBBED, so
 * the weekly routine's whole body can be exercised without touching GitHub. Used to verify issue
 * #85 end to end; keep it for the next time the job needs a change proven before it fires live.
 *
 *   bun scripts/ops/deps-update-rehearsal.ts [--source <checkout>] [--base main]
 *
 * It prints the `DepsUpdateResult` (including the exact `beckett gh` argv it WOULD have run) and
 * exits non-zero if the run did not reach the publish step.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDepsUpdateDeps, runDepsUpdate } from "../../src/ops/deps-update.ts";
import { defaultRepoRoot } from "../../src/version/index.ts";
import { log } from "../../src/log.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const workRoot = join(tmpdir(), "beckett-deps-rehearsal");
mkdirSync(workRoot, { recursive: true });

const would: string[][] = [];
const real = defaultDepsUpdateDeps({ beckettCli: ["bun", "src/cli/beckett.ts"], logger: log.child("rehearsal") });

const result = await runDepsUpdate(
  {
    repo: flag("repo", "kowo-co/beckett"),
    base: flag("base", "main"),
    sourceRepo: flag("source", defaultRepoRoot()),
    workRoot,
    branch: `beckett/deps-rehearsal-${flag("stamp", "local")}`,
    author: { name: "beckett[bot]", email: "beckett[bot]@users.noreply.github.com" },
  },
  {
    ...real,
    // The ONLY stub: nothing reaches GitHub. Everything above it is the real thing.
    async beckett(argv) {
      would.push(argv);
      const url = "https://github.com/kowo-co/beckett/pull/REHEARSAL";
      return { code: 0, stdout: argv.includes("pr") ? JSON.stringify({ number: 0, url }) : "", stderr: "" };
    },
  },
);

console.log(JSON.stringify({ result, wouldHaveRun: would }, null, 2));
if (result.status !== "opened" && result.status !== "no-changes") process.exit(1);
