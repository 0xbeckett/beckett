/**
 * Daemon-side launcher for disposable model-code evaluators.
 *
 * The persistent Chromium controller never executes model JavaScript. Each call connects to its
 * loopback CDP endpoint from a fresh process, and production Linux wraps that process in a separate
 * bubblewrap namespace with no profile, artifact, or Beckett-state mounts.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSubprocess, type SpawnedProcess, type SpawnProcess } from "./subprocess.ts";

const MAX_EVALUATOR_MESSAGE_CHARS = 1_000_000;
const MAX_EVALUATOR_STDERR_CHARS = 16_000;

export interface BrowserEvaluatorSession {
  endpoint: string;
  origin: string;
  state: Record<string, unknown>;
  activeIndex: number;
  activeTargetId?: string;
}

export interface BrowserEvaluatorRequest extends BrowserEvaluatorSession {
  code: string;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  evalTimeoutMs: number;
  maxOutputChars: number;
}

export interface BrowserEvaluatorOutput {
  ok: boolean;
  recoverable?: boolean;
  error?: string;
  value?: unknown;
  console?: string[];
  state?: Record<string, unknown>;
  activeIndex?: number;
  activeTargetId?: string;
  screenshotRequests?: { name: string; pageIndex: number; targetId?: string }[];
  elapsedMs?: number;
  truncated?: boolean;
}

export interface RunBrowserEvaluatorOptions {
  isolation: "none" | "bubblewrap" | "sandbox-exec";
  repoRoot: string;
  spawn?: SpawnProcess;
  nodePath?: string;
  bwrapPath?: string;
  sandboxExecPath?: string;
  prlimitPath?: string;
  evaluatorPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
}

export interface BrowserEvaluatorLaunch {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  isolation: "process" | "bubblewrap" | "sandbox-exec";
}

export function buildBrowserEvaluatorLaunch(
  request: Pick<BrowserEvaluatorRequest, "evalTimeoutMs">,
  options: RunBrowserEvaluatorOptions,
): BrowserEvaluatorLaunch {
  const repoRoot = resolve(options.repoRoot);
  const evaluatorPath = realpathIfPossible(options.evaluatorPath ?? join(repoRoot, "src/browser/evaluator.cjs"));
  const nodePath = realpathIfPossible(options.nodePath ?? findExecutable("node", options.parentEnv?.PATH) ?? "");
  if (!nodePath || !existsSync(nodePath)) throw new Error("browser evaluator requires Node.js");

  if (options.isolation === "none") {
    return {
      command: [nodePath, "--max-old-space-size=256", evaluatorPath],
      cwd: repoRoot,
      env: { PATH: dirname(nodePath), HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" },
      isolation: "process",
    };
  }

  if (options.isolation === "sandbox-exec") {
    const sandboxExecPath = options.sandboxExecPath
      ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : undefined);
    if (!sandboxExecPath) throw new Error("secure browser evaluator requires sandbox-exec on macOS");
    const playwrightPath = realpathIfPossible(join(repoRoot, "node_modules/playwright"));
    const playwrightCorePath = realpathIfPossible(join(repoRoot, "node_modules/playwright-core"));
    for (const path of [evaluatorPath, playwrightPath, playwrightCorePath]) {
      if (!existsSync(path)) throw new Error(`browser evaluator runtime is missing: ${path}`);
    }
    const profile = macEvaluatorSandboxProfile({ nodePath, evaluatorPath, playwrightPath, playwrightCorePath });
    return {
      command: [
        sandboxExecPath,
        "-p",
        profile,
        nodePath,
        "--max-old-space-size=256",
        evaluatorPath,
      ],
      cwd: repoRoot,
      env: { PATH: dirname(nodePath), HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" },
      isolation: "sandbox-exec",
    };
  }

  const bwrapPath = options.bwrapPath ?? findExecutable("bwrap", options.parentEnv?.PATH);
  if (!bwrapPath) throw new Error("secure browser evaluator requires bubblewrap (bwrap) in PATH");
  const prlimitPath = realpathIfPossible(
    options.prlimitPath ?? findExecutable("prlimit", options.parentEnv?.PATH) ?? "",
  );
  if (!prlimitPath || !existsSync(prlimitPath)) {
    throw new Error("secure browser evaluator requires prlimit (util-linux) in PATH");
  }

  const playwrightPath = realpathIfPossible(join(repoRoot, "node_modules/playwright"));
  const playwrightCorePath = realpathIfPossible(join(repoRoot, "node_modules/playwright-core"));
  for (const path of [evaluatorPath, playwrightPath, playwrightCorePath]) {
    if (!existsSync(path)) throw new Error(`browser evaluator runtime is missing: ${path}`);
  }

  const command = [
    bwrapPath,
    "--unshare-all",
    // Playwright's CDP client needs the controller's loopback endpoint. This is a filesystem and
    // process boundary, not a network boundary; production should run on a dedicated host.
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "PATH",
    "/runtime",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  addEvaluatorSystemMounts(command);
  command.push(
    "--dir",
    "/runtime",
    "--ro-bind",
    nodePath,
    "/runtime/node",
    "--ro-bind",
    prlimitPath,
    "/runtime/prlimit",
    "--dir",
    "/repo",
    "--dir",
    "/repo/src",
    "--dir",
    "/repo/src/browser",
    "--dir",
    "/repo/node_modules",
    "--ro-bind",
    evaluatorPath,
    "/repo/src/browser/evaluator.cjs",
    "--ro-bind",
    playwrightPath,
    "/repo/node_modules/playwright",
    "--ro-bind",
    playwrightCorePath,
    "/repo/node_modules/playwright-core",
    "--dir",
    "/tmp/home",
    "--chdir",
    "/repo",
    "--",
    "/runtime/prlimit",
    // V8 reserves a large virtual code range; the 256 MiB old-space flag below bounds JS heap.
    "--as=2147483648",
    "--nproc=256",
    "--fsize=33554432",
    `--cpu=${Math.max(2, Math.ceil(request.evalTimeoutMs / 1_000) + 2)}`,
    "--",
    "/runtime/node",
    "--max-old-space-size=256",
    "/repo/src/browser/evaluator.cjs",
  );
  return {
    command,
    cwd: repoRoot,
    env: { PATH: options.parentEnv?.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    isolation: "bubblewrap",
  };
}

export async function runBrowserEvaluator(
  request: BrowserEvaluatorRequest,
  options: RunBrowserEvaluatorOptions,
): Promise<BrowserEvaluatorOutput> {
  const payload = JSON.stringify(request);
  if (payload.length > MAX_EVALUATOR_MESSAGE_CHARS) throw new Error("browser evaluator input exceeded size limit");

  const launch = buildBrowserEvaluatorLaunch(request, options);
  const spawn = options.spawn ?? spawnSubprocess;
  const child = spawn({
    cmd: launch.command,
    cwd: launch.cwd,
    env: launch.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const input = child.stdin;
  if (!input || typeof input === "number") {
    killChildGroup(child);
    await child.exited.catch(() => undefined);
    throw new Error("browser evaluator stdin is unavailable");
  }
  input.write(payload);
  input.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killChildGroup(child);
  }, request.evalTimeoutMs + 750);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, MAX_EVALUATOR_MESSAGE_CHARS),
      readBounded(child.stderr, MAX_EVALUATOR_STDERR_CHARS),
      child.exited,
    ]);
    if (timedOut) {
      throw new Error(
        `playwright_eval timed out after ${request.evalTimeoutMs}ms; browser-side work may have continued, so the outcome is uncertain. Inspect current state before retrying any action`,
      );
    }
    let response: BrowserEvaluatorOutput;
    try {
      response = JSON.parse(stdout.trim()) as BrowserEvaluatorOutput;
    } catch {
      throw new Error(`browser evaluator returned invalid output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
    if (typeof response.ok !== "boolean") throw new Error("browser evaluator returned an invalid response envelope");
    if (response.ok && exitCode !== 0) {
      throw new Error(stderr.trim() || `browser evaluator exited with code ${exitCode}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      killChildGroup(child);
      await child.exited.catch(() => undefined);
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxChars: number,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) throw new Error("browser evaluator output exceeded size limit");
  }
  return text + decoder.decode();
}

function killChildGroup(child: SpawnedProcess): void {
  try {
    if (child.pid > 0) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

function addEvaluatorSystemMounts(args: string[]): void {
  for (const path of [
    "/usr/lib",
    "/usr/lib64",
    "/usr/share/ca-certificates",
    // Debian/Ubuntu externalize a few Node builtins here (for example cjs-module-lexer).
    "/usr/share/nodejs",
  ]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const path of ["/lib", "/lib64"]) {
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
    "/etc/ssl/certs",
    "/etc/ssl/openssl.cnf",
    "/etc/ld.so.cache",
  ]) {
    if (existsSync(path)) args.push("--ro-bind", realpathIfPossible(path), path);
  }
}

function findExecutable(name: string, pathValue = process.env.PATH): string | undefined {
  for (const dir of (pathValue ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function realpathIfPossible(path: string): string {
  if (!path) return "";
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function macEvaluatorSandboxProfile(paths: {
  nodePath: string;
  evaluatorPath: string;
  playwrightPath: string;
  playwrightCorePath: string;
}): string {
  const readable = [
    "/System",
    "/usr/lib",
    "/Library",
    "/private/etc",
    "/dev",
    paths.nodePath,
    paths.evaluatorPath,
    paths.playwrightPath,
    paths.playwrightCorePath,
  ];
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
    ...readable.map((path) => `(allow file-read* (subpath ${sandboxQuote(path)}))`),
    `(allow file-write* (subpath ${sandboxQuote("/private/tmp")}))`,
    `(allow file-write* (literal ${sandboxQuote("/dev/null")}))`,
  ].join("\n");
}

function sandboxQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("sandbox paths cannot contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
