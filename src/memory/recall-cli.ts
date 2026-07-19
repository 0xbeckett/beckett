/** Shared `beckett recall` parsing and rendering for the CLI and warm daemon bus. */

import { parse } from "../cli/io.ts";
import type { MemoryStore } from "./index.ts";
import {
  type Audience,
  provenanceOf,
  renderProvenanceFrom,
  SELF_AUDIENCE,
  ViewerRoleSchema,
} from "./search.ts";
import type { MemoryAgentSeat } from "./agent-recall.ts";

export interface RecallCliRequest {
  text: string;
  types?: string[];
  names?: string[];
  flags: Record<string, string | boolean>;
  audience: Audience;
}

/** Parse the CLI spelling once, so direct and daemon recall have identical inputs and gates. */
export function parseRecallCliRequest(argv: string[]): RecallCliRequest {
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
  if (!text && !types && !names) throw new Error(usage);

  return { text, types, names, flags, audience: audienceFromFlags(flags) };
}

/** Render one parsed recall through an already-owned memory store. */
export async function recallCliOutput(memory: MemoryStore, request: RecallCliRequest): Promise<unknown> {
  const { text, types, names, flags, audience } = request;
  if (flags.agent !== undefined) return agenticRecallOutput(memory, request);

  const r = await memory.recall({
    text,
    filter: types || names ? { types, names } : undefined,
    k: flags.k ? Number(flags.k) : undefined,
    hops: flags.hops ? Number(flags.hops) : undefined,
    audience,
  });

  if (flags.json) {
    return {
      hits: r.hits.map((h) => {
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
      related: r.expanded.map((e) => ({
        name: e.node.name,
        type: e.node.type,
        description: e.node.description,
        visibility: provenanceOf(e.node).visibility,
        reason: e.reason,
      })),
      phantoms: r.phantoms,
      notes: r.notes,
    };
  }

  const lines: string[] = ["# hits"];
  if (r.hits.length === 0) lines.push("(none — see the index below for everything on file)");
  for (const h of r.hits) {
    const prov = provenanceOf(h.node);
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
  return lines.join("\n");
}

async function agenticRecallOutput(memory: MemoryStore, request: RecallCliRequest): Promise<unknown> {
  const { text, types, names, flags, audience } = request;
  const seatRaw = flags.agent === true ? "luna" : String(flags.agent);
  if (seatRaw !== "luna" && seatRaw !== "haiku") throw new Error("--agent must be one of: luna, haiku");
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
    return {
      seat,
      answer: describe(agent.answer),
      followUp: followUp ? { question: followUpQ, ...describe(followUp) } : null,
      candidates: base.hits.map((h) => ({ name: h.node.name, type: h.node.type, description: h.node.description })),
    };
  }

  const render = (label: string, a: typeof agent.answer): string[] => {
    const lines = [`# ${label} (seat: ${seat}${a.fallback ? ", fallback: moss ranking" : ""})`];
    if (a.relevant) lines.push(a.note || "(relevant, no prose)", `cited: ${a.noteIds.join(", ")}`);
    else lines.push("PASS — nothing on file genuinely adds to this question.");
    return lines;
  };
  const lines = render("recall", agent.answer);
  if (followUp) lines.push("", ...render(`follow-up: ${followUpQ}`, followUp));
  lines.push("", "# candidates read", ...base.hits.map((h) => `- ${h.node.name} (${h.node.type}): ${h.node.description}`));
  return lines.join("\n");
}

function audienceFromFlags(flags: Record<string, string | boolean>): Audience {
  if (flags["as-self"] !== undefined) {
    if (flags.viewer !== undefined || flags["viewer-role"] !== undefined || flags.context !== undefined) {
      throw new Error("--as-self cannot be combined with --viewer/--viewer-role/--context");
    }
    return SELF_AUDIENCE;
  }
  const role = ViewerRoleSchema.safeParse(flags["viewer-role"] ? String(flags["viewer-role"]) : "member");
  if (!role.success) throw new Error("--viewer-role must be one of: owner, maintainer, member");
  const context = flags.context ? String(flags.context) : "guild";
  if (context !== "guild" && context !== "dm") throw new Error("--context must be one of: guild, dm");
  return { viewerId: flags.viewer ? String(flags.viewer) : undefined, viewerRole: role.data, context };
}
