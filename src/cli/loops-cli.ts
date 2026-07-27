/** `beckett loops` — direct, visibility-gated open-loop ledger operations. */

import { createMemory } from "../memory/index.ts";
import { LOOP_KINDS, listLoops, openLoop, settleLoop } from "../memory/loops.ts";
import { audienceFromFlags } from "../memory/recall-cli.ts";
import { provenanceOf } from "../memory/search.ts";
import { out, fail, parse } from "./io.ts";
import { paths } from "./context.ts";

const USAGE =
  "usage: beckett loops [--all] [--json] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] | " +
  "loops open --name <n> --kind commitment|recurring-error|wishlist --due <YYYY-MM-DD> --source <s> --desc <d> [--closes <c>] | " +
  "loops close <name> [--note <text>] | loops drop <name> --note <why>";

export async function runLoops(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const memory = createMemory({ memoryDir: paths.memoryDir, git: sub === "open" || sub === "close" || sub === "drop" });

  if (!sub || sub.startsWith("--")) {
    const listArgv = sub ? argv : [];
    const { flags } = parse(listArgv);
    let audience;
    try {
      audience = audienceFromFlags(flags);
    } catch (err) {
      fail((err as Error).message);
    }
    const loops = listLoops(memory, { all: flags.all === true, audience });
    if (flags.json) {
      out({
        loops: loops.map((loop) => ({
          name: loop.node.name,
          kind: loop.kind,
          status: loop.status,
          due: loop.due,
          opened: loop.opened,
          source: loop.source,
          closes: loop.closes,
          closed: loop.closed ?? null,
          overdue: loop.overdue,
          description: loop.node.description,
          visibility: provenanceOf(loop.node).visibility,
        })),
      });
    }
    out(renderLoopList(loops));
  }

  const { _, flags } = parse(rest);
  let audience;
  try {
    audience = audienceFromFlags(flags);
  } catch (err) {
    fail((err as Error).message);
  }

  if (sub === "open") {
    const required = (key: string): string => {
      const value = flags[key];
      if (typeof value !== "string" || !value.trim()) fail(`loops open: --${key} is required`);
      return value;
    };
    const entry = await openLoop(memory, {
      name: required("name"),
      kind: required("kind") as (typeof LOOP_KINDS)[number],
      due: required("due"),
      source: required("source"),
      description: required("desc"),
      closes: typeof flags.closes === "string" ? flags.closes : undefined,
    });
    out({ opened: entry.node.name, due: entry.due, kind: entry.kind });
  }

  if (sub === "close" || sub === "drop") {
    const name = _[0]?.trim();
    if (!name) fail(`usage: beckett loops ${sub} <name>${sub === "drop" ? " --note <why>" : " [--note <text>]"}`);
    const note = typeof flags.note === "string" ? flags.note : undefined;
    try {
      const entry = await settleLoop(memory, name, sub === "close" ? "done" : "dropped", note, audience);
      out({ [sub === "close" ? "closed" : "dropped"]: entry.node.name, closed: entry.closed });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  fail(USAGE);
}

function renderLoopList(loops: ReturnType<typeof listLoops>): string {
  if (!loops.length) return "(none)";
  const lines: string[] = [];
  for (const kind of LOOP_KINDS) {
    const group = loops.filter((loop) => loop.kind === kind);
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(`# ${kind}`);
    for (const loop of group) {
      lines.push(
        `- ${loop.overdue ? "OVERDUE " : ""}${loop.due} [${loop.kind}] [${loop.status}] ${loop.source} — ${loop.node.description}`,
      );
    }
  }
  return lines.join("\n");
}
