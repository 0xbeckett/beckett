/** Safe cleanup of Chromium data that is disposable between browser launches. */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Chromium subtrees below a `Default` profile that hold only regenerable data:
 * HTTP/code/GPU caches and the Service Worker cache/script stores. Chromium
 * rebuilds all of these on demand, so their churn is not real profile growth.
 * This one list is authoritative for both what the prune deletes and what the
 * budget discounts, so the two can never disagree on "disposable".
 */
export const DISPOSABLE_CACHE_PATHS = [
  ["Cache"],
  ["Code Cache"],
  ["GPUCache"],
  ["ShaderCache"],
  ["GrShaderCache"],
  ["DawnGraphiteCache"],
  ["DawnWebGPUCache"],
  ["Service Worker", "CacheStorage"],
  ["Service Worker", "ScriptCache"],
] as const;

export interface ChromeCachePruneResult {
  reclaimedBytes: number;
}

/**
 * True when `path` is a disposable Chromium cache subtree (one of DISPOSABLE_CACHE_PATHS
 * sitting directly under a `Default` profile, at any depth from the profile root). Purely
 * structural — no filesystem access — so it is safe to call inside a live scan and against
 * an open browser: it never touches the tree, it only decides whether to count it.
 */
export function isDisposableCacheDir(path: string): boolean {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  for (const parts of DISPOSABLE_CACHE_PATHS) {
    if (segments.length < parts.length + 1) continue;
    const anchor = segments.length - parts.length;
    if (segments[anchor - 1] !== "Default") continue;
    if (parts.every((part, index) => segments[anchor + index] === part)) return true;
  }
  return false;
}

/**
 * Allocated bytes, ignoring symlinks so a profile cannot lead scans outside itself.
 * With `excludeDisposableCache`, disposable cache subtrees are skipped so the result
 * tracks real profile state rather than regenerable cache churn.
 */
export async function measureDirectoryBytes(
  root: string,
  stopAfter = Number.POSITIVE_INFINITY,
  options?: { excludeDisposableCache?: boolean },
): Promise<number> {
  const excludeDisposableCache = options?.excludeDisposableCache ?? false;
  const pending = [root];
  let total = 0;
  while (pending.length > 0 && total <= stopAfter) {
    const current = pending.pop()!;
    if (excludeDisposableCache && isDisposableCacheDir(current)) continue;
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
  await Promise.all(defaults.flatMap((defaultDir) => DISPOSABLE_CACHE_PATHS.map(async (parts) => {
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
