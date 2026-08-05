/**
 * How much storage the sandboxed browser lane may use, and what it tells pages.
 *
 * CloakBrowser normalises `navigator.storage.estimate()` the same way it normalises
 * every other fingerprint surface: the reported quota is a consumer-plausible figure
 * derived from the `--fingerprint` seed, roughly 400-650 MB, with no relation to the
 * host disk. It is only a reported number — a lane whose estimate said 549 MB still
 * accepted 12 GiB of CacheStorage writes without an error — but a page cannot know
 * that. Apps that stage a large asset set (WebGPU model weights, offline maps, video
 * projects) read the estimate first and refuse before they fetch a byte.
 *
 * So the lane sets the figure itself, from the real free space on the filesystem
 * backing the profile, bounded by what Beckett is actually willing to let one browser
 * lane keep on disk. Chromium's quota manager stays on and unmodified; the number
 * pages see stops being fiction.
 *
 * The same resolved budget is the lane's per-file `RLIMIT_FSIZE` (isolated.ts) and the
 * profile's on-disk ceiling (betterwright.ts), so the storage Beckett advertises, the
 * storage a single write may reach, and the storage the lease budget tolerates are one
 * number rather than three that can disagree.
 */

import { statfsSync } from "node:fs";

/**
 * Ceiling on the lane's on-disk footprint. Large enough for the multi-GB asset sets
 * that motivate the whole exercise (a 5.3 GB model, cached whole) with room for a
 * second one beside it, and still a small fraction of any disk worth running on.
 */
export const LANE_STORAGE_BYTES = 32 * 1024 * 1024 * 1024;

/**
 * Free space the lane never claims. The browser lane is a guest on a machine that
 * also runs the daemon, its worktrees, and its logs; a page that fills the disk to
 * the last block takes all of them down with it.
 */
export const HOST_FREE_SPACE_RESERVE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Floor for the resolved budget. On a nearly full host the honest answer approaches
 * zero, but a zero-byte `RLIMIT_FSIZE` stops Chromium from writing its own profile,
 * so the lane keeps a working minimum and lets the filesystem report ENOSPC itself.
 */
export const MIN_LANE_STORAGE_BYTES = 512 * 1024 * 1024;

/** Injectable for tests; mirrors the shape of `node:fs`'s statfsSync result. */
export type StatfsProbe = (path: string) => { bsize: number; bavail: number | bigint };

export interface LaneStorageOptions {
  /** Any path on the filesystem that backs the profile. */
  profileDir: string;
  /** Ceiling override; defaults to {@link LANE_STORAGE_BYTES}. */
  budgetBytes?: number;
  reserveBytes?: number;
  statfs?: StatfsProbe;
}

/**
 * Bytes this lane may store: free space on the profile's filesystem less the host
 * reserve, clamped into [{@link MIN_LANE_STORAGE_BYTES}, budget].
 *
 * A filesystem that cannot be probed falls back to the floor rather than the ceiling:
 * an unreadable disk is not evidence of a large one.
 */
export function resolveLaneStorageBytes(options: LaneStorageOptions): number {
  const budget = Math.floor(options.budgetBytes ?? LANE_STORAGE_BYTES);
  const reserve = Math.floor(options.reserveBytes ?? HOST_FREE_SPACE_RESERVE_BYTES);
  const floor = Math.min(MIN_LANE_STORAGE_BYTES, budget);
  let free: number;
  try {
    const stats = (options.statfs ?? statfsSync)(options.profileDir);
    free = Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return floor;
  }
  if (!Number.isFinite(free) || free <= 0) return floor;
  return Math.max(floor, Math.min(budget, Math.floor(free - reserve)));
}

/**
 * The budget in whole mebibytes, the unit CloakBrowser's `--fingerprint-storage-quota`
 * switch takes. Always at least 1 so the switch is never emitted as a no-op zero.
 */
export function laneStorageQuotaMib(bytes: number): number {
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}
