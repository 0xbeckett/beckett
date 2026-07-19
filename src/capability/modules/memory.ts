/**
 * Beckett v5 — the memory capability module (`src/capability/modules/memory.ts`)
 * =======================================================================================
 * The in-process markdown memory graph's CLI surface — BOTH `beckett recall …` (the
 * first-class targeted tool, OPS-121) and `beckett memory recall|remember|show|maintain …`
 * (the original spelling — kept working) — normalized onto the common factory shape
 * (V5 Phase 2). Handler bodies and the audience/provenance flag plumbing are the former
 * `cli/beckett.ts` code moved verbatim; the CLI characterization suite pins the observable
 * behavior byte-for-byte.
 */

import { join } from "node:path";
import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { createMemory } from "../../memory/index.ts";
import { provenanceOf, renderProvenanceFrom, IdSchema, VisibilitySchema } from "../../memory/search.ts";
import { parseRecallCliRequest, recallCliOutput } from "../../memory/recall-cli.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { NodeType, RememberIntent } from "../../types.ts";

/**
 * Build the provenance/visibility metadata a `remember` write carries (multiplayer §7), from
 * CLI flags. Only flags actually passed produce keys — an absent flag writes nothing, so the
 * engine merge preserves existing scope on an update. Fails fast on a bad visibility value or
 * a `dm` scope with no partner (`--visibility dm` is meaningless without `--dm-with`).
 */
function provenanceMetadataFromFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  // Same id/visibility shapes the engine enforces (search.ts) — validate against them, don't
  // re-hand-roll the regex/enum here.
  const asId = (flag: string, raw: string): string => {
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) fail(`--${flag} must be a Discord user id (1–20 digits)`);
    return parsed.data;
  };
  if (flags.visibility !== undefined) {
    const vis = VisibilitySchema.safeParse(String(flags.visibility));
    if (!vis.success) fail("--visibility must be one of: public, owner, dm");
    if (vis.data === "dm" && flags["dm-with"] === undefined) {
      fail("--visibility dm requires --dm-with <discordUserId>");
    }
    meta.visibility = vis.data;
  }
  if (flags["dm-with"] !== undefined) meta.dm_with = asId("dm-with", String(flags["dm-with"]));
  if (flags.by !== undefined) meta.source_user = asId("by", String(flags.by));
  if (flags["by-name"] !== undefined) meta.source_name = String(flags["by-name"]);
  return meta;
}

export function createMemoryCapability({ paths }: CapabilityDeps): Capability {
  /** Serve the exact same parser/renderer on the direct path when no daemon is listening. */
  async function runRecall(argv: string[]): Promise<never> {
    let request;
    try {
      // Validate before dialing the daemon: malformed input keeps the historical fast usage error.
      request = parseRecallCliRequest(argv);
    } catch (err) {
      fail((err as Error).message);
    }

    try {
      const { callBus } = await import("../../shell/control-bus.ts");
      const res = await callBus(join(paths.beckettDir, "control.sock"), "memory.recall", { argv }, 5_000);
      if (!res.ok) fail(res.error ?? "memory.recall failed");
      out(res.data);
    } catch (err) {
      if (!String((err as Error).message).startsWith("shell not running")) {
        fail(`daemon reachable but not answering (${(err as Error).message}) — retry, or stop the daemon and re-run`);
      }
      // No daemon is the one safe fallback: a fresh CLI process keeps the legacy cold behavior.
      const memory = createMemory({ memoryDir: paths.memoryDir, logger: undefined, git: false });
      out(await recallCliOutput(memory, request));
    }
  }

  async function runMemory(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const memory = createMemory({
      memoryDir: paths.memoryDir,
      logger: undefined,
      git: sub === "remember" || sub === "maintain",
    });
    if (sub === "recall") await runRecall(rest);
    if (sub === "maintain") {
      // The routine staleness/dedup pass (OPS-121). The daemon runs this daily on its own;
      // the command is for on-demand runs and inspection. `--dry-run` plans without writing.
      const { flags } = parse(rest);
      const report = await memory.maintain({ dryRun: Boolean(flags["dry-run"]) });
      out(report);
    }
    if (sub === "show") {
      const { flags, _ } = parse(rest);
      const nodeName = (flags.name ? String(flags.name) : _[0] ?? "").trim();
      if (!nodeName) fail("usage: beckett memory show <name>");
      // No audience filter here — `show` is an owner-side inspection tool; it surfaces the
      // node's visibility + provenance so a caller can SEE the scope, not enforce it.
      const g = memory.buildGraph();
      const node = g.nodes.get(nodeName);
      if (!node || node.phantom) fail(`memory show: no node named '${nodeName}'`);
      const prov = provenanceOf(node!);
      out({
        name: node!.name,
        type: node!.type,
        path: node!.path,
        visibility: prov.visibility,
        dm_with: prov.dmWith ?? null,
        source_user: prov.sourceUser ?? null,
        source_name: prov.sourceName ?? null,
        provenance: renderProvenanceFrom(prov),
        description: node!.description,
        body: node!.body,
      });
    }
    if (sub === "remember") {
      const { flags } = parse(rest);
      const op = (flags.op as RememberIntent["op"]) ?? "create";
      const name = flags.name as string;
      if (!name) fail("usage: beckett memory remember --name <n> [--op create] [--type t] [--desc d] [--reason r] [--body <text>] [--link to:field,...] [--visibility public|owner|dm] [--dm-with <id>] [--by <userId>] [--by-name <name>]");
      let body = flags.body as string | undefined;
      if (flags["body-stdin"]) body = await Bun.stdin.text();
      const links = flags.link
        ? String(flags.link).split(",").map((s) => {
            const [to, field] = s.split(":");
            return { to: to!, field: field ?? "body" };
          })
        : undefined;
      // Provenance + visibility (multiplayer §7) ride in metadata. Absent flags write nothing,
      // so on an update the engine's `{ ...existing, ...intent }` merge preserves the prior
      // scope — never silently broadening it; an explicit flag is the only way to change it.
      const metadata = provenanceMetadataFromFlags(flags);
      const node = await memory.remember({
        op,
        name,
        type: flags.type ? (String(flags.type) as NodeType) : undefined,
        description: flags.desc ? String(flags.desc) : undefined,
        body,
        links,
        metadata: Object.keys(metadata).length ? metadata : undefined,
        source: (flags.source as RememberIntent["source"]) ?? "conversation",
        reason: flags.reason ? String(flags.reason) : "remember via CLI",
      });
      out({ remembered: node.name, type: node.type, visibility: provenanceOf(node).visibility });
    }
    fail(`unknown: beckett memory ${sub ?? ""} (recall | remember | show | maintain)`);
  }

  return {
    id: "memory",
    summary: "the in-process markdown memory graph",
    actionClass: ActionClass.FREE,
    cliHelp:
      'recall "<query>" [--type t] [--name n] [--as-self | --viewer id] | memory recall|remember|show|maintain',
    cliVerbs: [
      {
        // first-class targeted memory retrieval — OPS-121
        name: "recall",
        summary: "ranked memory recall for a query, with audience scoping",
        usage:
          'beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k N] [--hops N] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] [--json]',
        run: runRecall,
      },
      {
        name: "memory",
        summary: "recall | remember | show | maintain over the markdown graph",
        usage: "beckett memory recall|remember|show|maintain <...>",
        run: runMemory,
      },
    ],
    busCommands: [],
  };
}
