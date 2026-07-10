/**
 * Beckett — Memory maintenance (`src/memory/maintain.ts`)
 * =======================================================================================
 * The routine self-healing pass over the knowledge graph (OPS-121 "better memory"): detect
 * what has rotted and either archive or merge it, so the store stays sharp without a human
 * gardening it. Three detectors:
 *
 *   1. **Expired TTL** — a node whose `ttl` passed more than {@link TTL_GRACE_MS} ago is
 *      archived. Within the grace window it stays (recall already deprioritizes stale nodes);
 *      the grace keeps a just-expired fact findable while it might still be renewed.
 *   2. **Superseded** — `supersedes: [[old]]` on a decision means `old` is replaced by
 *      construction; the old node is archived with a pointer to what replaced it.
 *   3. **Near-duplicates** — two same-type nodes whose stemmed name+description similarity
 *      is ≥ {@link MERGE_THRESHOLD} are merged (canonical keeps everything, duplicate is
 *      archived); pairs in the flag band [{@link DEDUP_THRESHOLD}, MERGE_THRESHOLD) are only
 *      REPORTED — a wrong auto-merge is hard to undo, so borderline stays a human call.
 *
 * **No data loss, ever**: nothing is deleted. Archived files move to `<memoryDir>/archive/`
 * (excluded from the graph and recall) with `archived` / `archived_reason` stamped into
 * their metadata, a merge appends the duplicate's full body to the canonical node, and the
 * memory dir is git-versioned on top — every action is reversible.
 *
 * `planMaintenance` is pure over a built graph (unit-testable, powers `--dry-run`);
 * execution lives in `MemoryStore.maintain` (index.ts) which owns the filesystem.
 * `startRoutineMaintenance` is the daemon hook: one pass shortly after boot, then daily.
 */

import type { Logger, MemoryGraph, MemoryNode } from "../types.ts";
import { DEDUP_THRESHOLD, MERGE_THRESHOLD, nodeSimilarity } from "./search.ts";

/** How long past its `ttl` a node survives before the pass archives it. */
export const TTL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Move a node's file to `archive/` and stamp why. */
export interface ArchiveAction {
  name: string;
  reason: "expired-ttl" | "superseded";
  /** For `superseded`: the node whose `supersedes` edge retired this one. */
  by?: string;
  detail: string;
}

/** Fold `duplicate` into `canonical` (bodies appended, aliases merged, links rewritten). */
export interface MergeAction {
  canonical: string;
  duplicate: string;
  similarity: number;
}

/** A pair similar enough to suspect but not enough to auto-merge — surfaced, not acted on. */
export interface FlaggedPair {
  a: string;
  b: string;
  similarity: number;
}

/** What one maintenance pass decided (dry-run returns exactly this, executed or not). */
export interface MaintainReport {
  scanned: number;
  archives: ArchiveAction[];
  merges: MergeAction[];
  flagged: FlaggedPair[];
  /** Phantom names — referenced but never written; a to-do list, reported not pruned. */
  phantoms: string[];
  dryRun: boolean;
}

/**
 * Decide what a maintenance pass would do to a built graph. Pure: no filesystem, caller
 * passes `now`. Archive decisions are computed first; merge candidates exclude anything
 * already being archived (no point merging into a node on its way out).
 */
