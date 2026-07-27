/** Open-loop ledger helpers over the canonical MemoryStore markdown graph. */

import type { MemoryNode, RememberIntent } from "../types.ts";
import type { MemoryStore } from "./index.ts";
import { type Audience, canView } from "./search.ts";
import type { TaskStore } from "../task/store.ts";

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
  /**
   * Task refs (`#20`, `#20.1`) filed against this loop, stamped by `linkLoopTask` or `task create
   * --loop`. Absent/empty for loops predating linking or never linked — no migration needed.
   */
  linkedTasks: string[];
}

export interface LinkedTaskStatus {
  ref: string;
  /** Resolved from the live task registry at read time, never cached on the loop node. */
  status: string;
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

/**
 * Render the compact, bounded session-start grounding block. Empty means no prompt change.
 *
 * `tasks` is optional so callers with no wired registry (tests, a bare memory-only caller) still
 * get a loop list; when present, each loop's linked task refs are resolved live and an explicit
 * "check before filing" instruction is prepended — this is the fix for issue #39, where a sweep
 * filed a duplicate ticket because nothing surfaced that one already existed for the same loop.
 */
export interface RenderOpenLoopsOptions {
  /** Include terminal loops closed in this many calendar days (normally just for event turns). */
  recentlyClosedDays?: number;
  /** Testable clock boundary; defaults to today's UTC date. */
  today?: string;
}

export function renderOpenLoopsBlock(
  store: MemoryStore | null | undefined,
  tasks?: TaskStore,
  options: RenderOpenLoopsOptions = {},
): string {
  if (!store) return "";
  try {
    const today = options.today ?? todayDate();
    const recentlyClosedDays = options.recentlyClosedDays ?? 0;
    const cutoff = recentDateCutoff(today, recentlyClosedDays);
    const loops = listLoops(store, { all: recentlyClosedDays > 0, audience: SELF_LOOP_AUDIENCE, today })
      .filter((loop) => loop.status === "open" || (!!cutoff && !!loop.closed && loop.closed >= cutoff));
    if (!loops.length) return "";
    const shown = loops.slice(0, 12);
    const lines = shown.map((loop) => {
      const filed = tasks ? formatLinkedTasks(resolveLinkedTasks(tasks, loop)) : "";
      const state = loop.status === "open" ? `${loop.overdue ? "OVERDUE " : ""}${loop.due}` : `CLOSED ${loop.closed}`;
      return `- ${state} [${loop.kind}] ${loop.node.description}${filed}`;
    });
    if (loops.length > shown.length) lines.push(`+${loops.length - shown.length} more — run \`beckett loops\``);
    const preamble = "Before filing a task off any loop below, check its \"already filed\" refs (or "
      + "`beckett loops --json`) — a loop with a running/open task already covers that defect; do not "
      + "file a second ticket for the same root cause.";
    return `<open-loops>\n${preamble}\n${lines.join("\n")}\n</open-loops>`;
  } catch {
    // A broken memory directory must never keep a chat session from launching.
    return "";
  }
}

function formatLinkedTasks(linked: LinkedTaskStatus[]): string {
  if (!linked.length) return "";
  return ` [already filed: ${linked.map((task) => `${task.ref} (${task.status})`).join(", ")}]`;
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

/**
 * Stamp a task ref onto a loop's `linkedTasks`, so the next sweep that reads the ledger sees "a
 * task already exists for this" instead of an untouched-looking loop (issue #39). Idempotent: a
 * ref already on the list is a no-op, not a duplicate entry. Works against a loop of any status —
 * a task can legitimately land moments after a loop closes — but the loop must still be visible
 * to the caller's audience.
 */
export async function linkLoopTask(
  store: MemoryStore,
  name: string,
  taskRef: string,
  audience?: Audience,
): Promise<LoopEntry> {
  const existing = listLoops(store, { all: true, audience }).find((loop) => loop.node.name === name);
  if (!existing) throw new Error(`no visible loop named '${name}'`);
  const ref = taskRef.trim();
  if (!/^#?\d+(?:\.\d+)*$/.test(ref)) throw new Error(`invalid task reference "${taskRef}"`);
  const normalized = ref.startsWith("#") ? ref : `#${ref}`;
  const linkedTasks = existing.linkedTasks.includes(normalized)
    ? existing.linkedTasks
    : [...existing.linkedTasks, normalized];

  const node = await store.remember({
    op: "update",
    name: existing.node.name,
    type: "loop",
    description: existing.node.description,
    // mergeInto retains every metadata key not named here, including future unknown keys.
    metadata: { linkedTasks },
    body: existing.node.body,
    source: String(existing.node.metadata.source ?? existing.node.source) as RememberIntent["source"],
    reason: "link task to loop via CLI",
  });
  const entry = asLoop(node, todayDate());
  if (!entry) throw new Error(`loop '${name}' could not be read after linking`);
  return entry;
}

/** Resolve a loop's linked task refs to their current registry status, at read time — never cached. */
export function resolveLinkedTasks(tasks: TaskStore, entry: Pick<LoopEntry, "linkedTasks">): LinkedTaskStatus[] {
  return entry.linkedTasks.map((ref) => {
    const resolved = tasks.resolveTaskRef(ref);
    if (!resolved) return { ref, status: "unknown" };
    return { ref, status: resolved.branch ? resolved.branch.status : resolved.task.status };
  });
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
    linkedTasks: parseLinkedTasks(metadata.linkedTasks),
  };
}

/** Normalize a raw metadata value into a deduped list of `#N`/`#N.x` refs, dropping junk. */
function parseLinkedTasks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const refs = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!/^#?\d+(?:\.\d+)*$/.test(trimmed)) continue;
    refs.add(trimmed.startsWith("#") ? trimmed : `#${trimmed}`);
  }
  return [...refs];
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function recentDateCutoff(today: string, days: number): string | null {
  if (!Number.isSafeInteger(days) || days < 1 || !isDate(today)) return null;
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
