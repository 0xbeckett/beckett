#!/usr/bin/env bun
/**
 * Beckett — the `beckett` CLI entry (`src/cli/beckett.ts`)
 * =======================================================================================
 * The command surface the PARENT agent drives via Bash (Spec 05). Stateful verbs (worker
 * control, discord reply, status, …) forward to the shell over the control bus; in-process
 * verbs (memory, task, plan, …) run against local state. Output is JSON on stdout (the parent
 * reads it); errors go to stderr with a non-zero exit.
 *
 * Cold-start discipline (issue #91): this entry's ONLY job is to ROUTE. It resolves the argv
 * against the static spine (`./spine.ts`) and only then `import()`s the one verb's body, so a
 * `beckett <verb>` never loads a runtime it doesn't use — the ~550ms tax of statically dragging
 * playwright + discord.js into every invocation is gone. Keep this file's static graph minimal:
 * argv routing, `./io.ts`, and `./spine.ts`. Anything that reaches a verb implementation (and
 * thus config, the tracker, the browser, Discord, …) must stay behind the spine's lazy `load()`.
 *
 * The CLI characterization suite (`src/cli/characterization.test.ts`) pins the observable
 * behavior — dispatch, exit codes, usage/error text, `--json` shapes — byte-for-byte.
 */

import { fail } from "./io.ts";
import { composeCliHelp, resolveVerb } from "./spine.ts";

/**
 * Thin dispatch: resolve the argv against the spine (longest verb first, so "discord reply" wins
 * over a bare "discord"), lazy-load the matched verb's body, and hand it the raw tail. A miss
 * prints the unknown-command refusal with the command list composed from the spine.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hit = resolveVerb(argv);
  if (hit) {
    const run = await hit.load();
    await run(hit.rest);
    return;
  }
  const [group, sub] = argv;
  fail(`unknown command: beckett ${group ?? ""} ${sub ?? ""}\n` + `commands: ${composeCliHelp()}`);
}

main().catch((err) => fail((err as Error).message));
