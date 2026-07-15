/**
 * BetterWright-backed controller used by the isolated computer-use host.
 *
 * BetterWright owns the persistent browser, policy enforcement, and sandbox for
 * model-authored snippets. This adapter keeps Beckett's lease/proof contract at
 * the host boundary without exposing a raw Playwright/CDP handle to the model.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BetterWright, NetworkPolicy } from "betterwright";
import { chromium } from "playwright";
import type { Logger } from "../types.ts";
import type {
  BrowserCheckpoint,
  BrowserEvalResult,
  BrowserHostSettings,
  BrowserLease,
  BrowserRuntime,
  BrowserRuntimeStats,
} from "./runtime.ts";

const MAX_CODE_CHARS = 100_000;

interface ActiveLease extends BrowserLease {
  session: string;
}

interface BetterWrightResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  console?: unknown[];
  events?: unknown[];
  artifacts?: Array<{ path?: unknown; kind?: unknown }>;
  pages?: Array<{ url?: unknown; title?: unknown; active?: unknown }>;
  durationMs?: unknown;
}

export function createBetterWrightRuntime(settings: BrowserHostSettings, logger: Logger): BrowserRuntime {
  // BetterWright keeps its profile and worker state below this dedicated browser
  // directory. The host itself remains lease-scoped, so a parked question keeps
  // the same BetterWright session alive while cookies persist between leases.
  const home = join(resolve(settings.profileDir), "betterwright");
  const browser = new BetterWright({
    home,
    browser: "chromium",
    executablePath: chromium.executablePath(),
    headless: settings.headless,
    defaultTimeout: Math.max(5, Math.ceil(settings.evalTimeoutMs / 1_000)),
    // BetterWright 0.5 opens private-network access by default. Keep Beckett's
    // existing boundary: local smoke pages work, but other private hosts do not.
    policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: false }),
    downloadPolicy: "deny",
    publicSearchPolicy: "block",
  });

  let active: ActiveLease | null = null;
  let stopped = false;
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let pages = 0;

  function requireLease(runId: string): ActiveLease {
    if (!active || active.runId !== runId) throw new Error("browser lease is not active");
    return active;
  }

  function copyArtifacts(result: BetterWrightResult, lease: ActiveLease): string[] {
    mkdirSync(lease.artifactsDir, { recursive: true, mode: 0o700 });
    const copied: string[] = [];
    for (const artifact of result.artifacts ?? []) {
      if (typeof artifact.path !== "string" || !/\.png$/i.test(artifact.path) || !existsSync(artifact.path)) continue;
      const target = join(resolve(lease.artifactsDir), `betterwright-${Date.now()}-${copied.length}-${basename(artifact.path)}`);
      copyFileSync(artifact.path, target);
      copied.push(target);
    }
    return copied;
  }

  async function execute(lease: ActiveLease, code: string): Promise<BrowserEvalResult> {
    if (!code.trim()) throw new Error("betterwright browser requires non-empty JavaScript");
    if (code.length > MAX_CODE_CHARS) throw new Error(`betterwright browser code exceeds ${MAX_CODE_CHARS} characters`);
    const raw = await browser.run(code, { session: lease.session }) as BetterWrightResult;
    const screenshots = copyArtifacts(raw, lease);
    const summaries = raw.pages ?? [];
    const result: BrowserEvalResult = {
      value: raw.result,
      console: (raw.console ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)),
      pages: summaries.map((entry, index) => ({
        index,
        active: entry.active === true,
        url: typeof entry.url === "string" ? entry.url : "about:blank",
        title: typeof entry.title === "string" ? entry.title : "",
      })),
      events: (raw.events ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)),
      screenshots,
      elapsedMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
      truncated: false,
    };
    pages = result.pages.length;
    evaluations++;
    totalEvalMs += result.elapsedMs;
    if (!raw.ok) throw new Error(raw.error ?? "betterwright browser evaluation failed");
    return result;
  }

  return {
    async acquire(lease) {
      if (stopped) throw new Error("browser runtime is stopped");
      if (active && active.runId !== lease.runId) throw new Error(`computer-use is busy with run ${active.runId}; retry after it finishes`);
      if (active) return;
      active = { ...lease, session: lease.runId };
      launches++;
      // Start the BetterWright worker now so unavailable browser setup fails
      // before the agent begins its turn.
      await execute(active, "return page.url()");
      logger.info("BetterWright browser lease acquired", { runId: lease.runId, channelId: lease.channelId });
    },

    async evaluate(runId, code) {
      return execute(requireLease(runId), code);
    },

    async capture(runId, name) {
      const lease = requireLease(runId);
      const result = await execute(lease, `return await screenshot({ kind: ${JSON.stringify(name === "proof-auto" ? "proof" : "question")}, name: ${JSON.stringify(name)} })`);
      const screenshot = result.screenshots[0];
      if (!screenshot) throw new Error("BetterWright did not produce a screenshot");
      return screenshot;
    },

    async checkpoint(runId) {
      const lease = requireLease(runId);
      const result = await execute(lease, "return pages.map((candidate) => candidate.url())");
      const urls = Array.isArray(result.value) ? result.value.filter((url): url is string => typeof url === "string").slice(0, 8) : [];
      const activeIndex = Math.max(0, result.pages.findIndex((page) => page.active));
      return { urls, activeIndex };
    },

    async restore(runId, checkpoint: BrowserCheckpoint) {
      const lease = requireLease(runId);
      const urls = checkpoint.urls.filter((url) => /^https?:\/\//i.test(url) || url === "about:blank").slice(0, 8);
      if (urls.length === 0) return;
      await execute(lease, `await Promise.all(${JSON.stringify(urls)}.map((url) => openPage(url))); return pages.length`);
    },

    async release(runId, captureProof) {
      const lease = requireLease(runId);
      try {
        if (captureProof) return [await this.capture(runId, "proof-auto")];
        return [];
      } finally {
        active = null;
        logger.info("BetterWright browser lease released", { runId: lease.runId });
      }
    },

    hasLease(runId) {
      return active?.runId === runId;
    },

    stats(): BrowserRuntimeStats {
      return {
        ready: active !== null,
        profileDir: settings.profileDir,
        activeRunId: active?.runId ?? null,
        pages,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      stopped = true;
      active = null;
      await browser.close();
    },
  };
}
