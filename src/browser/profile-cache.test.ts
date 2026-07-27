import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneChromeProfileCaches } from "./profile-cache.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
