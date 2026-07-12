/**
 * Daemon-side supervisor for the browser host subprocess.
 *
 * A host lives for one complete computer-use lease, including question waits, then exits. The
 * Chromium profile remains on disk so cookies survive, while escaped JavaScript state cannot leak
 * into a later run. Production modes fail closed when their OS sandbox is unavailable; explicit
 * process-only mode exists for local benchmark development and is never selected automatically.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Logger } from "../types.ts";
import { runBrowserEvaluator } from "./evaluator-runner.ts";
import type { BrowserHostRequest, BrowserHostResponse, BrowserHostMethod } from "./host.ts";
import type {
  BrowserEvalResult,
  BrowserCheckpoint,
  BrowserBudgetOverrides,
  BrowserEvaluatorOutput,
  BrowserEvaluatorSession,
  BrowserHostSettings,
  BrowserLease,
  BrowserRuntime,
  BrowserRuntimeStats,
} from "./runtime.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_PATH = join(MODULE_DIR, "host.ts");
const HOST_BUNDLES = new Map<string, Promise<string>>();
const MAX_HOST_LINE_CHARS = 32 * 1024 * 1024;
const MAX_CODE_CHARS = 100_000;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type HostChild = ReturnType<typeof Bun.spawn>;
type SandboxMode = "auto" | "none" | "macos";

interface PendingRequest {
  child: HostChild;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CreateIsolatedBrowserRuntimeDeps {
  settings: BrowserHostSettings;
  logger: Logger;
  spawn?: typeof Bun.spawn;
  platform?: NodeJS.Platform;
  sandbox?: SandboxMode;
  execPath?: string;
  chromiumExecutable?: string;
  repoRoot?: string;
  bwrapPath?: string;
  sandboxExecPath?: string;
  nodePath?: string;
  prlimitPath?: string;
  evaluatorPath?: string;
  /** Focused integration-test reductions; runtime hard limits cannot be raised. */
  hostBudgetOverrides?: BrowserBudgetOverrides;
}

export interface BrowserHostLaunch {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  isolation: "bubblewrap" | "sandbox-exec" | "process";
}

interface BuildBrowserHostLaunchOptions {
  settings: BrowserHostSettings;
  platform: NodeJS.Platform;
  sandbox: SandboxMode;
  execPath: string;
  nodePath?: string;
  hostPath: string;
  chromiumExecutable: string;
  repoRoot: string;
  bwrapPath?: string;
  sandboxExecPath?: string;
  prlimitPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
  budgetOverrides?: BrowserBudgetOverrides;
}

