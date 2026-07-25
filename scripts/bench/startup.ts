/**
 * Beckett — CLI cold-start benchmark (`scripts/bench/startup.ts`, issue #91)
 * =======================================================================================
 * Proves (and guards against regressing) the lazy-command-loading win: how many milliseconds
 * `bun src/cli/beckett.ts <verb>` costs just to ROUTE and run a representative verb up to its
 * first cheap boundary (usage/validation/dead-daemon). Before #91 the entry statically dragged
 * playwright (~320ms) + discord.js (~240ms) into EVERY invocation for a ~550ms floor; after,
 * the entry loads only the routed verb's graph.
 *
 *   bun run bench:startup            # human table
 *   bun run bench:startup --json     # machine-readable {verb, runs, minMs, medianMs}
 *
 * Each verb is spawned in a hermetic sandbox (fresh temp HOME/BECKETT_DIR, PATH-only env) so no
 * host state or daemon socket skews the number — the argv is chosen to hit an in-process usage
 * path or an instant dead-socket refusal, never the network. The reported figure is the module
 * load + route + boundary cost, i.e. the cold-start tax paid on every `beckett` shell-out.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const cliPath = join(repoRoot, "src", "cli", "beckett.ts");

/** The representative verbs: the four cold-start-critical ones (#91 acceptance) + a router-only floor. */
const VERBS: Array<{ label: string; argv: string[] }> = [
  { label: "(router only)", argv: ["__unknown_command__"] },
  { label: "status", argv: ["status"] },
  { label: "recall", argv: ["recall", "beckett"] },
  { label: "task show", argv: ["task", "show", "#1"] },
  { label: "discord reply", argv: ["discord", "reply", "--channel", "1", "hi"] },
];

const RUNS = 5;
const WARMUP = 1; // one discarded run per verb so the transpile cache is warm and numbers are steady

/** Spawn one `beckett …` invocation hermetically and return its wall-clock ms. */
async function timeOnce(argv: string[]): Promise<number> {
  const sandbox = mkdtempSync(join(tmpdir(), "beckett-bench-"));
  const home = join(sandbox, "home");
  const beckettDir = join(sandbox, ".beckett");
  mkdirSync(home, { recursive: true });
  mkdirSync(beckettDir, { recursive: true });
  try {
    const started = performance.now();
    const proc = Bun.spawn(["bun", cliPath, ...argv], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: home, BECKETT_HOME: home, BECKETT_DIR: beckettDir },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return performance.now() - started;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const results: Array<{ verb: string; runs: number; minMs: number; medianMs: number }> = [];
  for (const { label, argv } of VERBS) {
    for (let i = 0; i < WARMUP; i++) await timeOnce(argv);
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) samples.push(await timeOnce(argv));
    results.push({
      verb: label,
      runs: RUNS,
      minMs: Math.round(Math.min(...samples)),
      medianMs: Math.round(median(samples)),
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ cli: cliPath, results }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`beckett CLI cold-start — ${RUNS} runs each (bun src/cli/beckett.ts <verb>)\n`);
  process.stdout.write("  verb                     median     min\n");
  for (const r of results) {
    process.stdout.write(`  ${r.verb.padEnd(22)} ${String(r.medianMs + "ms").padStart(7)} ${String(r.minMs + "ms").padStart(7)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`bench:startup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
