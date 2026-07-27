/**
 * Per-channel calibration ledger over the canonical MemoryStore markdown graph.
 *
 * A calibration record is what my JUDGEMENT got wrong or right in a room: a `veto` (a decline, a
 * "not now", a correction of something I proposed) or a `hit` (something I did unprompted that the
 * person actually wanted). Sibling to the open-loop ledger (`loops.ts`) — same markdown substrate,
 * same `MemoryStore.remember` write path, same "invalid files are simply absent" tolerance — but a
 * distinct signal: loops track what I owe, calibration tracks where my bar should move. The point
 * is per-room memory: two vetoes of the same CLASS in the same channel is the pattern to surface.
 */

import type { MemoryNode, RememberIntent } from "../types.ts";
import type { MemoryStore } from "./index.ts";
import { type Audience, canView, SELF_AUDIENCE } from "./search.ts";

export const CALIBRATION_KINDS = ["veto", "hit"] as const;
export type CalibrationKind = (typeof CALIBRATION_KINDS)[number];

export interface CalibrationEntry {
  node: MemoryNode;
  kind: CalibrationKind;
  /** The Discord channel the signal happened in — the bar is per-room, so this is required. */
  channel: string;
  /** A short slug naming the CLASS of thing, not the incident — the per-channel join key. */
  about: string;
  /** The why, in the person's terms where possible. The field that does the work. */
  reason: string;
  /** Link back to where it came from (channel + message id), same convention as loops. */
  source: string;
  /** The observation date (YYYY-MM-DD), read from the memory frontmatter's created stamp. */
  observed: string;
}

export interface ListCalibrationOptions {
  channel?: string;
  about?: string;
  audience?: Audience;
}

/**
 * Read calibration records directly from the store's freshly-built graph — no ranking, Moss,
 * embeddings, or model path. Invalid calibration-shaped files are deliberately absent, exactly
 * like any malformed memory. Most-recent-first (by created stamp), name as a stable tiebreak.
 */
export function listCalibration(store: MemoryStore, opts: ListCalibrationOptions = {}): CalibrationEntry[] {
  const entries: CalibrationEntry[] = [];
  for (const node of store.buildGraph().nodes.values()) {
    const entry = asCalibration(node);
    if (!entry || !canView(node, opts.audience)) continue;
    if (opts.channel && entry.channel !== opts.channel) continue;
    if (opts.about && entry.about !== opts.about) continue;
    entries.push(entry);
  }
  return entries.sort((a, b) =>
    a.node.created === b.node.created
      ? a.node.name.localeCompare(b.node.name)
      : b.node.created.localeCompare(a.node.created),
  );
}

/**
 * Render the compact, bounded, per-channel session-start bar. Scoped HARD to `channelId` —
 * records from other rooms never appear. At most 10 lines, most recent first, overflow collapses
 * to a `+N more` pointer. Empty string (no tag) when the channel has none. The `try/catch` is
 * load-bearing: a broken or absent memory directory must NEVER stop a chat session from launching.
 */
export function renderCalibrationBlock(store: MemoryStore | null | undefined, channelId: string | null | undefined): string {
  if (!store || !channelId) return "";
  try {
    const records = listCalibration(store, { channel: channelId, audience: SELF_AUDIENCE });
    if (!records.length) return "";
    const shown = records.slice(0, 10);
    const lines = shown.map((r) => `- [${r.kind}] ${r.observed} ${r.about} — "${r.reason}"`);
    if (records.length > shown.length) {
      lines.push(`+${records.length - shown.length} more — run \`beckett calibration\``);
    }
    return `<calibration>\n${lines.join("\n")}\n</calibration>`;
  } catch {
    // A broken memory directory must never keep a chat session from launching.
    return "";
  }
}

export interface CreateCalibrationInput {
  kind: CalibrationKind;
  channel: string;
  about: string;
  reason: string;
  source: string;
  /** Explicit node name — defaults to a unique generated one so repeats don't collide/merge. */
  name?: string;
  /** Explicit observation stamp (ISO or YYYY-MM-DD) for backfill; defaults to now. */
  observed?: string;
  /** Discord id of who gave the signal (provenance, like `memory remember --by`). */
  by?: string;
  /** Display label for {@link by}. */
  byName?: string;
}

/** Create a convention-complete calibration record through MemoryStore (which owns markdown rendering). */
export async function createCalibration(store: MemoryStore, input: CreateCalibrationInput): Promise<CalibrationEntry> {
  if (!CALIBRATION_KINDS.includes(input.kind)) throw new Error(`kind must be one of: ${CALIBRATION_KINDS.join(", ")}`);
  const channel = input.channel?.trim();
  if (!channel) throw new Error("--channel is required");
  const about = slugAbout(input.about ?? "");
  if (!about) throw new Error("--about is required");
  const reason = input.reason?.trim();
  if (!reason) throw new Error("--reason is required");
  const source = input.source?.trim();
  if (!source) throw new Error("--source is required");

  const name = input.name?.trim() || `cal-${about}-${input.kind}-${Date.now().toString(36)}`;
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`--name must be kebab-case, got '${name}'`);

  const metadata: Record<string, unknown> = { kind: input.kind, channel, about, reason };
  if (input.observed?.trim()) metadata.created = normalizeObserved(input.observed.trim());
  if (input.by?.trim()) metadata.source_user = input.by.trim();
  if (input.byName?.trim()) metadata.source_name = input.byName.trim();

  const node = await store.remember({
    op: "create",
    name,
    type: "calibration",
    description: `[${input.kind}] ${about} — ${reason}`,
    metadata,
    // Mirrors openLoop: the intent source IS the link; buildNewContent writes it to metadata.source.
    source: source as RememberIntent["source"],
    reason: "calibration record via CLI",
  });
  const entry = asCalibration(node);
  if (!entry) throw new Error(`calibration record '${name}' could not be read after creation`);
  return entry;
}

/** Parse a graph node into a calibration entry, or null if it fails the record contract. */
function asCalibration(node: MemoryNode): CalibrationEntry | null {
  if (node.phantom || node.type !== "calibration") return null;
  const m = node.metadata;
  const kind =
    typeof m.kind === "string" && CALIBRATION_KINDS.includes(m.kind as CalibrationKind)
      ? (m.kind as CalibrationKind)
      : null;
  const channel = typeof m.channel === "string" && m.channel.trim() ? m.channel.trim() : null;
  const about = typeof m.about === "string" && m.about.trim() ? m.about.trim() : null;
  const reason = typeof m.reason === "string" && m.reason.trim() ? m.reason.trim() : null;
  const source = typeof m.source === "string" && m.source.trim() ? m.source.trim() : null;
  const created = typeof node.created === "string" && node.created.trim() ? node.created.trim() : null;
  // A channel-less record is malformed by definition — the whole point is the per-room bar.
  if (!kind || !channel || !about || !reason || !source || !created) return null;
  return { node, kind, channel, about, reason, source, observed: created.slice(0, 10) };
}

/** Normalize a slug to kebab-case so the per-channel join key stays clean. */
function slugAbout(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A bare YYYY-MM-DD observation becomes midnight-UTC ISO so it round-trips like a real stamp. */
function normalizeObserved(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
}