/** Pure command builder, exported so Linux/macOS sandbox policy remains unit-testable. */
export function buildBrowserHostLaunch(options: BuildBrowserHostLaunchOptions): BrowserHostLaunch {
  const repoRoot = resolve(options.repoRoot);
  const nodePath = realpathIfPossible(options.nodePath ?? options.execPath);
  const hostPath = realpathIfPossible(options.hostPath);
  const browserRoot = playwrightBrowserRoot(options.chromiumExecutable);
  const hostHome = join(options.settings.profileDir, ".host-home");
  // Chromium places a SingletonSocket below TMPDIR and Linux limits Unix socket paths to roughly
  // 108 bytes. A short 0700 temp root avoids profile paths making otherwise valid launches abort.
  const profileHash = createHash("sha256").update(options.settings.profileDir).digest("hex").slice(0, 12);
  const hostTmp = join("/tmp", `beckett-browser-${profileHash}`);
  mkdirSync(options.settings.profileDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.settings.artifactsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  mkdirSync(hostTmp, { recursive: true, mode: 0o700 });

  const encodedSettings = Buffer.from(JSON.stringify(options.settings), "utf8").toString("base64url");
  const encodedBudgets = options.budgetOverrides
    ? Buffer.from(JSON.stringify(options.budgetOverrides), "utf8").toString("base64url")
    : undefined;
  const baseEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: hostHome,
    TMPDIR: hostTmp,
    XDG_CACHE_HOME: join(hostTmp, "cache"),
    XDG_CONFIG_HOME: join(hostTmp, "config"),
    LANG: "C.UTF-8",
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
    BECKETT_BROWSER_HOST_SETTINGS: encodedSettings,
    ...(encodedBudgets ? { BECKETT_BROWSER_HOST_BUDGETS: encodedBudgets } : {}),
  };
  if (options.sandbox === "none") {
    return {
      command: [nodePath, hostPath],
      cwd: repoRoot,
      env: baseEnv,
      isolation: "process",
    };
  }

  if (options.platform === "linux") {
    const bwrap = options.bwrapPath ?? findExecutable("bwrap", options.parentEnv?.PATH);
    if (!bwrap) {
      throw new Error("secure computer-use on Linux requires bubblewrap (bwrap) in PATH");
    }
    const prlimit = options.prlimitPath ?? findExecutable("prlimit", options.parentEnv?.PATH);
    if (!prlimit) throw new Error("secure computer-use on Linux requires prlimit (util-linux) in PATH");
    const args = [
      bwrap,
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp/home",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "XDG_CACHE_HOME",
      "/tmp/cache",
      "--setenv",
      "XDG_CONFIG_HOME",
      "/tmp/config",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "PLAYWRIGHT_BROWSERS_PATH",
      "/ms-playwright",
      "--setenv",
      "BECKETT_BROWSER_HOST_SETTINGS",
      encodedSettings,
    ];
    if (encodedBudgets) args.push("--setenv", "BECKETT_BROWSER_HOST_BUDGETS", encodedBudgets);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    addLinuxSystemMounts(args);
    // bwrap creates missing parents for bind destinations. /runtime is explicit because its child
    // is a file mount rather than a directory mount.
    args.push(
      "--dir",
      "/runtime",
      "--ro-bind",
      nodePath,
      "/runtime/node",
      "--ro-bind",
      browserRoot,
      "/ms-playwright",
      "--bind",
      options.settings.profileDir,
      options.settings.profileDir,
      "--bind",
      options.settings.artifactsRoot,
      options.settings.artifactsRoot,
      "--dir",
      "/tmp/home",
      "--dir",
      "/tmp/cache",
      "--dir",
      "/tmp/config",
    );
    addBrowserRuntimeMounts(args, repoRoot, hostPath);
    args.push(
      "--chdir",
      "/repo",
      "--",
      "/runtime/node",
      "/repo/node_modules/.cache/beckett-browser/host.mjs",
    );
    // bwrap receives a minimal environment too; --clearenv controls the sandboxed child.
    return {
      // Chromium inherits this per-file ceiling, so a download cannot fill the disk before the
      // controller's aggregate streaming budget gets a chance to cancel and delete it.
      command: [prlimit, "--fsize=134217728", "--", ...args],
      cwd: repoRoot,
      env: { PATH: options.parentEnv?.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      isolation: "bubblewrap",
    };
  }

  if (options.platform === "darwin") {
    const sandboxExec = options.sandboxExecPath ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : undefined);
    if (sandboxExec) {
      const profile = macSandboxProfile({
        repoRoot,
        execPath: nodePath,
        browserRoot,
        profileDir: options.settings.profileDir,
        artifactsRoot: options.settings.artifactsRoot,
        hostTmp,
      });
      return {
        command: [sandboxExec, "-p", profile, nodePath, hostPath],
        cwd: repoRoot,
        env: baseEnv,
        isolation: "sandbox-exec",
      };
    }
    throw new Error(
      "secure computer-use on macOS requires sandbox-exec; use explicit process-only mode only for local testing",
    );
  }

  throw new Error(`secure computer-use is unsupported on ${options.platform}; use explicit process-only mode only for testing`);
}