export function planMaintenance(
  g: MemoryGraph,
  now: number,
): Omit<MaintainReport, "dryRun" | "scanned"> {
  const real = [...g.nodes.values()].filter((n) => !n.phantom);
  const archives: ArchiveAction[] = [];
  const archiving = new Set<string>();

  // 1. Expired TTL (past grace).
  for (const n of real) {
    const ttl = n.metadata.ttl;
    if (typeof ttl !== "string" || ttl.trim() === "") continue;
    const t = Date.parse(ttl);
    if (Number.isFinite(t) && now - t > TTL_GRACE_MS) {
      archives.push({
        name: n.name,
        reason: "expired-ttl",
        detail: `ttl ${ttl} expired ${Math.round((now - t) / 86_400_000)}d ago`,
      });
      archiving.add(n.name);
    }
  }

  // 2. Superseded: a `supersedes` edge A→B retires B.
  for (const [from, edges] of g.out) {
    for (const e of edges) {
      if (e.field !== "supersedes") continue;
      const target = g.nodes.get(e.to);
      if (!target || target.phantom || target.name === from) continue;
      if (archiving.has(target.name)) continue;
      archives.push({
        name: target.name,
        reason: "superseded",
        by: from,
        detail: `superseded by ${from}`,
      });
      archiving.add(target.name);
    }
  }

  // 3. Near-duplicates among survivors, same type only. The store is small (tens to low
  //    hundreds of nodes) so the pairwise scan is fine.
  const merges: MergeAction[] = [];
  const flagged: FlaggedPair[] = [];
  const merging = new Set<string>();
  const survivors = real.filter((n) => !archiving.has(n.name));
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i]!;
      const b = survivors[j]!;
      if (a.type !== b.type) continue;
      if (merging.has(a.name) || merging.has(b.name)) continue;
      const sim = nodeSimilarity(a, b);
      if (sim >= MERGE_THRESHOLD) {
        const [canonical, duplicate] = pickCanonical(a, b);
        merges.push({ canonical: canonical.name, duplicate: duplicate.name, similarity: round2(sim) });
        merging.add(duplicate.name);
      } else if (sim >= DEDUP_THRESHOLD) {
        flagged.push({ a: a.name, b: b.name, similarity: round2(sim) });
      }
    }
  }

  const phantoms = [...g.nodes.values()].filter((n) => n.phantom).map((n) => n.name).sort();
  return { archives, merges, flagged, phantoms };
}

/** Canonical = the older node (its name is what other memories already link to); ties break
 *  to the one with more content, then lexicographically for determinism. */
function pickCanonical(a: MemoryNode, b: MemoryNode): [MemoryNode, MemoryNode] {
  const ca = Date.parse(a.created);
  const cb = Date.parse(b.created);
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca < cb ? [a, b] : [b, a];
  if (a.body.length !== b.body.length) return a.body.length > b.body.length ? [a, b] : [b, a];
  return a.name <= b.name ? [a, b] : [b, a];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// =======================================================================================
// Routine scheduling (the daemon hook)
// =======================================================================================

/** Default cadence: one pass a day keeps a chatty store from rotting between deploys. */
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** First pass waits out the boot burst (pollers priming, concierge starting). */
export const MAINTENANCE_BOOT_DELAY_MS = 90_000;

export interface RoutineMaintenanceDeps {
  /** `MemoryStore.maintain` (or anything with its shape). */
  maintain: (opts?: { dryRun?: boolean }) => Promise<MaintainReport>;
  logger: Logger;
  intervalMs?: number;
  initialDelayMs?: number;
}

/** Run maintenance shortly after boot and then on a daily timer. Failures are logged and
 *  swallowed — a broken pass must never take the daemon down. Returns a stopper. */
export function startRoutineMaintenance(deps: RoutineMaintenanceDeps): { stop(): void } {
  const interval = deps.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  const initial = deps.initialDelayMs ?? MAINTENANCE_BOOT_DELAY_MS;

  const run = async () => {
    try {
      const r = await deps.maintain();
      const summary = {
        scanned: r.scanned,
        archived: r.archives.length,
        merged: r.merges.length,
        flagged: r.flagged.length,
        phantoms: r.phantoms.length,
      };
      if (r.archives.length || r.merges.length || r.flagged.length) {
        deps.logger.info("memory maintenance pass", {
          ...summary,
          actions: [
            ...r.archives.map((a) => `archive ${a.name} (${a.detail})`),
            ...r.merges.map((m) => `merge ${m.duplicate} → ${m.canonical} (sim ${m.similarity})`),
          ].join("; "),
        });
      } else {
        deps.logger.debug("memory maintenance pass: store is clean", summary);
      }
    } catch (err) {
      deps.logger.warn("memory maintenance pass failed", { err: String(err) });
    }
  };

  const first = setTimeout(() => void run(), initial);
  const timer = setInterval(() => void run(), interval);
  // Timers must not keep a test process (or a shutting-down daemon) alive.
  first.unref?.();
  timer.unref?.();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
