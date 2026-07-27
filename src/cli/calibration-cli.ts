/** `beckett calibration` — direct, visibility-gated per-channel calibration ledger operations. */

import { createMemory } from "../memory/index.ts";
import { CALIBRATION_KINDS, createCalibration, listCalibration } from "../memory/calibration.ts";
import { audienceFromFlags } from "../memory/recall-cli.ts";
import { provenanceOf } from "../memory/search.ts";
import { out, fail, parse } from "./io.ts";
import { paths } from "./context.ts";

const USAGE =
  "usage: beckett calibration [--all] [--channel <id>] [--about <slug>] [--json] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] | " +
  "calibration veto --channel <id> --about <slug> --reason \"<why>\" --source <link> [--by <userId>] [--by-name <name>] | " +
  "calibration hit --channel <id> --about <slug> --reason \"<why>\" --source <link> [--by <userId>] [--by-name <name>]";

export async function runCalibration(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const memory = createMemory({ memoryDir: paths.memoryDir, git: sub === "veto" || sub === "hit" });

  if (!sub || sub.startsWith("--")) {
    const { flags } = parse(sub ? argv : []);
    let audience;
    try {
      audience = audienceFromFlags(flags);
    } catch (err) {
      fail((err as Error).message);
    }
    const records = listCalibration(memory, {
      channel: typeof flags.channel === "string" ? flags.channel : undefined,
      about: typeof flags.about === "string" ? flags.about : undefined,
      audience,
    });
    if (flags.json) {
      out({
        calibration: records.map((r) => ({
          name: r.node.name,
          kind: r.kind,
          channel: r.channel,
          about: r.about,
          reason: r.reason,
          source: r.source,
          observed: r.observed,
          description: r.node.description,
          visibility: provenanceOf(r.node).visibility,
        })),
      });
    }
    out(renderCalibrationList(records));
  }

  const { flags } = parse(rest);

  if (sub === "veto" || sub === "hit") {
    const required = (key: string): string => {
      const value = flags[key];
      if (typeof value !== "string" || !value.trim()) fail(`calibration ${sub}: --${key} is required`);
      return value as string;
    };
    try {
      const entry = await createCalibration(memory, {
        kind: sub as (typeof CALIBRATION_KINDS)[number],
        channel: required("channel"),
        about: required("about"),
        reason: required("reason"),
        source: required("source"),
        by: typeof flags.by === "string" ? flags.by : undefined,
        byName: typeof flags["by-name"] === "string" ? (flags["by-name"] as string) : undefined,
      });
      out({ recorded: entry.node.name, kind: entry.kind, channel: entry.channel, about: entry.about });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  fail(USAGE);
}

/** List records most-recent-first, grouped by channel — the per-room bar at a glance. */
function renderCalibrationList(records: ReturnType<typeof listCalibration>): string {
  if (!records.length) return "(none)";
  // Preserve the most-recent-first order from listCalibration while grouping by channel: a channel
  // heading appears in the order of its newest record.
  const order: string[] = [];
  const byChannel = new Map<string, typeof records>();
  for (const r of records) {
    if (!byChannel.has(r.channel)) {
      byChannel.set(r.channel, []);
      order.push(r.channel);
    }
    byChannel.get(r.channel)!.push(r);
  }
  const lines: string[] = [];
  for (const channel of order) {
    if (lines.length) lines.push("");
    lines.push(`# ${channel}`);
    for (const r of byChannel.get(channel)!) {
      lines.push(`- [${r.kind}] ${r.observed} ${r.about} — "${r.reason}" (${r.source})`);
    }
  }
  return lines.join("\n");
}
