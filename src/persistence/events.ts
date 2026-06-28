/**
 * Beckett — append-only JSONL event log (`src/persistence/events.ts`)
 * =======================================================================================
 * The immutable history half of persistence (Spec 09 §3): one JSON object per line,
 * append-only, one file per UTC day (`events/YYYY-MM-DD.jsonl`), size-rolled to
 * `YYYY-MM-DD.NN.jsonl` past a byte cap (Spec 09 §3.5). The store calls {@link EventWriter}
 * on every state transition (inside the same transaction as the SQLite row write, Spec 09
 * §3.4). The CLI uses the readers here to serve `tail` / `logs` directly off disk, with no
 * daemon hop (Spec 01 §7).
 *
 * Forward-compat: the reader SKIPS malformed/unknown lines rather than throwing (matches the
 * driver's JSONL discipline, Spec 02 §7 / Spec 09 §3.2).
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { EventRecord, EventInput, EventType } from "../types.ts";
import { eventId } from "../ids.ts";

/** Default size cap before rolling a day file to a sequence suffix (256 MB, Spec 09 §3.5). */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Parse a file name into {day, seq} for ordering; seq 0 = the primary day file. */
function parseEventFileName(name: string): { day: string; seq: number } | null {
  // YYYY-MM-DD.jsonl  or  YYYY-MM-DD.NN.jsonl
  const m = name.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/);
  if (!m) return null;
  return { day: m[1]!, seq: m[2] ? parseInt(m[2], 10) : 0 };
}

/**
 * The append-only writer. One per daemon run; owns the per-run monotonic `seq` counter and
 * the current day's file handle (re-derived on every append so a long-running daemon rolls
 * at the UTC midnight boundary without a separate timer).
 */
export class EventWriter {
  private seq = 0;
  private currentPath: string | null = null;
  private currentBytes = 0;

  constructor(
    private readonly eventsDir: string,
    private readonly maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
  ) {
    mkdirSync(this.eventsDir, { recursive: true });
  }

  /** Resolve (creating as needed) the file path for `ts`, honoring day rotation + size roll. */
  private resolvePath(ts: number): string {
    const day = utcDayKey(ts);
    let roll = 0;
    let path = join(this.eventsDir, `${day}.jsonl`);
    // size-roll: advance to the next free suffix while the candidate is over the cap
    while (existsSync(path)) {
      const size = statSync(path).size;
      if (size < this.maxFileBytes) break;
      roll += 1;
      path = join(this.eventsDir, `${day}.${String(roll).padStart(2, "0")}.jsonl`);
    }
    if (path !== this.currentPath) {
      this.currentPath = path;
      this.currentBytes = existsSync(path) ? statSync(path).size : 0;
    }
    return path;
  }

  /**
   * Append one event. Fills `id` (ULID), `seq` (per-run), `ts`, and null correlation keys
   * for anything the caller omitted (Spec 09 §3.2/§3.4). Returns the full record written.
   */
  append(input: EventInput): EventRecord {
    const ts = input.ts ?? Date.now();
    const rec: EventRecord = {
      id: input.id ?? eventId(),
      seq: this.seq++,
      ts,
      type: input.type,
      task_id: input.task_id ?? null,
      node_id: input.node_id ?? null,
      worker_id: input.worker_id ?? null,
      user_id: input.user_id ?? null,
      payload: input.payload ?? {},
    };
    const path = this.resolvePath(ts);
    const line = JSON.stringify(rec) + "\n";
    appendFileSync(path, line);
    this.currentBytes += Buffer.byteLength(line);
    return rec;
  }

  /** The current per-run sequence value (next id to be assigned). */
  currentSeq(): number {
    return this.seq;
  }
}

// =======================================================================================
// Readers (used by the CLI; daemon-free, Spec 01 §7)
// =======================================================================================

/** Filter options for reading events back. */
export interface EventQuery {
  taskId?: string;
  nodeId?: string;
  workerId?: string;
  types?: EventType[];
  since?: number; // epoch ms inclusive lower bound
  until?: number; // epoch ms inclusive upper bound
  limit?: number; // cap on returned records (most recent kept)
}

/** List event files in chronological order (primary day file before its size-rolls). */
export function listEventFiles(eventsDir: string): string[] {
  if (!existsSync(eventsDir)) return [];
  const entries = readdirSync(eventsDir)
    .map((name) => ({ name, parsed: parseEventFileName(name) }))
    .filter((e): e is { name: string; parsed: { day: string; seq: number } } => e.parsed !== null)
    .sort((a, b) =>
      a.parsed.day === b.parsed.day
        ? a.parsed.seq - b.parsed.seq
        : a.parsed.day < b.parsed.day
          ? -1
          : 1,
    );
  return entries.map((e) => join(eventsDir, e.name));
}

function matches(rec: EventRecord, q: EventQuery): boolean {
  if (q.taskId && rec.task_id !== q.taskId) return false;
  if (q.nodeId && rec.node_id !== q.nodeId) return false;
  if (q.workerId && rec.worker_id !== q.workerId) return false;
  if (q.since !== undefined && rec.ts < q.since) return false;
  if (q.until !== undefined && rec.ts > q.until) return false;
  if (q.types && q.types.length > 0 && !q.types.includes(rec.type)) return false;
  return true;
}

/**
 * Read events across all day files, filtered. Malformed lines are skipped (forward-compat,
 * Spec 09 §3.2). When `limit` is set, the most recent matching records are returned.
 */
export function readEvents(eventsDir: string, q: EventQuery = {}): EventRecord[] {
  const out: EventRecord[] = [];
  for (const file of listEventFiles(eventsDir)) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line) continue;
      let rec: EventRecord;
      try {
        rec = JSON.parse(line) as EventRecord;
      } catch {
        continue; // skip a corrupt/partial trailing line
      }
      if (rec && typeof rec.type === "string" && matches(rec, q)) out.push(rec);
    }
  }
  if (q.limit !== undefined && out.length > q.limit) {
    return out.slice(out.length - q.limit);
  }
  return out;
}

/** Detect within-run seq gaps (a missing write) for `beckett doctor` (Spec 09 §3.2). */
export function findSeqGaps(records: EventRecord[]): { afterSeq: number; beforeSeq: number }[] {
  const gaps: { afterSeq: number; beforeSeq: number }[] = [];
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.seq > prev.seq + 1) gaps.push({ afterSeq: prev.seq, beforeSeq: cur.seq });
  }
  return gaps;
}
