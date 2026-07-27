/**
 * BetterWright-backed controller used by the isolated computer-use host.
 *
 * BetterWright owns the persistent browser, policy enforcement, and sandbox for
 * model-authored snippets. This adapter keeps Beckett's lease/proof contract at
 * the host boundary without exposing a raw Playwright/CDP handle to the model.
 *
 * Since betterwright 1.3.0 the session daemon runs separate `--session`s
 * concurrently while keeping calls *within* one session strictly ordered (see
 * node_modules/betterwright/docs/sessions.md). This adapter holds a map of
 * concurrent leases — one betterwright session per run — instead of a single
 * global lease. Every per-run guard (profile-budget accounting, per-session
 * download approval, proof capture, and the event ring) is keyed off its own
 * lease so one run can never blind, throttle, or corrupt another.
 *
 * Concurrency is capped (default 3, `BECKETT_BROWSER_MAX_LEASES`). The kill
 * switch `BECKETT_BROWSER_SINGLE_LEASE=1` pins the cap to one lease, restoring
 * the pre-1.3.0 strictly-single-lease behaviour without a revert.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BetterWright, NetworkPolicy, piImageArtifacts } from "betterwright";
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
const MAX_EVENTS = 100;
/** Default concurrent-lease cap. A real browser on a real machine, not a fleet. */
const DEFAULT_MAX_LEASES = 3;
/** Absolute upper bound on the cap regardless of configuration. */
const MAX_LEASES_HARD_CAP = 16;
/** Global absolute ceiling for the shared Chromium profile directory. */
const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
/** Per-lease growth allowance, measured from each lease's own acquire baseline. */
const MAX_PROFILE_GROWTH_BYTES = 100 * 1024 * 1024;

/** The slice of the betterwright client this adapter drives; injectable for tests. */
export interface BetterWrightClient {
  run(code: string, options?: { session?: string; approvedDownloads?: boolean; note?: string; timeout?: number }): Promise<unknown>;
  closeSession?(session?: string): Promise<unknown>;
  close(): Promise<void>;
}

interface ActiveLease extends BrowserLease {
  /** BetterWright session this lease is pinned to; one session per run. */
  session: string;
  /** Per-lease event ring — never interleaves with another lease's events. */
  events: string[];
  screenshots: string[];
  /** Serializes this lease's own calls so they stay strictly ordered. */
  queue: Promise<void>;
  /** Shared-profile size observed when this lease acquired, its growth baseline. */
  profileBytesAtAcquire: number;
  /** Per-lease budget breach; set only for the offending lease, never shared. */
  profileBudgetError: Error | null;
}

interface BetterWrightResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  console?: unknown[];
  events?: unknown[];
  artifacts?: Array<{ path?: unknown; kind?: unknown; media?: unknown }>;
  pages?: Array<{ url?: unknown; title?: unknown; active?: unknown }>;
  durationMs?: unknown;
  [key: string]: unknown;
}

/** Raised when a lease is requested past the concurrency cap. Catchable, never hangs. */
export class BrowserLeaseCapExceededError extends Error {
  readonly cap: number;
  readonly runId: string;
  constructor(cap: number, runId: string) {
    super(`browser lease cap of ${cap} concurrent session(s) reached; cannot acquire run ${runId} until one releases`);
    this.name = "BrowserLeaseCapExceededError";
    this.cap = cap;
    this.runId = runId;
  }
}

