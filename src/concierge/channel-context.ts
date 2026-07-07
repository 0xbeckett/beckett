/**
 * Channel-scoped shared context store (OPS-80 §3).
 * =======================================================================================
 * The multiplayer wedge: when Beckett answers anyone in a channel it should reason over
 * the recent conversation among *everyone* there, not just the mention in front of it.
 * Today's ambient ring buffer is in-memory (lost on every deploy), has holes exactly
 * where Beckett was involved, and forgets Beckett's own replies. This module is the
 * durable replacement: one JSONL file per channel of attributed entries, bounded by a
 * hard count cap and a TTL, plus a sessionId-keyed watermark so a live session is never
 * re-fed lines it already saw — while a rotation/fresh session self-invalidates the
 * watermark and gets a full catch-up window.
 *
 * Two standing rules shape everything here:
 *   - Capture must NEVER break a turn: every fs failure is caught + logged, the store
 *     degrades to its in-memory cache and never throws into the caller.
 *   - channelId is a path component: anything outside a strict allowlist is refused
 *     outright so a hostile id can never traverse out of the channels dir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "../types.ts";

/** One captured message in a channel's shared window. */
export interface ChannelEntry {
  /** Discord id, or synthetic id for Beckett's own posts. */
  messageId: string;
  /** Epoch ms. */
  ts: number;
  /** Discord user id; "beckett" sentinel for our own posts. */
  authorId: string;
  /** Display name at capture time (render label only — never authoritative). */
  authorName: string;
  /** Raw text (attachments already folded in by the caller). */
  content: string;
  kind: "user" | "beckett";
}

export interface ChannelContextStoreOptions {
  /** `<beckettDir>/channels` — created lazily (mkdirSync recursive before first write). */
  channelsDir: string;
  /** Hard count cap per channel. */
  maxEntriesPerChannel: number;
  /** TTL in hours, enforced at read + compaction. */
  maxAgeHours: number;
  logger: Logger;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
  /** Appends per channel between compaction rewrites (default 25). */
  compactEvery?: number;
}

export interface ChannelContextStore {
  append(channelId: string, entry: ChannelEntry): void;
  /** The bounded live window: TTL + count cap applied, oldest → newest. Returns a copy. */
  recent(channelId: string): ChannelEntry[];
  /** Entries this session hasn't seen; advances AND persists the watermark to the newest entry. */
  takeUnseen(channelId: string, sessionId: string): ChannelEntry[];
  /** Advance the watermark without reading (an ambient turn already surfaced the window itself). */
  markSeen(channelId: string, sessionId: string, lastMessageId: string): void;
  /** Delete one channel's stored window (or ALL channels when omitted) + their watermarks. Returns the wiped channel ids. */
  wipe(channelId?: string): string[];
}

// channelId doubles as a filename component; only word chars, dots, dashes — no separators.
const CHANNEL_ID_RE = /^[\w.-]{1,64}$/;
const DEFAULT_COMPACT_EVERY = 25;
const JSONL_EXT = ".jsonl";
const WATERMARKS_FILE = "watermarks.json";

interface WatermarkRecord {
  lastMessageId: string;
  sessionId: string;
}

/**
 * Create the per-channel shared-context store. All state lives under `channelsDir`:
 * `<channelId>.jsonl` per channel plus one `watermarks.json`. Every method is
 * best-effort — fs errors are logged and swallowed, never thrown into the caller.
 */
