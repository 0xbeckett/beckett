/** `beckett loops` — direct, visibility-gated open-loop ledger operations. */

import { createMemory } from "../memory/index.ts";
import { LOOP_KINDS, listLoops, noteLoop, openLoop, settleLoop } from "../memory/loops.ts";
import { audienceFromFlags } from "../memory/recall-cli.ts";
import { provenanceOf } from "../memory/search.ts";
import { out, fail, parse } from "./io.ts";
import { paths } from "./context.ts";

const USAGE =
  "usage: beckett loops [--all] [--json] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] | " +
  "loops open --name <n> --kind commitment|recurring-error|wishlist --due <YYYY-MM-DD> --source <s> --desc <d> [--closes <c>] | " +
  "loops note <name> --note <text> | loops close <name> [--note <text>] | loops drop <name> --note <why>";

export async function runLoops(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const memory = createMemory({ memoryDir: paths.memoryDir, git: sub === "open" || sub === "close" || sub === "drop" || sub === "note" });

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
          lastTouched: loop.lastTouched,
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

  if (sub === "note") {
    const name = _[0]?.trim();
    if (!name) fail("usage: beckett loops note <name> --note <text>");
    const note = typeof flags.note === "string" ? flags.note : undefined;
    try {
      const entry = await noteLoop(memory, name, note, audience);
      out({ noted: entry.node.name, last_touched: entry.lastTouched });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  if (sub === "close" || sub === "drop") {
    const name = _[0]?.trim();
    if (!name) fail(`usage: beckett loops ${sub} <name>${sub === "drop" ? " --note <why>" : " [--note <text>]"}`);
    const note = typeof flags.note === "string" ? flags.note : undefined;
    try {
      const entry = await settleLoop(memory, name, sub === "close" ? "done" : "dropped", note, audience);
      out(sub === "close"
        ? { closed: entry.node.name, closed_at: entry.closed }
        : { dropped: entry.node.name, closed_at: entry.closed });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  fail(USAGE);
}

function renderLoopList(loops: ReturnType<typeof listLoops>): string {
  if (!loops.length) return "(none)";
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  for (const kind of LOOP_KINDS) {
    const group = loops.filter((loop) => loop.kind === kind);
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(`# ${kind}`);
    for (const loop of group) {
      lines.push(
        `- ${loop.overdue ? "OVERDUE " : ""}${loop.due} [${loop.kind}] [${loop.status}] (${touchedLabel(loop.lastTouched, today)}) ${loop.source} — ${loop.node.description}`,
      );
    }
  }
  return lines.join("\n");
}

/** How long since a loop was last noted — the at-a-glance "have I worked this?" signal. */
function touchedLabel(lastTouched: string | null, today: string): string {
  if (!lastTouched) return "never touched";
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastTouched}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return "touched today";
  if (days === 1) return "touched 1d ago";
  return `touched ${days}d ago`;
}
