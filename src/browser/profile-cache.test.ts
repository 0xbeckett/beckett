import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDisposableCacheDir, measureDirectoryBytes, pruneChromeProfileCaches } from "./profile-cache.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("isDisposableCacheDir matches disposable cache trees below Default and nothing else", () => {
  const root = "/state/profile";
  // Disposable: single- and nested-segment caches directly under a Default profile.
  expect(isDisposableCacheDir(join(root, "Default", "Cache"))).toBe(true);
  expect(isDisposableCacheDir(join(root, "Default", "Code Cache"))).toBe(true);
  expect(isDisposableCacheDir(join(root, "Default", "Service Worker", "CacheStorage"))).toBe(true);
  // Nested Default (betterwright layout) is still matched.
  expect(isDisposableCacheDir(join(root, "betterwright", "browser", "profile", "Default", "GPUCache"))).toBe(true);
  // Real profile state is never disposable, even when its name resembles a cache.
  expect(isDisposableCacheDir(join(root, "Default", "Cookies"))).toBe(false);
  expect(isDisposableCacheDir(join(root, "Default", "IndexedDB"))).toBe(false);
  expect(isDisposableCacheDir(join(root, "Default", "Service Worker", "Database"))).toBe(false);
  // A cache-named dir that is not under a Default profile is left alone.
  expect(isDisposableCacheDir(join(root, "Cache"))).toBe(false);
});

test("measureDirectoryBytes can exclude disposable caches while counting real state", async () => {
  const root = mkdtempSync(join(tmpdir(), "beckett-profile-measure-"));
  roots.push(root);
  const defaultDir = join(root, "Default");
  mkdirSync(join(defaultDir, "Cache"), { recursive: true });
  writeFileSync(join(defaultDir, "Cache", "media.bin"), Buffer.alloc(512 * 1024));
  mkdirSync(join(defaultDir, "IndexedDB"), { recursive: true });
  writeFileSync(join(defaultDir, "IndexedDB", "state.bin"), Buffer.alloc(64 * 1024));

  const withCache = await measureDirectoryBytes(root);
  const withoutCache = await measureDirectoryBytes(root, Number.POSITIVE_INFINITY, { excludeDisposableCache: true });
  expect(withCache).toBeGreaterThan(withoutCache);
  // The disposable cache (512 KiB) is discounted; the real IndexedDB state (64 KiB) is not.
  expect(withCache - withoutCache).toBeGreaterThanOrEqual(512 * 1024);
  expect(withoutCache).toBeGreaterThanOrEqual(64 * 1024);
});

test("prunes only disposable caches in every nested Default profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "beckett-profile-cache-"));
  roots.push(root);
  const defaults = [
    join(root, "Default"),
    join(root, "betterwright", "browser", "profile", "Default"),
    join(root, "betterwright", "browser", "profile-chromium", "Default"),
  ];
  const caches = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"];
  const state = ["Cookies", "Local Storage", "Login Data", "Preferences", "Web Data", "IndexedDB", "Sessions", "History"];
  for (const dir of defaults) {
    for (const cache of caches) {
      mkdirSync(join(dir, cache), { recursive: true });
      writeFileSync(join(dir, cache, "payload"), Buffer.alloc(4096));
    }
    for (const file of state) {
      const isDirectory = file === "Local Storage" || file === "IndexedDB" || file === "Sessions";
      if (isDirectory) {
        mkdirSync(join(dir, file), { recursive: true });
        writeFileSync(join(dir, file, "state"), "keep");
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), "keep");
      }
    }
  }

  const result = await pruneChromeProfileCaches(root);
  expect(result.reclaimedBytes).toBeGreaterThan(0);
  for (const dir of defaults) {
    for (const cache of caches) expect(existsSync(join(dir, cache))).toBe(false);
    for (const file of state) {
      const target = join(dir, file);
      expect(existsSync(target)).toBe(true);
      if (file !== "Local Storage" && file !== "IndexedDB" && file !== "Sessions") expect(readFileSync(target, "utf8")).toBe("keep");
    }
  }
});
