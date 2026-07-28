/**
 * Beckett — local static serve of a built branch (`src/preview/serve-build.ts`)
 * =======================================================================================
 * The screenshot capturer (#75) needs the built frontend reachable on a URL so a browser run can
 * open it. This stands the build up on a throwaway loopback port from a ticket's OWN worktree —
 * the actual built branch, not `main` — and hands back a teardown handle.
 *
 * It is deliberately minimal, not a PaaS (see {@link file://./index.ts}'s header for the same
 * stance about previews). The rule is: serve whatever is already serveable, build only when that
 * is the only way to get something, and give up cleanly the moment neither works. Every step is
 * best-effort and time-boxed so a finish path can fire it and forget it.
 *
 *   1. If a framework's compiled output already exists (`dist/`, `build/`, …) → serve it.
 *   2. Else, if the project declares a `build` script AND its deps are installed → run it (bounded),
 *      then serve the output that produced.
 *   3. Else, if a genuinely static site exists (a plain `index.html`) → serve that as-is.
 *   4. Else → return null; there is nothing to screenshot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Logger } from "../types.ts";

/** A locally-served build: a loopback URL and an idempotent teardown. */
export interface ServedBuild {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Compiled-output directory names, highest-fidelity first. Only served when they hold an
 * `index.html` (an empty or partial dir is not a runnable build).
 */
const BUILD_OUTPUT_DIRS = ["dist", "build", "out", ".output/public", ".svelte-kit/output/client"] as const;

/** Root-relative dirs (besides the repo root) where a genuinely static `index.html` commonly lives. */
const STATIC_ROOTS = ["", "public", "web", "site", "client", "frontend", "www", "docs"] as const;

/** The first `BUILD_OUTPUT_DIRS` entry that holds an `index.html`, else null. Pure. */
export function firstBuildOutput(repoRoot: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const rel of BUILD_OUTPUT_DIRS) {
    const dir = join(repoRoot, rel);
    if (exists(join(dir, "index.html"))) return dir;
  }
  return null;
}

/** The first `STATIC_ROOTS` entry that holds an `index.html`, else null. Pure. */
export function firstStaticRoot(repoRoot: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const rel of STATIC_ROOTS) {
    const dir = rel ? join(repoRoot, rel) : repoRoot;
    if (exists(join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * The package-manager `build` invocation for a project that declares one, else null. Picks the
 * manager from the committed lockfile so we run the toolchain the project actually uses. Pure.
 */
export function detectBuildCommand(
  repoRoot: string,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string[] | null {
  const pkgPath = join(repoRoot, "package.json");
  if (!exists(pkgPath)) return null;
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(read(pkgPath)) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
  if (!pkg.scripts?.build) return null;
  if (exists(join(repoRoot, "bun.lock")) || exists(join(repoRoot, "bun.lockb"))) return ["bun", "run", "build"];
  if (exists(join(repoRoot, "pnpm-lock.yaml"))) return ["pnpm", "run", "build"];
  if (exists(join(repoRoot, "yarn.lock"))) return ["yarn", "run", "build"];
  return ["npm", "run", "build"];
}

export interface ServeBuildDeps {
  logger: Logger;
  /** Wall-clock cap for a `build` run before it is killed. Default 120s. */
  buildTimeoutMs?: number;
  /** Run the build command; resolves true on a clean (exit 0) build. Injectable for tests. */
  runBuild?: (cmd: string[], cwd: string, timeoutMs: number) => Promise<boolean>;
  /** Start a static file server for `docRoot`; returns its loopback URL + teardown. Injectable. */
  startServer?: (docRoot: string) => Promise<ServedBuild>;
  /** Filesystem existence probe (tests inject a fake tree). */
  exists?: (p: string) => boolean;
}

/**
 * Stand a ticket's built frontend up on a loopback URL, or return null when nothing is serveable.
 * Never throws: any build/serve failure logs and yields null (best-effort, per #75).
 */
export async function serveBuild(repoRoot: string, deps: ServeBuildDeps): Promise<ServedBuild | null> {
  const exists = deps.exists ?? existsSync;
  try {
    // 1. Already-compiled output is the best screenshot; prefer it.
    let docRoot = firstBuildOutput(repoRoot, exists);

    // 2. Only source present → build it, if the project declares one and its deps are installed.
    if (!docRoot) {
      const cmd = detectBuildCommand(repoRoot, exists);
      if (cmd && exists(join(repoRoot, "node_modules"))) {
        deps.logger.info("serve-build: building the frontend", { repoRoot, cmd: cmd.join(" ") });
        const ok = await (deps.runBuild ?? defaultRunBuild)(cmd, repoRoot, deps.buildTimeoutMs ?? 120_000);
        if (ok) docRoot = firstBuildOutput(repoRoot, exists);
        else deps.logger.info("serve-build: build did not succeed; will try a static fallback", { repoRoot });
      }
    }

    // 3. Last resort: a genuinely static site we can serve as-is.
    if (!docRoot) docRoot = firstStaticRoot(repoRoot, exists);

    if (!docRoot) {
      deps.logger.info("serve-build: no runnable frontend build found", { repoRoot });
      return null;
    }

    const served = await (deps.startServer ?? defaultStartServer)(docRoot);
    deps.logger.info("serve-build: serving locally", { docRoot, url: served.url });
    return served;
  } catch (err) {
    deps.logger.warn("serve-build: failed", { repoRoot, error: (err as Error).message });
    return null;
  }
}

/** Run a build with a hard timeout; kill and fail on overrun. Uses Bun's subprocess in the daemon. */
async function defaultRunBuild(cmd: string[], cwd: string, timeoutMs: number): Promise<boolean> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    // CI=1 keeps toolchains non-interactive; no colour/telemetry prompts to hang on.
    env: { ...process.env, CI: "1" },
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  try {
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A tiny loopback static server with SPA fallback (unknown paths → index.html), bound to an
 * ephemeral 127.0.0.1 port. Loopback is reachable from the browser host, which shares the network
 * namespace (`--share-net`). Path-traversal is contained to `docRoot`.
 */
async function defaultStartServer(docRoot: string): Promise<ServedBuild> {
  const root = resolve(docRoot);
  const indexPath = join(root, "index.html");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      let rel = decodeURIComponent(pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const target = normalize(join(root, rel));
      // Contain traversal: anything resolving outside docRoot falls back to the SPA entrypoint.
      const inRoot = target === root || target.startsWith(root + "/");
      const file = inRoot ? Bun.file(target) : Bun.file(indexPath);
      if (await file.exists()) return new Response(file);
      const fallback = Bun.file(indexPath);
      if (await fallback.exists()) return new Response(fallback);
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  return {
    url,
    stop: async () => {
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}
