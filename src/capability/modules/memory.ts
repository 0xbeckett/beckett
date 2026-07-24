/**
 * Beckett v6 — the memory extension (`src/capability/modules/memory.ts`)
 * =======================================================================================
 * The in-process markdown memory graph's CLI surface — BOTH `beckett recall …` (the
 * first-class targeted tool, OPS-121) and `beckett memory recall|remember|show|maintain …`
 * (the original spelling — kept working) — on the v6 extension contract.
 *
 * This is a DELIBERATELY THIN migration (Phase 6 / the Zoom live-memory lane owns the organ
 * proper, docs/v6-architecture.md §6-§7): it carries ONLY the v5 facets — the two CLI verbs
 * verbatim plus `cliHelp` — and declares NO capabilities, NO invoke, and NO lifecycle. Building
 * an invoke here would collide with Zoom's in-flight memory/session lane and duplicate the
 * circular in-daemon bus recall, so the extension exists purely so the CLI can register it in
 * `cliExtensions` and project it with {@link asCapability} at its historical spine slot. The
 * organ proper (warm store lifecycle, `memory.*` capabilities, audience built in memory code)
 * lands in Phase 6.
 */

import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { createMemory } from "../../memory/index.ts";
import { provenanceOf, renderProvenanceFrom, IdSchema, VisibilitySchema } from "../../memory/search.ts";
import { parseRecallCliRequest, recallCliOutput } from "../../memory/recall-cli.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { NodeType, RememberIntent } from "../../types.ts";

/**
 * Build the provenance/visibility metadata a `remember` write carries (multiplayer §7), THROWING
 * the historical message on a bad value. Only fields actually passed produce keys — an absent
 * field writes nothing, so the engine merge preserves existing scope on an update. Reached from
 * the CLI wrapper via {@link provenanceMetadataFromFlags}, which catches → `fail`.
 */
function buildProvenanceMetadata(input: {
  visibility?: string;
  dmWith?: string;
  by?: string;
  byName?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  // Same id/visibility shapes the engine enforces (search.ts) — validate against them, don't
  // re-hand-roll the regex/enum here.
  const asId = (flag: string, raw: string): string => {
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`--${flag} must be a Discord user id (1–20 digits)`);
    return parsed.data;
  };
  if (input.visibility !== undefined) {
    const vis = VisibilitySchema.safeParse(input.visibility);
    if (!vis.success) throw new Error("--visibility must be one of: public, owner, dm");
    if (vis.data === "dm" && input.dmWith === undefined) {
      throw new Error("--visibility dm requires --dm-with <discordUserId>");
    }
    meta.visibility = vis.data;
  }
  if (input.dmWith !== undefined) meta.dm_with = asId("dm-with", input.dmWith);
  if (input.by !== undefined) meta.source_user = asId("by", input.by);
  if (input.byName !== undefined) meta.source_name = input.byName;
  return meta;
}

/** The CLI adapter: read the flags, run the shared core, adapt a throw to the historical `fail`. */
function provenanceMetadataFromFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
  try {
    return buildProvenanceMetadata({
      visibility: flags.visibility !== undefined ? String(flags.visibility) : undefined,
      dmWith: flags["dm-with"] !== undefined ? String(flags["dm-with"]) : undefined,
      by: flags.by !== undefined ? String(flags.by) : undefined,
      byName: flags["by-name"] !== undefined ? String(flags["by-name"]) : undefined,
    });
  } catch (err) {
    fail((err as Error).message);
  }
}

export const createMemoryExtension: ExtensionFactory = ({ paths }): Extension => {
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
      const { join } = await import("node:path");
      // Agentic recall may spend up to 45s in its model seat; unlike channels, this bus request
      // needs to preserve that established command budget rather than declaring the daemon dead.
      const res = await callBus(join(paths.beckettDir, "control.sock"), "memory.recall", { argv }, 60_000);
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
    manifest: {
      id: "memory",
      version: "1.0.0",
      summary: "the in-process markdown memory graph",
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // NO capabilities/invoke/lifecycle (the Phase 6 / Zoom live-lane fence): this extension is
    // v5 facets only until the memory organ proper migrates.

    // --- v5 facets, carried through unchanged ---
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
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createMemoryCapability(deps: CapabilityDeps): Capability {
  return asCapability(createMemoryExtension(deps));
}