export interface CreateBetterWrightRuntimeDeps {
  /** Factory for the betterwright client; defaults to the managed CloakBrowser. */
  createBrowser?: (options: ConstructorParameters<typeof BetterWright>[0]) => BetterWrightClient;
  /** Concurrent-lease cap override; falls back to env / the default of 3. */
  maxLeases?: number;
  /** Kill switch override; pins the cap to a single lease when true. */
  singleLease?: boolean;
  /** Shared-profile size probe; defaults to scanning the betterwright home. */
  measureProfileBytes?: () => Promise<number>;
  maxProfileBytes?: number;
  maxProfileGrowthBytes?: number;
  /** Environment source for the cap / kill-switch; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** The betterwright adapter plus the multi-lease controls #21.2 wires into routing. */
export interface BetterWrightRuntime extends BrowserRuntime {
  /** Resolved concurrent-lease cap (1 when the kill switch is engaged). */
  readonly maxConcurrentLeases: number;
  /** Session names of the currently live leases. */
  sessions(): string[];
  /**
   * Grant/revoke this lease's download approval. BetterWright receives it on
   * each run as `approvedDownloads`; it never mutates shared launch policy.
   */
  approveDownloads(runId: string, approved?: boolean): void;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function boundedBudget(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit;
  if (!Number.isFinite(value) || value <= 0) throw new Error("browser budget overrides must be positive numbers");
  return Math.min(hardLimit, Math.floor(value));
}

/** Best-effort allocated-bytes scan of the shared profile; races are treated as stable. */
async function measureDirectoryBytes(root: string, stopAfter = Number.POSITIVE_INFINITY): Promise<number> {
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
      // Chromium churns cache files under the profile; the next scan sees stable state.
    }
  }
  return total;
}

