/**
 * `beckett dream` — read the dream journal back, and the routine body for the nightly pass.
 *
 *   - `dream ls`            list entries (newest first; truncated nights flagged)
 *   - `dream show <date>`   print one entry verbatim
 *   - `dream run`           the `nightly-dream` routine's BODY (issue #36) — spawned detached
 *                           by the self lane's dispatch fork, or run by hand. Contained by
 *                           construction: read-only assembly, a tool-less reflection call under
 *                           the config token ceiling, and writes only to `~/.beckett/dreams/`
 *                           plus create-only `dream`-namespace memories.
 */

import { listDreamEntries, readDreamEntry } from "../dream/journal.ts";
import { out, fail, parse, quietLogger } from "./io.ts";
import { config, paths } from "./context.ts";

const USAGE =
  "usage: beckett dream ls [--json] | dream show <YYYY-MM-DD> | dream run [--force] [--routine <id>] [--requester <id>]";

export async function runDream(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "ls" || sub === "list") {
    const { flags } = parse(rest);
    const entries = listDreamEntries(paths.dreamsDir);
    if (flags.json) out({ entries });
    if (!entries.length) out("(no dreams yet)");
    out(
      entries
        .map((e) => `- ${e.date}  ${String(e.bytes).padStart(6)}B${e.truncated ? "  [truncated]" : ""}`)
        .join("\n"),
    );
  }

  if (sub === "show") {
    const date = rest[0]?.trim();
    if (!date) fail("usage: beckett dream show <YYYY-MM-DD>");
    let content: string | null = null;
    try {
      content = readDreamEntry(paths.dreamsDir, date!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (content === null) fail(`no dream entry for ${date}`);
    out(content!);
  }

  if (sub === "run") {
    const { flags } = parse(rest);
    // Imported lazily: ls/show must stay cheap and never drag the run graph (memory, channels).
    const { runDreamPass } = await import("../dream/run.ts");
    const outcome = await runDreamPass({
      config,
      paths,
      logger: quietLogger,
      routineId: flags.routine ? String(flags.routine) : "manual",
      force: flags.force === true,
    });
    out(outcome);
  }

  fail(USAGE);
}
