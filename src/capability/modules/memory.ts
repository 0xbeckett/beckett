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

import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { createMemory } from "../../memory/index.ts";
import {
  type Audience,
  IdSchema,
  provenanceOf,
  renderProvenanceFrom,
  SELF_AUDIENCE,
  ViewerRoleSchema,
  VisibilitySchema,
} from "../../memory/search.ts";
import type { MemoryAgentSeat } from "../../memory/agent-recall.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { NodeType, RememberIntent } from "../../types.ts";

/**
 * Resolve the recall audience (multiplayer §9.1) from CLI flags. Fail-closed by construction:
 * `--viewer` absent leaves `viewerId` undefined, so the engine returns only public nodes. The
 * concierge passes these on behalf of the live speaker; a human debugging recall passes their
 * own id. `--viewer-role` defaults to `member` and `--context` to `guild` (the safe side).
 *
 * `--as-self` is the one shorthand: Beckett recalling for its OWN reasoning (planning,
 * staffing) — owner-scoped facts included, dm-scoped facts never (see SELF_AUDIENCE in
 * search.ts). It answers "whose eyes?" by itself, so combining it with per-viewer flags is
 * ambiguous and rejected.
 */
function audienceFromFlags(flags: Record<string, string | boolean>): Audience {
  if (flags["as-self"] !== undefined) {
    if (flags.viewer !== undefined || flags["viewer-role"] !== undefined || flags.context !== undefined) {
      fail("--as-self cannot be combined with --viewer/--viewer-role/--context");
    }
    return SELF_AUDIENCE;
  }
  // Reuse the memory module's schemas (search.ts) so the CLI and the engine agree on the exact
  // set of legal roles/visibilities rather than re-listing them here.
  const role = ViewerRoleSchema.safeParse(flags["viewer-role"] ? String(flags["viewer-role"]) : "member");
  if (!role.success) fail("--viewer-role must be one of: owner, maintainer, member");
  const context = flags.context ? String(flags.context) : "guild";
  if (context !== "guild" && context !== "dm") fail("--context must be one of: guild, dm");
  return {
    viewerId: flags.viewer ? String(flags.viewer) : undefined,
    viewerRole: role.data,
    context,
  };
}

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
  /**
   * The `--agent` path of `beckett recall` (issue #26). Runs the memory agent over the gated
   * candidates and prints the concise note or a clean PASS, then a probing follow-up if
   * `--follow-up` is given. Exits (never returns) so the caller short-circuits the score-ranked
   * output — the agent IS the answer here. `--agent` may name a seat (luna|haiku); default luna.
   */
  async function runAgenticRecall(
    memory: ReturnType<typeof createMemory>,
    ctx: {
      text: string;
      types?: string[];
      names?: string[];
      flags: Record<string, string | boolean>;
      audience: Audience;
    },
  ): Promise<never> {
    const { text, types, names, flags, audience } = ctx;
    const seatRaw = flags.agent === true ? "luna" : String(flags.agent);
    if (seatRaw !== "luna" && seatRaw !== "haiku") fail("--agent must be one of: luna, haiku");
    const seat = seatRaw as MemoryAgentSeat;

    const { base, agent } = await memory.recallAgentic(
      {
        text,
        filter: types || names ? { types, names } : undefined,
        k: flags.k ? Number(flags.k) : undefined,
        hops: flags.hops ? Number(flags.hops) : undefined,
        audience,
      },
      { seat },
    );

    const followUpQ = flags["follow-up"] ? String(flags["follow-up"]) : undefined;
    const followUp = followUpQ ? await agent.followUp(followUpQ) : undefined;

    const describe = (a: typeof agent.answer) => ({
      pass: !a.relevant,
      relevant: a.relevant,
      note: a.note,
      noteIds: a.noteIds,
      fallback: a.fallback,
      latencyMs: Math.round(a.latencyMs),
    });

    if (flags.json) {
      out({
        seat,
        answer: describe(agent.answer),
        followUp: followUp ? { question: followUpQ, ...describe(followUp) } : null,
        // The gated candidate pool the agent actually read (audience-filtered in code).
        candidates: base.hits.map((h) => ({ name: h.node.name, type: h.node.type, description: h.node.description })),
      });
    }

    const render = (label: string, a: typeof agent.answer): string[] => {
      const lines = [`# ${label} (seat: ${seat}${a.fallback ? ", fallback: moss ranking" : ""})`];
      if (a.relevant) {
        lines.push(a.note || "(relevant, no prose)");
        lines.push(`cited: ${a.noteIds.join(", ")}`);
      } else {
        lines.push("PASS — nothing on file genuinely adds to this question.");
      }
      return lines;
    };

    const lines = render("recall", agent.answer);
    if (followUp) lines.push("", ...render(`follow-up: ${followUpQ}`, followUp));
    lines.push("", "# candidates read", ...base.hits.map((h) => `- ${h.node.name} (${h.node.type}): ${h.node.description}`));
    out(lines.join("\n"));
  }

  /**
   * The shared recall handler behind BOTH `beckett recall …` (the first-class targeted tool,
   * OPS-121) and `beckett memory recall …` (the original spelling — kept working). Accepts a
   * free-text query, hard `--type`/`--name` filters, or any combination; prints the ranked
   * hits (with file paths, so an entry can be read/edited directly) before the always-loaded
   * global index.
   */
  async function runRecall(argv: string[]): Promise<never> {
    const usage =
      'usage: beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k N] [--hops N] ' +
      "[--agent [luna|haiku]] [--follow-up <question>] " +
      "[--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] [--json]";
    const { _, flags } = parse(argv);
    const text = _.join(" ");
    const csv = (v: string | boolean | undefined) =>
      v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const types = csv(flags.type);
    const names = csv(flags.name);
    if (!text && !types && !names) fail(usage);

    const audience = audienceFromFlags(flags);

    const memory = createMemory({ memoryDir: paths.memoryDir, logger: undefined, git: false });

    // Agentic recall (issue #26): opt-in via --agent. Retrieval + the fail-closed visibility gate
    // run first (in the engine), then a small LLM agent (luna/haiku, CLI only) reads only the gated
    // candidates and passes a concise note or a clean PASS. Absent the flag, behavior is unchanged.
    if (flags.agent !== undefined) {
      await runAgenticRecall(memory, { text, types, names, flags, audience });
    }

    const r = await memory.recall({
      text,
      filter: types || names ? { types, names } : undefined,
      k: flags.k ? Number(flags.k) : undefined,
      hops: flags.hops ? Number(flags.hops) : undefined,
      audience,
    });

    if (flags.json) {
      out({
        hits: r.hits.map((h) => {
          // One parse per hit: read visibility and render the source line off the same Provenance.
          const prov = provenanceOf(h.node);
          return {
            name: h.node.name,
            type: h.node.type,
            score: Number(h.score.toFixed(2)),
            path: h.node.path,
            description: h.node.description,
            visibility: prov.visibility,
            provenance: renderProvenanceFrom(prov),
            body: h.node.body,
          };
        }),
        related: r.expanded.map((e) => ({ name: e.node.name, type: e.node.type, description: e.node.description, visibility: provenanceOf(e.node).visibility, reason: e.reason })),
        phantoms: r.phantoms,
        notes: r.notes,
      });
    }

    const lines: string[] = ["# hits"];
    if (r.hits.length === 0) lines.push("(none — see the index below for everything on file)");
    for (const h of r.hits) {
      const prov = provenanceOf(h.node); // parse once; both the visibility tag and source line use it
      const source = renderProvenanceFrom(prov);
      lines.push(
        `\n## ${h.node.name} (${h.node.type}, score ${h.score.toFixed(2)})`,
        `path: ${h.node.path}`,
        `visibility: ${prov.visibility}${source ? ` · ${source}` : ""}`,
        h.node.description,
        ...(h.node.body ? ["", h.node.body] : []),
      );
    }
    if (r.expanded.length) lines.push("\n# related (linked)\n" + r.expanded.map((e) => `- ${e.node.name}: ${e.node.description} [${e.reason}]`).join("\n"));
    if (r.phantoms.length) lines.push("\n# phantoms: " + r.phantoms.join(", "));
    if (r.notes.length) lines.push("\n# notes: " + r.notes.join("; "));
    lines.push("\n# index");
    for (const il of r.index) lines.push(`- ${il.name} (${il.type}): ${il.description}`);
    out(lines.join("\n"));
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
