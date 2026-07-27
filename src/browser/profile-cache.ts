/** Safe cleanup of Chromium data that is disposable between browser launches. */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const CACHE_PATHS = [
  ["Cache"],
  ["Code Cache"],
  ["GPUCache"],
  ["DawnGraphiteCache"],
  ["DawnWebGPUCache"],
  ["Service Worker", "CacheStorage"],
  ["Service Worker", "ScriptCache"],
] as const;

export interface ChromeCachePruneResult {
  reclaimedBytes: number;
}

/** Allocated bytes, ignoring symlinks so a profile cannot lead scans outside itself. */
export async function measureDirectoryBytes(root: string, stopAfter = Number.POSITIVE_INFINITY): Promise<number> {
  const pending = [root];
  let total = 0;
  while (pending.length > 0 && total <= stopAfter) {
    const current = pending.pop()!;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) continue;
      total += Number.isFinite(stat.blocks) && stat.blocks > 0 ? stat.blocks * 512 : Math.max(0, stat.size);
      if (stat.isDirectory()) {
        for (const entry of await readdir(current)) pending.push(join(current, entry));
      }
    } catch {
      // Chrome can rotate cache files during a scan; a later measurement is authoritative.
    }
  }
  return total;
}

/**
 * Remove only cache trees below every Chromium `Default` profile found under root.
 * This deliberately has no broad profile cleanup fallback: authentication and browser state stay.
 * Callers must ensure no browser process currently owns the profile.
 */
export async function pruneChromeProfileCaches(profileRoot: string): Promise<ChromeCachePruneResult> {
  const before = await measureDirectoryBytes(profileRoot);
  const pending = [profileRoot];
  const defaults: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (current !== profileRoot && current.split(/[/\\]/).at(-1) === "Default") {
        defaults.push(current);
        continue;
      }
      for (const entry of await readdir(current)) pending.push(join(current, entry));
    } catch {
      // A concurrently removed cache is already successfully pruned.
    }
  }
  await Promise.all(defaults.flatMap((defaultDir) => CACHE_PATHS.map(async (parts) => {
    const target = join(defaultDir, ...parts);
    try {
      const stat = await lstat(target);
      if (!stat.isSymbolicLink()) await rm(target, { recursive: true, force: true });
    } catch {
      // Missing/churning cache directories are harmless.
    }
  })));
  const after = await measureDirectoryBytes(profileRoot);
  return { reclaimedBytes: Math.max(0, before - after) };
}
