/** Open-loop ledger helpers over the canonical MemoryStore markdown graph. */

import type { MemoryNode, RememberIntent } from "../types.ts";
import type { MemoryStore } from "./index.ts";
import { type Audience, canView } from "./search.ts";

export const LOOP_KINDS = ["commitment", "recurring-error", "wishlist"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];
export const LOOP_STATUSES = ["open", "done", "dropped"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export interface LoopEntry {
  node: MemoryNode;
  kind: LoopKind;
  status: LoopStatus;
  due: string;
  opened: string;
  source: string;
  closes: string;
  closed?: string;
  /** Date of the last progress note, or null if the loop has never been touched. */
  lastTouched: string | null;
  overdue: boolean;
}

export interface ListLoopsOptions {
  all?: boolean;
  audience?: Audience;
  today?: string;
}

/**
 * Read loops directly from the store's freshly-built graph: no ranking, Moss, embeddings, or
 * model path. Invalid loop-shaped files are deliberately absent, just like any malformed memory.
 */
export function listLoops(store: MemoryStore, opts: ListLoopsOptions = {}): LoopEntry[] {
  const today = opts.today ?? todayDate();
  const entries: LoopEntry[] = [];
  for (const node of store.buildGraph().nodes.values()) {
    const entry = asLoop(node, today);
    if (!entry || !canView(node, opts.audience)) continue;
    if (!opts.all && entry.status !== "open") continue;
    entries.push(entry);
  }
  return entries.sort((a, b) =>
    a.due === b.due ? a.node.name.localeCompare(b.node.name) : a.due.localeCompare(b.due),
  );
}

/** Render the compact, bounded session-start grounding block. Empty means no prompt change. */
export function renderOpenLoopsBlock(store: MemoryStore | null | undefined): string {
  if (!store) return "";
  try {
    const loops = listLoops(store, { audience: SELF_LOOP_AUDIENCE });
    if (!loops.length) return "";
    const shown = loops.slice(0, 12);
    const lines = shown.map((loop) =>
      `- ${loop.overdue ? "OVERDUE " : ""}${loop.due} [${loop.kind}] ${loop.node.description}`,
    );
    if (loops.length > shown.length) lines.push(`+${loops.length - shown.length} more — run \`beckett loops\``);
    return `<open-loops>\n${lines.join("\n")}\n</open-loops>`;
  } catch {
    // A broken memory directory must never keep a chat session from launching.
    return "";
  }
}

/** Create a convention-complete public loop through MemoryStore (which owns markdown rendering). */
export async function openLoop(
  store: MemoryStore,
  input: { name: string; kind: LoopKind; due: string; source: string; description: string; closes?: string },
): Promise<LoopEntry> {
  if (!LOOP_KINDS.includes(input.kind)) throw new Error(`--kind must be one of: ${LOOP_KINDS.join(", ")}`);
  if (!isDate(input.due)) throw new Error("--due must be YYYY-MM-DD");
  if (!input.source.trim()) throw new Error("--source is required");
  if (!input.description.trim()) throw new Error("--desc is required");
  const node = await store.remember({
    op: "create",
    name: input.name,
    type: "loop",
    description: input.description.trim(),
    metadata: {
      kind: input.kind,
      status: "open",
      due: input.due,
      opened: todayDate(),
      source: input.source.trim(),
      closes: input.closes?.trim() || "the described work is delivered and verified",
    },
    source: input.source.trim() as RememberIntent["source"],
    reason: "open loop via CLI",
  });
  const entry = asLoop(node, todayDate());
  if (!entry) throw new Error(`loop '${input.name}' could not be read after creation`);
  return entry;
}

/** Settle an open loop while preserving every unrelated metadata field and its authored body. */
export async function settleLoop(
  store: MemoryStore,
  name: string,
  status: Extract<LoopStatus, "done" | "dropped">,
  note: string | undefined,
  audience?: Audience,
): Promise<LoopEntry> {
  const existing = listLoops(store, { all: true, audience }).find((loop) => loop.node.name === name);
  if (!existing || existing.status !== "open") throw new Error(`no visible open loop named '${name}'`);
  if (status === "dropped" && !note?.trim()) throw new Error("--note is required when dropping a loop");

  const closed = todayDate();
  const body = note?.trim()
    ? [
        existing.node.body.trim(),
        `**${status === "dropped" ? "Drop" : "Close"} note (${closed}):** ${note.trim()}`,
      ].filter(Boolean).join("\n\n")
    : existing.node.body;
  const node = await store.remember({
    op: "update",
    name: existing.node.name,
    type: "loop",
    description: existing.node.description,
    // mergeInto retains every metadata key not named here, including future unknown keys.
    metadata: { status, closed },
    body,
    source: String(existing.node.metadata.source ?? existing.node.source) as RememberIntent["source"],
    reason: `${status} loop via CLI`,
  });
  const entry = asLoop(node, closed);
  if (!entry) throw new Error(`loop '${name}' could not be read after settlement`);
  return entry;
}

/**
 * Append a dated progress note to an open loop and stamp `lastTouched`, without settling it.
 * Goes through the same MemoryStore/mergeInto path as {@link settleLoop}, so unrelated metadata
 * (including `visibility`) is retained untouched — a note can never widen a loop's audience.
 */
export async function noteLoop(
  store: MemoryStore,
  name: string,
  note: string | undefined,
  audience?: Audience,
): Promise<LoopEntry> {
  const existing = listLoops(store, { all: true, audience }).find((loop) => loop.node.name === name);
  if (!existing || existing.status !== "open") throw new Error(`no visible open loop named '${name}'`);
  if (!note?.trim()) throw new Error("--note is required to note a loop");

  const touched = todayDate();
  const body = [
    existing.node.body.trim(),
    `**Note (${touched}):** ${note.trim()}`,
  ].filter(Boolean).join("\n\n");
  const node = await store.remember({
    op: "update",
    name: existing.node.name,
    type: "loop",
    description: existing.node.description,
    // mergeInto retains every metadata key not named here; status stays `open`.
    metadata: { lastTouched: touched },
    body,
    source: String(existing.node.metadata.source ?? existing.node.source) as RememberIntent["source"],
    reason: "note loop via CLI",
  });
  const entry = asLoop(node, touched);
  if (!entry) throw new Error(`loop '${name}' could not be read after noting`);
  return entry;
}

const SELF_LOOP_AUDIENCE: Audience = { viewerId: "beckett-self", viewerRole: "owner", context: "guild" };

function asLoop(node: MemoryNode, today: string): LoopEntry | null {
  if (node.phantom || node.type !== "loop") return null;
  const metadata = node.metadata;
  const kind = typeof metadata.kind === "string" && LOOP_KINDS.includes(metadata.kind as LoopKind)
    ? metadata.kind as LoopKind
    : null;
  const status = typeof metadata.status === "string" && LOOP_STATUSES.includes(metadata.status as LoopStatus)
    ? metadata.status as LoopStatus
    : null;
  const due = typeof metadata.due === "string" && isDate(metadata.due) ? metadata.due : null;
  const opened = typeof metadata.opened === "string" && isDate(metadata.opened) ? metadata.opened : null;
  const source = typeof metadata.source === "string" && metadata.source.trim() ? metadata.source.trim() : null;
  const closes = typeof metadata.closes === "string" && metadata.closes.trim() ? metadata.closes.trim() : null;
  const hasClosed = metadata.closed !== undefined && metadata.closed !== null;
  const closed = typeof metadata.closed === "string" && isDate(metadata.closed) ? metadata.closed : undefined;
  // Loops predating progress notes carry no `lastTouched`; they read as never touched.
  const lastTouched = typeof metadata.lastTouched === "string" && isDate(metadata.lastTouched)
    ? metadata.lastTouched
    : null;
  // A close date belongs only to terminal loops; terminal loops must have one. A malformed
  // present close date is malformed frontmatter too, never silently treated as absent.
  if (!kind || !status || !due || !opened || !source || !closes || (hasClosed && !closed)) return null;
  if ((status === "open" && closed) || (status !== "open" && !closed)) return null;
  return {
    node,
    kind,
    status,
    due,
    opened,
    source,
    closes,
    ...(closed ? { closed } : {}),
    lastTouched,
    overdue: due <= today,
  };
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
