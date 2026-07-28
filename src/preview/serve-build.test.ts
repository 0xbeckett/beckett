import { expect, test } from "bun:test";
import { detectBuildCommand, firstBuildOutput, firstStaticRoot, serveBuild, type ServeBuildDeps } from "./serve-build.ts";
import type { Logger } from "../types.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** A fake filesystem: `exists` is true for any path in the set. */
function fs(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

// ── docroot detection (pure) ──────────────────────────────────────────────────────────────────

test("firstBuildOutput prefers compiled output dirs holding an index.html", () => {
  expect(firstBuildOutput("/r", fs(["/r/dist/index.html"]))).toBe("/r/dist");
  expect(firstBuildOutput("/r", fs(["/r/build/index.html"]))).toBe("/r/build");
  // dist beats build when both exist (priority order)
  expect(firstBuildOutput("/r", fs(["/r/dist/index.html", "/r/build/index.html"]))).toBe("/r/dist");
  // a dir without index.html is not a runnable build
  expect(firstBuildOutput("/r", fs(["/r/dist/main.js"]))).toBe(null);
  expect(firstBuildOutput("/r", fs([]))).toBe(null);
});

test("firstStaticRoot finds a plain static site", () => {
  expect(firstStaticRoot("/r", fs(["/r/index.html"]))).toBe("/r");
  expect(firstStaticRoot("/r", fs(["/r/public/index.html"]))).toBe("/r/public");
  expect(firstStaticRoot("/r", fs(["/r/web/index.html"]))).toBe("/r/web");
  expect(firstStaticRoot("/r", fs([]))).toBe(null);
});

// ── build-command detection (pure) ────────────────────────────────────────────────────────────

test("detectBuildCommand reads the build script and picks the manager from the lockfile", () => {
  const withBuild = JSON.stringify({ scripts: { build: "vite build" } });
  expect(detectBuildCommand("/r", fs(["/r/package.json", "/r/bun.lock"]), () => withBuild)).toEqual(["bun", "run", "build"]);
  expect(detectBuildCommand("/r", fs(["/r/package.json", "/r/pnpm-lock.yaml"]), () => withBuild)).toEqual(["pnpm", "run", "build"]);
  expect(detectBuildCommand("/r", fs(["/r/package.json", "/r/yarn.lock"]), () => withBuild)).toEqual(["yarn", "run", "build"]);
  // no lockfile → npm
  expect(detectBuildCommand("/r", fs(["/r/package.json"]), () => withBuild)).toEqual(["npm", "run", "build"]);
});

test("detectBuildCommand returns null without a package.json or a build script", () => {
  expect(detectBuildCommand("/r", fs([]), () => "")).toBe(null);
  const noBuild = JSON.stringify({ scripts: { test: "bun test" } });
  expect(detectBuildCommand("/r", fs(["/r/package.json"]), () => noBuild)).toBe(null);
  // malformed json is tolerated (no throw)
  expect(detectBuildCommand("/r", fs(["/r/package.json"]), () => "{not json")).toBe(null);
});

// ── serveBuild orchestration (seams injected) ─────────────────────────────────────────────────

function deps(over: Partial<ServeBuildDeps> = {}): ServeBuildDeps & { served: string[]; builds: Array<{ cmd: string[]; cwd: string }> } {
  const served: string[] = [];
  const builds: Array<{ cmd: string[]; cwd: string }> = [];
  return {
    logger: quiet,
    startServer: async (docRoot) => {
      served.push(docRoot);
      return { url: `http://127.0.0.1:1234/?root=${docRoot}`, stop: async () => {} };
    },
    runBuild: async (cmd, cwd) => {
      builds.push({ cmd, cwd });
      return true;
    },
    served,
    builds,
    ...over,
  };
}

test("serveBuild serves existing compiled output without building", async () => {
  const d = deps({ exists: fs(["/r/dist/index.html", "/r/package.json"]) });
  const out = await serveBuild("/r", d);
  expect(out?.url).toContain("/r/dist");
  expect(d.builds).toEqual([]); // no build when output already present
});

test("serveBuild builds when only source is present, then serves the output", async () => {
  // Before build: no output. runBuild flips dist/index.html into existence.
  const present = new Set(["/r/package.json", "/r/bun.lock", "/r/node_modules"]);
  const d = deps({
    exists: (p) => present.has(p),
    readFile: () => JSON.stringify({ scripts: { build: "vite build" } }),
    runBuild: async () => {
      // simulate the build producing dist/index.html
      present.add("/r/dist/index.html");
      return true;
    },
  });
  const out = await serveBuild("/r", d);
  // Only reachable if the build ran and produced dist/index.html (the override adds it).
  expect(out?.url).toContain("/r/dist");
});

test("serveBuild skips the build when node_modules is absent, falls back to a static root", async () => {
  const d = deps({ exists: fs(["/r/package.json", "/r/bun.lock", "/r/index.html"]) });
  const out = await serveBuild("/r", d);
  expect(d.builds).toEqual([]); // deps not installed → never runs a build
  expect(out?.url).toContain("root=/r"); // static index.html fallback
});

test("serveBuild returns null when nothing is serveable", async () => {
  const d = deps({ exists: fs(["/r/package.json"]) }); // no output, no build script content, no index.html
  const out = await serveBuild("/r", d);
  expect(out).toBe(null);
  expect(d.served).toEqual([]);
});

test("serveBuild never throws — a failing startServer degrades to null", async () => {
  const d = deps({
    exists: fs(["/r/dist/index.html"]),
    startServer: async () => {
      throw new Error("port bind failed");
    },
  });
  const out = await serveBuild("/r", d);
  expect(out).toBe(null);
});