export function createBetterWrightRuntime(
  settings: BrowserHostSettings,
  logger: Logger,
  deps: CreateBetterWrightRuntimeDeps = {},
): BetterWrightRuntime {
  // BetterWright keeps its profile and worker state below this dedicated browser
  // directory. The host itself remains lease-scoped, so a parked question keeps
  // the same BetterWright session alive while cookies persist between leases.
  const home = join(resolve(settings.profileDir), "betterwright");
  const env = deps.env ?? process.env;
  const killSwitch = deps.singleLease ?? isTruthyEnv(env.BECKETT_BROWSER_SINGLE_LEASE);
  const configuredMax = deps.maxLeases ?? parsePositiveInt(env.BECKETT_BROWSER_MAX_LEASES) ?? DEFAULT_MAX_LEASES;
  const maxLeases = killSwitch ? 1 : Math.min(MAX_LEASES_HARD_CAP, Math.max(1, configuredMax));
  const maxProfileBytes = boundedBudget(deps.maxProfileBytes, MAX_PROFILE_BYTES);
  const maxProfileGrowthBytes = boundedBudget(deps.maxProfileGrowthBytes, MAX_PROFILE_GROWTH_BYTES);
  const measureProfileBytes = deps.measureProfileBytes ?? (() => measureDirectoryBytes(home, maxProfileBytes + 1));

  const createBrowser = deps.createBrowser ?? ((options) => new BetterWright(options) as unknown as BetterWrightClient);
  const browser = createBrowser({
    home,
    // 1.x keeps `browser: "cloak"` as the only pluggable flavor and provisions
    // its own signed CloakBrowser binary via `betterwright setup --cloak-only`,
    // so the host neither picks a browser flavor nor hands in a Playwright
    // executable path. (`betterwright setup`/`update` can also install a native
    // Chromium fork under ~/.betterwright, but that artifact is never bound into
    // this bubblewrap sandbox — see isolated.ts — so the managed CloakBrowser
    // cache stays the only browser reachable inside it.)
    headless: settings.headless,
    defaultTimeout: Math.max(5, Math.ceil(settings.evalTimeoutMs / 1_000)),
    // Pin the open private-network and loopback defaults explicitly so Beckett's
    // local/intranet access survives future upgrades.
    policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
    // This is a launch-only setting. `ask` gates each download on the
    // `approvedDownloads` bit supplied with that specific session run.
    // Changing it after launch hot-restarts BetterWright's shared worker.
    downloadPolicy: "ask",
    publicSearchPolicy: "block",
  });

  const leases = new Map<string, ActiveLease>();
  // Session-scoped download approval. This is intentionally a set rather than
  // browser configuration: every `run` gets only its own session's bit.
  const downloadReferences = new Set<string>();
  let stopped = false;
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let pages = 0;

  function requireLease(runId: string): ActiveLease {
    const lease = leases.get(runId);
    if (!lease) throw new Error(`browser lease ${runId} is not active`);
    return lease;
  }

  function pushLeaseEvent(lease: ActiveLease, message: string): void {
    lease.events.push(message.length > 500 ? `${message.slice(0, 497)}...` : message);
    while (lease.events.length > MAX_EVENTS) lease.events.shift();
  }

  /** Chain this lease's work so calls within one lease stay strictly ordered. */
  function runOnLease<T>(lease: ActiveLease, task: () => Promise<T>): Promise<T> {
    const next = lease.queue.then(task, task);
    lease.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function enforceProfileBudget(lease: ActiveLease): Promise<void> {
    // A lease that already tripped stays tripped until it releases; re-scanning
    // cannot un-trip it and must never touch another lease's accounting.
    if (lease.profileBudgetError) return;
    const profileBytes = await measureProfileBytes();
    // Growth allowance is per-lease (its own acquire baseline); the ceiling is
    // global and shared. Whichever binds first wins.
    const storageLimit = Math.min(maxProfileBytes, lease.profileBytesAtAcquire + maxProfileGrowthBytes);
    if (profileBytes > storageLimit) {
      const growthBytes = Math.max(0, profileBytes - lease.profileBytesAtAcquire);
      lease.profileBudgetError = new Error(
        `browser profile storage budget exceeded for run ${lease.runId} (profile=${profileBytes}, lease growth=${growthBytes} bytes)`,
      );
      pushLeaseEvent(lease, `[profile blocked] ${lease.profileBudgetError.message}`);
    }
  }

  function assertProfileHealthy(lease: ActiveLease): void {
    if (lease.profileBudgetError) throw lease.profileBudgetError;
  }

  function copyArtifacts(result: BetterWrightResult, lease: ActiveLease): string[] {
    mkdirSync(lease.artifactsDir, { recursive: true, mode: 0o700 });
    const copied: string[] = [];
    // 1.x exposes screenshot files through the artifact's `MEDIA:`-prefixed
    // `media` field; piImageArtifacts resolves that (and legacy `path`) to real
    // local image paths, so copy those rather than reading `artifact.path`.
    for (const image of piImageArtifacts(result)) {
      if (!existsSync(image.path)) continue;
      const target = join(resolve(lease.artifactsDir), `betterwright-${Date.now()}-${copied.length}-${basename(image.path)}`);
      copyFileSync(image.path, target);
      copied.push(target);
    }
    return copied;
  }

  /** Raw evaluation on one lease's session. Callers must already hold the lease queue. */
  async function execute(lease: ActiveLease, code: string): Promise<BrowserEvalResult> {
    if (!code.trim()) throw new Error("betterwright browser requires non-empty JavaScript");
    if (code.length > MAX_CODE_CHARS) throw new Error(`betterwright browser code exceeds ${MAX_CODE_CHARS} characters`);
    const raw = await browser.run(code, {
      session: lease.session,
      approvedDownloads: downloadReferences.has(lease.session),
    }) as BetterWrightResult;
    const screenshots = copyArtifacts(raw, lease);
    const summaries = raw.pages ?? [];
    const events = (raw.events ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
    for (const entry of events) pushLeaseEvent(lease, entry);
    const result: BrowserEvalResult = {
      value: raw.result,
      console: (raw.console ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)),
      pages: summaries.map((entry, index) => ({
        index,
        active: entry.active === true,
        url: typeof entry.url === "string" ? entry.url : "about:blank",
        title: typeof entry.title === "string" ? entry.title : "",
      })),
      events,
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

  /** Proof/question capture on one lease. Callers must already hold the lease queue. */
  async function captureOnLease(lease: ActiveLease, name: string): Promise<string> {
    const result = await execute(
      lease,
      `return await screenshot({ kind: ${JSON.stringify(name === "proof-auto" ? "proof" : "question")}, name: ${JSON.stringify(name)} })`,
    );
    const screenshot = result.screenshots[0];
    if (!screenshot) throw new Error("BetterWright did not produce a screenshot");
    return screenshot;
  }

  function releaseDownloadReference(lease: ActiveLease): void {
    downloadReferences.delete(lease.session);
  }

  const runtime: BetterWrightRuntime = {
    maxConcurrentLeases: maxLeases,

    sessions() {
      return [...leases.values()].map((lease) => lease.session);
    },

    approveDownloads(runId, approved = true) {
      const lease = requireLease(runId);
      if (approved) downloadReferences.add(lease.session);
      else downloadReferences.delete(lease.session);
    },

    async acquire(lease) {
      if (stopped) throw new Error("browser runtime is stopped");
      if (leases.has(lease.runId)) return;
      if (leases.size >= maxLeases) {
        if (maxLeases === 1) {
          const occupying = leases.values().next().value as ActiveLease | undefined;
          throw new Error(`computer-use is busy with run ${occupying?.runId}; retry after it finishes`);
        }
        throw new BrowserLeaseCapExceededError(maxLeases, lease.runId);
      }
      // Reserve the slot synchronously — before any await — so concurrent
      // acquisitions cannot both slip past the cap.
      const active: ActiveLease = {
        ...lease,
        session: lease.runId,
        events: [],
        screenshots: [],
        queue: Promise.resolve(),
        profileBytesAtAcquire: 0,
        profileBudgetError: null,
      };
      leases.set(lease.runId, active);
      launches++;
      try {
        active.profileBytesAtAcquire = await measureProfileBytes();
        // Start the BetterWright worker now so unavailable browser setup fails
        // before the agent begins its turn.
        await runOnLease(active, () => execute(active, "return page.url()"));
        logger.info("BetterWright browser lease acquired", {
          runId: lease.runId,
          channelId: lease.channelId,
          session: active.session,
          live: leases.size,
        });
      } catch (error) {
        leases.delete(lease.runId);
        releaseDownloadReference(active);
        throw error;
      }
    },

    async evaluate(runId, code) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        return execute(lease, code);
      });
    },

    async capture(runId, name) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        return captureOnLease(lease, name);
      });
    },

    async checkpoint(runId) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        const result = await execute(lease, "return pages.map((candidate) => candidate.url())");
        const urls = Array.isArray(result.value) ? result.value.filter((url): url is string => typeof url === "string").slice(0, 8) : [];
        const activeIndex = Math.max(0, result.pages.findIndex((page) => page.active));
        return { urls, activeIndex };
      });
    },

    async restore(runId, checkpoint: BrowserCheckpoint) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        const urls = checkpoint.urls.filter((url) => /^https?:\/\//i.test(url) || url === "about:blank").slice(0, 8);
        if (urls.length === 0) return;
        await execute(lease, `await Promise.all(${JSON.stringify(urls)}.map((url) => openPage(url))); return pages.length`);
      });
    },

    async release(runId, captureProof) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        const proofFiles: string[] = [];
        try {
          if (captureProof) {
            await enforceProfileBudget(lease);
            if (!lease.profileBudgetError) proofFiles.push(await captureOnLease(lease, "proof-auto"));
          }
          return proofFiles;
        } catch (error) {
          logger.warn("BetterWright proof capture failed on release", {
            runId,
            error: String((error as Error).message ?? error),
          });
          return proofFiles;
        } finally {
          leases.delete(lease.runId);
          releaseDownloadReference(lease);
          if (browser.closeSession) await browser.closeSession(lease.session).catch(() => undefined);
          logger.info("BetterWright browser lease released", { runId: lease.runId, live: leases.size });
        }
      });
    },

    hasLease(runId) {
      return leases.has(runId);
    },

    stats(): BrowserRuntimeStats {
      const first = leases.values().next().value as ActiveLease | undefined;
      return {
        ready: leases.size > 0,
        profileDir: settings.profileDir,
        activeRunId: first?.runId ?? null,
        pages,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      stopped = true;
      leases.clear();
      downloadReferences.clear();
      await browser.close();
    },
  };

  return runtime;
}