export function createChannelContextStore(opts: ChannelContextStoreOptions): ChannelContextStore {
  const { channelsDir, maxEntriesPerChannel, maxAgeHours, logger } = opts;
  const now = opts.now ?? Date.now;
  const compactEvery = opts.compactEvery ?? DEFAULT_COMPACT_EVERY;

  // Per-channel in-memory cache, loaded lazily on first touch. Trimmed to the count
  // cap on append; TTL is applied at read so entries expire without a write.
  const cache = new Map<string, ChannelEntry[]>();
  const appendsSinceCompact = new Map<string, number>();
  // Warn once per hostile id — a misbehaving caller shouldn't flood the log.
  const warnedChannelIds = new Set<string>();
  let watermarks: Record<string, WatermarkRecord> | null = null;

  function channelFile(channelId: string): string {
    return join(channelsDir, `${channelId}${JSONL_EXT}`);
  }

  function validChannelId(channelId: string): boolean {
    if (CHANNEL_ID_RE.test(channelId)) return true;
    if (!warnedChannelIds.has(channelId)) {
      warnedChannelIds.add(channelId);
      logger.warn("rejecting invalid channel id", { channelId });
    }
    return false;
  }

  /** Re-materialize one line; anything structurally off is dropped (counted by the caller). */
  function parseEntry(line: string): ChannelEntry | null {
    try {
      const raw = JSON.parse(line) as Partial<ChannelEntry>;
      if (
        typeof raw.messageId === "string" &&
        typeof raw.authorId === "string" &&
        typeof raw.authorName === "string" &&
        typeof raw.content === "string" &&
        typeof raw.ts === "number" &&
        Number.isFinite(raw.ts) &&
        (raw.kind === "user" || raw.kind === "beckett")
      ) {
        return {
          messageId: raw.messageId,
          ts: raw.ts,
          authorId: raw.authorId,
          authorName: raw.authorName,
          content: raw.content,
          kind: raw.kind,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** TTL + count cap, oldest → newest. Pure — bounds are always computed from `now()`. */
  function bounded(entries: ChannelEntry[]): ChannelEntry[] {
    const cutoff = now() - maxAgeHours * 3_600_000;
    const live = entries.filter((e) => e.ts >= cutoff);
    return live.slice(Math.max(0, live.length - maxEntriesPerChannel));
  }

  /** Rewrite the channel file to exactly the bounded window (tmp + rename). */
  function compact(channelId: string): void {
    const window = bounded(cache.get(channelId) ?? []);
    try {
      mkdirSync(channelsDir, { recursive: true });
      const file = channelFile(channelId);
      const tmp = `${file}.tmp`;
      const body = window.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(tmp, body.length > 0 ? body + "\n" : "", "utf8");
      renameSync(tmp, file);
    } catch (err) {
      logger.warn("channel context compaction failed", {
        channelId,
        error: (err as Error).message,
      });
      // A failed rename (or a crash between write and rename) strands the tmp forever —
      // nothing else reads or removes it. Clean up best-effort; next compaction rewrites it.
      try {
        rmSync(`${channelFile(channelId)}.tmp`, { force: true });
      } catch {
        /* best-effort */
      }
    }
    appendsSinceCompact.set(channelId, 0);
  }

  /**
   * Load a channel's file into the cache on first touch. Tolerant per-line parse:
   * malformed lines are dropped with one warn carrying the counts. If the load shrank
   * anything (malformed / expired / over-cap lines) the file is compacted immediately.
   */
  function ensureLoaded(channelId: string): ChannelEntry[] {
    const cached = cache.get(channelId);
    if (cached) return cached;

    const parsed: ChannelEntry[] = [];
    let dropped = 0;
    let fileExisted = false;
    try {
      const file = channelFile(channelId);
      if (existsSync(file)) {
        fileExisted = true;
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const entry = parseEntry(line);
          if (entry) parsed.push(entry);
          else dropped += 1;
        }
      }
    } catch (err) {
      logger.warn("channel context load failed", { channelId, error: (err as Error).message });
    }
    if (dropped > 0) {
      logger.warn("dropped malformed channel context lines", {
        channelId,
        dropped,
        kept: parsed.length,
      });
    }

    const window = bounded(parsed);
    cache.set(channelId, window);
    appendsSinceCompact.set(channelId, 0);
    // Compact only when the load actually shed lines — a pure read of a clean (or
    // absent) file must not touch disk.
    if (fileExisted && (dropped > 0 || window.length !== parsed.length)) compact(channelId);
    return window;
  }

  function watermarkPath(): string {
    return join(channelsDir, WATERMARKS_FILE);
  }

  /** Tolerant load: missing/corrupt file or wrong shape degrades to empty. */
  function loadWatermarks(): Record<string, WatermarkRecord> {
    try {
      const file = watermarkPath();
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        channels?: Record<string, unknown>;
      };
      const channels = parsed?.channels;
      if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
      const out: Record<string, WatermarkRecord> = {};
      for (const [id, val] of Object.entries(channels)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue;
        const v = val as Record<string, unknown>;
        if (typeof v.lastMessageId === "string" && typeof v.sessionId === "string") {
          out[id] = { lastMessageId: v.lastMessageId, sessionId: v.sessionId };
        }
      }
      return out;
    } catch (err) {
      logger.warn("channel context watermarks unreadable, starting empty", {
        error: (err as Error).message,
      });
      return {};
    }
  }

  function getWatermarks(): Record<string, WatermarkRecord> {
    if (watermarks === null) watermarks = loadWatermarks();
    return watermarks;
  }

  /** Atomic tmp + rename; failure keeps the in-memory watermarks authoritative. */
  function persistWatermarks(): void {
    try {
      mkdirSync(channelsDir, { recursive: true });
      const file = watermarkPath();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ channels: getWatermarks() }, null, 2) + "\n", "utf8");
      renameSync(tmp, file);
    } catch (err) {
      logger.warn("channel context watermark persist failed", {
        error: (err as Error).message,
      });
    }
  }

  return {
    append(channelId: string, entry: ChannelEntry): void {
      if (!validChannelId(channelId)) return;
      const entries = ensureLoaded(channelId);
      entries.push({ ...entry });
      // Cheap shift keeps the cache at the count cap; TTL waits for read/compaction.
      while (entries.length > maxEntriesPerChannel) entries.shift();
      try {
        mkdirSync(channelsDir, { recursive: true });
        writeFileSync(channelFile(channelId), JSON.stringify(entry) + "\n", {
          flag: "a",
          encoding: "utf8",
        });
      } catch (err) {
        logger.warn("channel context append failed", {
          channelId,
          error: (err as Error).message,
        });
      }
      const appends = (appendsSinceCompact.get(channelId) ?? 0) + 1;
      if (appends >= compactEvery) compact(channelId);
      else appendsSinceCompact.set(channelId, appends);
    },

    recent(channelId: string): ChannelEntry[] {
      if (!validChannelId(channelId)) return [];
      return bounded(ensureLoaded(channelId)).map((e) => ({ ...e }));
    },

    takeUnseen(channelId: string, sessionId: string): ChannelEntry[] {
      if (!validChannelId(channelId)) return [];
      const window = bounded(ensureLoaded(channelId)).map((e) => ({ ...e }));
      if (window.length === 0) return [];
      const marks = getWatermarks();
      const mark = marks[channelId];
      let unseen = window;
      // A watermark is live only for the session that set it; a rotation/fresh session
      // gets the full window. A watermark id that aged out of the window also yields
      // everything — better to repeat than to silently drop.
      if (mark && mark.sessionId === sessionId) {
        const idx = window.findIndex((e) => e.messageId === mark.lastMessageId);
        if (idx !== -1) unseen = window.slice(idx + 1);
      }
      const newest = window[window.length - 1]!;
      marks[channelId] = { lastMessageId: newest.messageId, sessionId };
      persistWatermarks();
      return unseen;
    },

    markSeen(channelId: string, sessionId: string, lastMessageId: string): void {
      if (!validChannelId(channelId)) return;
      getWatermarks()[channelId] = { lastMessageId, sessionId };
      persistWatermarks();
    },

    wipe(channelId?: string): string[] {
      const marks = getWatermarks();
      let targets: string[];
      if (channelId !== undefined) {
        if (!validChannelId(channelId)) return [];
        targets = [channelId];
      } else {
        // Sweep everything we know about: files on disk plus any cache/watermark
        // entries whose files never made it to disk.
        const known = new Set<string>([...cache.keys(), ...Object.keys(marks)]);
        try {
          for (const name of readdirSync(channelsDir)) {
            if (name.endsWith(JSONL_EXT)) known.add(name.slice(0, -JSONL_EXT.length));
          }
        } catch {
          // Missing/unreadable dir — nothing more on disk to sweep.
        }
        targets = [...known].filter((id) => CHANNEL_ID_RE.test(id));
      }

      const wiped: string[] = [];
      let marksChanged = false;
      for (const id of targets) {
        let removed = false;
        try {
          const file = channelFile(id);
          if (existsSync(file)) {
            rmSync(file);
            removed = true;
          }
          // A crash mid-compaction may have stranded a tmp — a wipe must not leave message
          // content behind in it (this is the privacy path).
          rmSync(`${file}.tmp`, { force: true });
        } catch (err) {
          logger.warn("channel context wipe failed", { channelId: id, error: (err as Error).message });
        }
        // An empty cache entry is just a lazy-load artifact, not stored state.
        const cached = cache.get(id);
        if (cache.delete(id) && cached !== undefined && cached.length > 0) removed = true;
        appendsSinceCompact.delete(id);
        if (marks[id]) {
          delete marks[id];
          marksChanged = true;
          removed = true;
        }
        if (removed) wiped.push(id);
      }
      if (marksChanged) persistWatermarks();
      return wiped;
    },
  };
}