function browserHostBundle(repoRoot: string): Promise<string> {
  const root = resolve(repoRoot);
  const existing = HOST_BUNDLES.get(root);
  if (existing) return existing;
  const pending = buildBrowserHostBundle(root).catch((error) => {
    HOST_BUNDLES.delete(root);
    throw error;
  });
  HOST_BUNDLES.set(root, pending);
  return pending;
}

async function buildBrowserHostBundle(repoRoot: string): Promise<string> {
  const nodeModules = join(repoRoot, "node_modules");
  const cacheParent = join(nodeModules, ".cache");
  const cacheRoot = join(cacheParent, "beckett-browser");
  for (const path of [nodeModules, cacheParent, cacheRoot]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`browser host bundle path must not contain symlinks: ${path}`);
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const tempDir = join(cacheRoot, `.build-${process.pid}-${randomUUID()}`);
  mkdirSync(tempDir, { mode: 0o700 });
  try {
    const result = await Bun.build({
      entrypoints: [HOST_PATH],
      outdir: tempDir,
      naming: "host.mjs",
      target: "node",
      format: "esm",
      external: ["playwright", "playwright-core"],
    });
    if (!result.success || result.outputs.length !== 1) {
      const diagnostics = result.logs.map((log) => String(log)).join("\n");
      throw new Error(`could not build Node browser host${diagnostics ? `: ${diagnostics}` : ""}`);
    }
    const target = join(cacheRoot, "host.mjs");
    renameSync(result.outputs[0]!.path, target);
    chmodSync(target, 0o600);
    return realpathSync(target);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createIsolatedBrowserRuntime(deps: CreateIsolatedBrowserRuntimeDeps): BrowserRuntime {
  const { settings, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const platform = deps.platform ?? process.platform;
  const sandbox = deps.sandbox ?? "auto";
  const execPath = deps.execPath ?? process.execPath;
  const nodePath = deps.nodePath ?? findExecutable("node", process.env.PATH);
  if (!nodePath) throw new Error("computer-use browser host requires Node.js");
  const chromiumExecutable = deps.chromiumExecutable ?? chromium.executablePath();
  const repoRoot = deps.repoRoot ?? resolve(MODULE_DIR, "../..");

  let child: HostChild | null = null;
  let hostIsolation: BrowserHostLaunch["isolation"] | null = null;
  let starting: Promise<void> | null = null;
  let hostLeaseRunId: string | null = null;
  let lease: BrowserLease | null = null;
  let stopped = false;
  let nextRequestId = 1;
  let pending = new Map<number, PendingRequest>();
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let pages = 0;
  let evaluationQueue: Promise<void> = Promise.resolve();
  const delivered = new Map<string, string>();

  function serializeEvaluation<T>(task: () => Promise<T>): Promise<T> {
    const running = evaluationQueue.then(task, task);
    evaluationQueue = running.then(() => undefined, () => undefined);
    return running;
  }

  function requireLease(runId: string): BrowserLease {
    if (!lease || lease.runId !== runId) throw new Error(`browser lease ${runId} is not active`);
    return lease;
  }

  function requireControlToken(current: BrowserLease, supplied: string | undefined): void {
    const expected = Buffer.from(current.controlToken);
    const actual = Buffer.from(supplied ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("browser control capability rejected");
    }
  }

  function rejectPendingFor(target: HostChild, error: Error): void {
    for (const [id, request] of pending) {
      if (request.child !== target) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  }

  function markHostExited(target: HostChild, error: Error): void {
    rejectPendingFor(target, error);
    if (child === target) {
      child = null;
      hostIsolation = null;
      hostLeaseRunId = null;
      pages = 0;
    }
  }

  async function killHost(target: HostChild, reason: Error): Promise<void> {
    markHostExited(target, reason);
    killProcessGroup(target);
    await target.exited.catch(() => undefined);
  }

  function killProcessGroup(target: HostChild): void {
    try {
      if (target.pid > 0) process.kill(-target.pid, "SIGKILL");
      else target.kill("SIGKILL");
    } catch {
      try {
        target.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }

  function rpc(method: BrowserHostMethod, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const target = child;
    if (!target) return Promise.reject(new Error("isolated browser host is not running"));
    const id = nextRequestId++;
    const request: BrowserHostRequest = { version: 1, id, method, params };
    return new Promise((resolveValue, rejectValue) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`isolated browser host ${method} timed out after ${timeoutMs}ms`);
        rejectValue(error);
        void killHost(target, error);
      }, timeoutMs);
      pending.set(id, { child: target, timer, resolve: resolveValue, reject: rejectValue });
      try {
        const input = target.stdin;
        if (!input || typeof input === "number") throw new Error("isolated browser host stdin is unavailable");
        input.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        rejectValue(error as Error);
        void killHost(target, error as Error);
      }
    });
  }

  async function consumeStdout(target: HostChild): Promise<void> {
    const stream = target.stdout;
    if (!stream || typeof stream === "number") throw new Error("isolated browser host stdout is unavailable");
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > MAX_HOST_LINE_CHARS) throw new Error("isolated browser host output exceeded size limit");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) receiveResponse(target, line);
        newline = buffered.indexOf("\n");
      }
    }
    if (buffered.trim()) throw new Error("isolated browser host emitted an unterminated response");
  }

  function receiveResponse(target: HostChild, line: string): void {
    let response: BrowserHostResponse;
    try {
      response = JSON.parse(line) as BrowserHostResponse;
    } catch {
      throw new Error("isolated browser host emitted invalid JSON");
    }
    if (response.version !== 1 || !Number.isSafeInteger(response.id) || typeof response.ok !== "boolean") {
      throw new Error("isolated browser host emitted an invalid response envelope");
    }
    const request = pending.get(response.id);
    if (!request || request.child !== target) throw new Error(`isolated browser host emitted unknown response ${response.id}`);
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.data);
    else request.reject(new Error(response.error ?? "isolated browser host request failed"));
  }

  async function consumeStderr(target: HostChild): Promise<void> {
    const stream = target.stderr;
    if (!stream || typeof stream === "number") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let tail = "";
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-2_000);
    }
    tail = tail.trim();
    if (tail) logger.debug("isolated browser host diagnostics", { tail });
  }

  function hostSettingsForLease(current: BrowserLease): BrowserHostSettings {
    return { ...settings, artifactsRoot: resolve(current.artifactsDir) };
  }

  async function startHost(current: BrowserLease, forceProcess = false): Promise<void> {
    if (child) return;
    if (stopped) throw new Error("browser runtime is stopped");
    const currentSettings = hostSettingsForLease(current);
    const hostPath = await browserHostBundle(repoRoot);
    const launch = buildBrowserHostLaunch({
      settings: currentSettings,
      platform,
      sandbox: forceProcess ? "none" : sandbox,
      execPath,
      nodePath,
      hostPath,
      chromiumExecutable,
      repoRoot,
      bwrapPath: deps.bwrapPath,
      sandboxExecPath: deps.sandboxExecPath,
      prlimitPath: deps.prlimitPath,
      parentEnv: process.env,
      budgetOverrides: deps.hostBudgetOverrides,
    });
    if (launch.isolation === "process") {
      logger.warn("browser host has process isolation only; filesystem sandboxing is unavailable", { platform });
    }
    const target = spawn({
      cmd: launch.command,
      cwd: launch.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    child = target;
    hostIsolation = launch.isolation;
    void consumeStdout(target).catch((error) => killHost(target, error as Error));
    void consumeStderr(target);
    void target.exited.then((code) => {
      markHostExited(target, new Error(`isolated browser host exited with code ${code}`));
      // The host is Chromium's process-group leader, so reap descendants after any unexpected
      // controller failure even when the normal runtime.stop() path never ran.
      killProcessGroup(target);
    });
    await rpc("stats", {}, 5_000);
    logger.info("isolated browser host ready", { isolation: launch.isolation, runId: current.runId });
  }

  async function ensureHost(current: BrowserLease): Promise<void> {
    if (child) return;
    if (starting) return starting;
    starting = startHost(current, false).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function acquireInHost(current: BrowserLease): Promise<void> {
    try {
      await ensureHost(current);
      if (stopped) throw new Error("browser acquisition was interrupted by shutdown");
      if (hostLeaseRunId === current.runId) return;
      const hostLease = { runId: current.runId, channelId: current.channelId, artifactsDir: current.artifactsDir };
      const stats = (await rpc("acquire", hostLease, settings.launchTimeoutMs + 5_000)) as BrowserRuntimeStats;
      if (stopped) throw new Error("browser acquisition was interrupted by shutdown");
      hostLeaseRunId = current.runId;
      launches++;
      pages = stats.pages;
    } catch (error) {
      throw error;
    }
  }

  async function checkpointInHost(current: BrowserLease): Promise<BrowserCheckpoint> {
    await acquireInHost(current);
    return await rpc("checkpoint", { runId: current.runId }, settings.actionTimeoutMs + 2_000) as BrowserCheckpoint;
  }

  async function restoreInHost(current: BrowserLease, checkpoint: BrowserCheckpoint): Promise<void> {
    await rpc("restore", { runId: current.runId, checkpoint }, settings.navigationTimeoutMs + 5_000);
  }

  function trustedPng(source: string, current: BrowserLease): string {
    const existing = delivered.get(source);
    if (existing) return existing;
    const sourcePath = resolve(source);
    const artifactsDir = resolve(current.artifactsDir);
    if (!pathIsWithin(artifactsDir, sourcePath)) throw new Error("browser screenshot escaped the run artifacts directory");

    let fd: number | null = null;
    let deliveryTarget: string | null = null;
    try {
      fd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("browser screenshot is not a regular file");
      if (stat.size < PNG_SIGNATURE.length || stat.size > MAX_SCREENSHOT_BYTES) {
        throw new Error(`browser screenshot size ${stat.size} is outside the allowed range`);
      }
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      if (readSync(fd, signature, 0, signature.length, 0) !== signature.length || !signature.equals(PNG_SIGNATURE)) {
        throw new Error("browser screenshot is not a PNG");
      }

      const deliveryDir = join(dirname(artifactsDir), "deliveries");
      mkdirSync(deliveryDir, { recursive: true, mode: 0o700 });
      deliveryTarget = join(deliveryDir, `${basename(sourcePath, ".png")}-${randomUUID().slice(0, 8)}.png`);
      const output = openSync(deliveryTarget, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < stat.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (count <= 0) throw new Error("browser screenshot ended while copying");
          let written = 0;
          while (written < count) written += writeSync(output, buffer, written, count - written);
          offset += count;
        }
      } finally {
        closeSync(output);
      }
      delivered.set(source, deliveryTarget);
      return deliveryTarget;
    } catch (error) {
      if (deliveryTarget) {
        try {
          unlinkSync(deliveryTarget);
        } catch {
          // No trusted partial should survive a failed copy.
        }
      }
      throw error;
    } finally {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(sourcePath);
      } catch {
        // The trusted copy is authoritative; source cleanup is best effort.
      }
    }
  }

  function deliverEvaluation(result: BrowserEvalResult, current: BrowserLease): BrowserEvalResult {
    return { ...result, screenshots: result.screenshots.map((path) => trustedPng(path, current)) };
  }

  async function terminateLeaseHost(): Promise<void> {
    const target = child;
    if (!target) return;
    try {
      await rpc("stop", {}, Math.max(5_000, settings.actionTimeoutMs));
      const input = target.stdin;
      if (input && typeof input !== "number") input.end();
      await Promise.race([
        target.exited,
        Bun.sleep(2_000).then(() => {
          throw new Error("isolated browser host did not exit after stop");
        }),
      ]);
    } catch (error) {
      await killHost(target, error as Error);
    } finally {
      markHostExited(target, new Error("isolated browser host stopped"));
    }
  }

  return {
    async acquire(nextLease) {
      if (stopped) throw new Error("browser runtime is stopped");
      if (!nextLease.controlToken || nextLease.controlToken.length < 32) {
        throw new Error("browser lease requires a high-entropy control capability");
      }
      const occupying = lease;
      if (occupying && occupying.runId !== nextLease.runId) {
        throw new Error(`computer-use is busy with run ${occupying.runId}; retry after it finishes`);
      }
      if (occupying?.runId === nextLease.runId && hostLeaseRunId === nextLease.runId) return;
      if (!pathIsWithin(settings.artifactsRoot, resolve(nextLease.artifactsDir))) {
        throw new Error(`browser artifacts must stay below ${settings.artifactsRoot}`);
      }

      // Reserve before any await, closing the cold-start concurrency race.
      lease = { ...nextLease };
      delivered.clear();
      try {
        await acquireInHost(lease);
      } catch (error) {
        const target = child;
        if (target) await killHost(target, error as Error);
        if (lease?.runId === nextLease.runId) lease = null;
        throw error;
      }
    },

    async evaluate(runId, code, controlToken) {
      const current = requireLease(runId);
      requireControlToken(current, controlToken);
      if (!code.trim()) throw new Error("playwright_eval needs non-empty JavaScript");
      if (code.length > MAX_CODE_CHARS) throw new Error(`playwright_eval code exceeds ${MAX_CODE_CHARS} characters`);
      try {
        return await serializeEvaluation(async () => {
          if (stopped) throw new Error("browser runtime is stopped");
          await acquireInHost(current);
          const session = await rpc(
            "prepareEvaluation",
            { runId },
            settings.actionTimeoutMs + 2_000,
          ) as BrowserEvaluatorSession;
          const isolation = hostIsolation === "bubblewrap"
            ? "bubblewrap"
            : hostIsolation === "sandbox-exec"
              ? "sandbox-exec"
              : "none";
          const evaluated = await runBrowserEvaluator(
            {
              ...session,
              code,
              actionTimeoutMs: settings.actionTimeoutMs,
              navigationTimeoutMs: settings.navigationTimeoutMs,
              evalTimeoutMs: settings.evalTimeoutMs,
              maxOutputChars: settings.maxOutputChars,
            },
            {
              isolation,
              repoRoot,
              spawn,
              nodePath: deps.nodePath,
              bwrapPath: deps.bwrapPath,
              sandboxExecPath: deps.sandboxExecPath,
              prlimitPath: deps.prlimitPath,
              evaluatorPath: deps.evaluatorPath,
              parentEnv: process.env,
            },
          );
          if (!evaluated.ok && evaluated.recoverable !== true) {
            throw new Error(evaluated.error ?? "browser evaluator failed before producing recoverable state");
          }
          const result = await rpc(
            "applyEvaluation",
            { runId, evaluated: evaluated as BrowserEvaluatorOutput },
            settings.actionTimeoutMs * 3 + 5_000,
          ) as BrowserEvalResult;
          evaluations++;
          totalEvalMs += result.elapsedMs;
          pages = result.pages.length;
          if (!evaluated.ok) throw new Error(evaluated.error ?? "playwright_eval failed");
          return deliverEvaluation(result, current);
        });
      } catch (error) {
        throw markTimeoutUncertain(error);
      }
    },

    async capture(runId, name) {
      const current = requireLease(runId);
      await acquireInHost(current);
      const source = await rpc("capture", { runId, name }, settings.actionTimeoutMs + 5_000) as string;
      return trustedPng(source, current);
    },

    async checkpoint(runId) {
      return checkpointInHost(requireLease(runId));
    },

    async restore(runId, checkpoint) {
      const current = requireLease(runId);
      await acquireInHost(current);
      await restoreInHost(current, checkpoint);
    },

    async release(runId, captureProof) {
      const current = requireLease(runId);
      try {
        await evaluationQueue;
        if (!child || hostLeaseRunId !== runId) return [];
        const sources = await rpc(
          "release",
          { runId, captureProof },
          settings.navigationTimeoutMs + settings.actionTimeoutMs + 5_000,
        ) as string[];
        return sources.map((source) => trustedPng(source, current));
      } finally {
        await terminateLeaseHost();
        if (lease?.runId === runId) lease = null;
        hostLeaseRunId = null;
        pages = 0;
      }
    },

    hasLease(runId) {
      return lease?.runId === runId;
    },

    stats() {
      return {
        ready: child !== null && hostLeaseRunId !== null,
        profileDir: settings.profileDir,
        activeRunId: lease?.runId ?? null,
        pages,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      const inFlight = starting;
      if (inFlight) await inFlight.catch(() => undefined);
      await evaluationQueue.catch(() => undefined);
      await terminateLeaseHost();
      lease = null;
      hostLeaseRunId = null;
      pages = 0;
    },
  };
}

function pathIsWithin(root: string, target: string): boolean {
  const offset = relative(resolve(root), resolve(target));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function playwrightBrowserRoot(executable: string): string {
  let current = resolve(executable);
  while (dirname(current) !== current) {
    if (/^(chromium|chromium_headless_shell)-\d+$/.test(basename(current))) return dirname(current);
    current = dirname(current);
  }
  throw new Error(`could not locate Playwright browser bundle above ${executable}`);
}

function findExecutable(name: string, pathValue = process.env.PATH): string | undefined {
  for (const dir of (pathValue ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function addBrowserRuntimeMounts(args: string[], repoRoot: string, hostPath: string): void {
  args.push(
    "--dir",
    "/repo",
    "--dir",
    "/repo/node_modules",
    "--dir",
    "/repo/node_modules/.cache",
    "--dir",
    "/repo/node_modules/.cache/beckett-browser",
    "--ro-bind",
    hostPath,
    "/repo/node_modules/.cache/beckett-browser/host.mjs",
  );
  for (const packageName of ["playwright", "playwright-core"]) {
    args.push(
      "--ro-bind",
      join(repoRoot, "node_modules", packageName),
      join("/repo/node_modules", packageName),
    );
  }
}

function addLinuxSystemMounts(args: string[]): void {
  for (const path of ["/usr", "/sys", "/var/cache/fontconfig"]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
    else args.push("--ro-bind", path, path);
  }
  for (const path of [
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl",
    "/etc/fonts",
    "/etc/machine-id",
    "/etc/ld.so.cache",
  ]) {
    if (existsSync(path)) args.push("--ro-bind", realpathIfPossible(path), path);
  }
}

function macSandboxProfile(paths: {
  repoRoot: string;
  execPath: string;
  browserRoot: string;
  profileDir: string;
  artifactsRoot: string;
  hostTmp: string;
}): string {
  const read = [
    "/System",
    "/usr",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/dev",
    paths.repoRoot,
    paths.execPath,
    paths.browserRoot,
    paths.profileDir,
    paths.artifactsRoot,
    realpathIfPossible(paths.hostTmp),
  ];
  const write = [paths.profileDir, paths.artifactsRoot, realpathIfPossible(paths.hostTmp)];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix*)",
    "(allow file-read-metadata)",
    ...read.map((path) => `(allow file-read* (subpath ${sandboxQuote(path)}))`),
    ...write.map((path) => `(allow file-write* (subpath ${sandboxQuote(path)}))`),
    `(allow file-write* (literal ${sandboxQuote("/dev/null")}))`,
  ].join("\n");
}

function sandboxQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("sandbox paths cannot contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function markTimeoutUncertain(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  if (!/tim(?:eout|ed out)/i.test(message) || /outcome is uncertain/i.test(message)) return new Error(message);
  return new Error(
    `${message}; browser-side work may have continued, so the outcome is uncertain. Inspect current state before retrying any action`,
  );
}
