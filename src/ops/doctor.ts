/**
 * Beckett — `beckett doctor` (`src/ops/doctor.ts`)
 * =======================================================================================
 * The v3 health probe (issue #30): one command on the box that answers "would Beckett work
 * right now, and if not, what exactly is broken?". Rebuilt from the retired v2 `cmdDoctor`
 * skeleton for the ticket-queue world. Every check is a plain data row so the CLI can render
 * human output and `--json` from the same run, and tests can assert each detection.
 *
 * Design notes:
 *   - Binaries are probed with the DAEMON's PATH (the systemd unit's `Environment=PATH=...`),
 *     not the login shell's — this exact gap hid the node-18 pi crash for days.
 *   - Every probe is injectable ({@link DoctorDeps}) so the regression suite can assert the
 *     specific outages this issue was opened for: pi under node 18, a stale pi version, a
 *     leaked worker process on a done ticket, and missing env keys.
 *   - The doctor NEVER throws: a probe that blows up becomes a `fail` row, not a crash.
 */

import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import type { Config, Harness } from "../types.ts";
import { availableHarnesses, preflightFor, type PreflightResult } from "../drivers/index.ts";
import { buildPaths } from "../paths.ts";
import { callBus } from "../shell/control-bus.ts";
import { resolveGitHubAccount } from "../github/owner.ts";
import { boredBaseUrl } from "../bored/client.ts";

/** One health probe's outcome. `fail` rows flip the report's overall `ok` to false. */
export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * The PATH the daemon actually runs under — MUST mirror `Environment=PATH=` in
 * `deploy/systemd/beckett-v4.service`. Probing binaries with the login shell's PATH instead is
 * how "pi works when I ssh in" and "pi crashes under systemd" coexisted for days.
 */
export function daemonPath(home: string): string {
  return [join(home, ".local/bin"), join(home, ".bun/bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

/** A row from the process table, plus its cwd where the platform lets us read it (Linux). */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** Full command line, argv joined. */
  command: string;
  cwd: string | null;
}

/** Everything the doctor touches, injectable so tests can stage each outage. */
export interface DoctorDeps {
  config: Config;
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetchFn?: typeof fetch;
  /** Run argv with an explicit env; resolves (never rejects) with the exit code + output. */
  exec?: (argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  preflight?: (harness: Harness) => Promise<PreflightResult>;
  listProcesses?: () => Promise<ProcRow[]>;
  /** Read a file, or null when absent/unreadable. */
  readFile?: (path: string) => string | null;
  /** Ask the live daemon for its `status` over the control bus; null = no daemon answering. */
  busStatus?: () => Promise<Record<string, unknown> | null>;
  /** Free space at a path in KiB, or null when unknowable. */
  diskFreeKb?: (path: string) => Promise<number | null>;
  /** Verify the pinned Chromium artifact actually launches, not merely that its file exists. */
  browserProbe?: () => Promise<{ executable: string; launchable: boolean; error?: string }>;
}

// ── default (real) probe implementations ──────────────────────────────────────────────────

async function realExec(
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(argv, {
      env: { ...(opts.env ?? (process.env as Record<string, string>)) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 15_000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timeout);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
}

/** `ps` sweep for harness-looking processes; cwd via /proc on Linux (null elsewhere). */
async function realListProcesses(): Promise<ProcRow[]> {
  const { code, stdout } = await realExec(["ps", "axo", "pid=,ppid=,args="]);
  if (code !== 0) return [];
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* not Linux, or the process died / isn't ours */
    }
    rows.push({ pid, ppid: Number(m[2]), command: m[3]!.trim(), cwd });
  }
  return rows;
}

function realReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function realDiskFreeKb(path: string): Promise<number | null> {
  const { code, stdout } = await realExec(["df", "-Pk", path]);
  if (code !== 0) return null;
  const cols = stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const avail = Number(cols?.[3]);
  return Number.isFinite(avail) ? avail : null;
}

async function realBrowserProbe(): Promise<{ executable: string; launchable: boolean; error?: string }> {
  try {
    const { chromium } = await import("playwright");
    const executable = chromium.executablePath();
    if (!existsSync(executable)) return { executable, launchable: false, error: "browser binary is missing" };
    const browser = await chromium.launch({ headless: true, channel: "chromium", timeout: 15_000 });
    await browser.close();
    return { executable, launchable: true };
  } catch (error) {
    return { executable: "unknown", launchable: false, error: (error as Error).message };
  }
}

// ── .env / .env.example parsing ────────────────────────────────────────────────────────────

/** Keys declared in a dotenv-shaped body; a same-line `# optional` marks the key optional. */
export function parseEnvInventory(body: string): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (!m) continue;
    (/#\s*optional/i.test(line) ? optional : required).push(m[1]!);
  }
  return { required, optional };
}

function envKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

// ── the doctor ─────────────────────────────────────────────────────────────────────────────

/** Registry-driven so a newly-registered driver's stray processes are recognized without an edit. */
const KNOWN_HARNESSES: Harness[] = availableHarnesses();

/** Compare the numeric core of semver-shaped CLI output (for example, `v22.19.0`). */
function semverGte(raw: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/v?(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const current = parse(raw);
  const wanted = parse(minimum);
  if (!current || !wanted) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > wanted[index]!) return true;
    if (current[index]! < wanted[index]!) return false;
  }
  return true;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const config = deps.config;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const exec = deps.exec ?? realExec;
  const preflight = deps.preflight ?? ((h: Harness) => preflightFor(h, config, { force: true }));
  const listProcesses = deps.listProcesses ?? realListProcesses;
  const readFile = deps.readFile ?? realReadFile;
  const diskFreeKb = deps.diskFreeKb ?? realDiskFreeKb;
  const browserProbe = deps.browserProbe ?? realBrowserProbe;
  const paths = buildPaths(config);
  const busStatus =
    deps.busStatus ??
    (async () => {
      const res = await callBus(join(paths.beckettDir, "control.sock"), "status", {}, 3_000).catch(() => null);
      return res?.ok ? ((res.data ?? {}) as Record<string, unknown>) : null;
    });

  const checks: DoctorCheck[] = [];
  const path = daemonPath(home);
  const binEnv = { PATH: path, HOME: home };

  // 1. Binaries + versions, resolved exactly as systemd resolves them.
  const harnessCfg = config.harness as unknown as Record<string, { bin?: string } | undefined>;
  const binaries: Array<{ bin: string; required: boolean; minVersion?: string; why?: string }> = [
    { bin: "bun", required: true },
    ...(platform === "linux" ? [{ bin: "bwrap", required: true }] : []),
    ...(platform === "linux" ? [{ bin: "prlimit", required: true }] : []),
    {
      bin: "node",
      required: true,
      ...(config.harness.pi.enabled
        ? {
            minVersion: "22.19.0",
            why: "the current Pi package requires node >= 22.19.0",
          }
        : {}),
    },
    { bin: harnessCfg.claude?.bin || "claude", required: true },
    ...(config.harness.codex.enabled
      ? [{ bin: harnessCfg.codex?.bin || "codex", required: true }]
      : []),
    ...(config.harness.pi.enabled
      ? [{ bin: harnessCfg.pi?.bin || "pi", required: true }]
      : []),
    { bin: "gh", required: false },
    { bin: "cloudflared", required: false },
  ];
  for (const b of binaries) {
    const r = await exec([b.bin, "--version"], { env: binEnv, timeoutMs: 15_000 });
    const version = r.stdout.trim().split("\n")[0] || r.stderr.trim().split("\n")[0] || "";
    if (r.code !== 0) {
      checks.push({
        name: `binary: ${b.bin}`,
        level: b.required ? "fail" : "warn",
        detail: `not runnable on the daemon PATH (${path})`,
      });
      continue;
    }
    if (b.minVersion !== undefined) {
      if (!semverGte(version, b.minVersion)) {
        checks.push({
          name: `binary: ${b.bin}`,
          level: "fail",
          detail: `${version || "unknown version"} on the daemon PATH but ${b.bin} >= ${b.minVersion} is required - ${b.why}`,
        });
        continue;
      }
    }
    checks.push({ name: `binary: ${b.bin}`, level: "ok", detail: version });
  }
  if (platform === "linux") {
    const sandbox = await exec(
      ["bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--ro-bind", "/", "/", "/bin/true"],
      { env: binEnv, timeoutMs: 15_000 },
    );
    checks.push(sandbox.code === 0
      ? { name: "browser: process sandbox", level: "ok", detail: "bubblewrap user namespace works" }
      : {
          name: "browser: process sandbox",
          level: "fail",
          detail: `bubblewrap cannot create the browser sandbox: ${(sandbox.stderr || sandbox.stdout).trim() || `exit ${sandbox.code}`}`,
        });
  }
  // The package, browser download, and Linux shared libraries are separate artifacts. Launching a
  // real process catches all three before the first computer-use request does.
  try {
    const probe = await browserProbe();
    checks.push(probe.launchable
      ? { name: "browser: chromium", level: "ok", detail: probe.executable }
      : {
          name: "browser: chromium",
          level: "fail",
          detail: `${probe.error ?? "launch failed"} - run bun x playwright install --no-shell chromium and, on Linux, sudo bun x playwright install-deps chromium`,
        });
  } catch (err) {
    checks.push({ name: "browser: chromium", level: "fail", detail: `Playwright unavailable: ${(err as Error).message}` });
  }

  // 2. Harness preflights (issue #17's checks, forced fresh): auth artifact, version minimum,
  // flags. Disabled optional harnesses are intentionally absent rather than permanently yellow.
  const activeHarnesses: Harness[] = [
    "claude",
    ...(config.harness.pi.enabled ? (["pi"] as Harness[]) : []),
    ...(config.harness.codex.enabled ? (["codex"] as Harness[]) : []),
  ];
  for (const h of activeHarnesses) {
    try {
      const r = await preflight(h);
      checks.push(
        r.ok
          ? { name: `preflight: ${h}`, level: "ok", detail: "usable" }
          : { name: `preflight: ${h}`, level: "fail", detail: r.problems.join("; ") },
      );
    } catch (err) {
      checks.push({ name: `preflight: ${h}`, level: "fail", detail: `preflight crashed: ${(err as Error).message}` });
    }
  }

  // 3. Tracker reachability — bored is a loopback service with no credential; /health is the probe.
  const boredRoot = boredBaseUrl(env);
  try {
    const res = await fetchFn(`${boredRoot}/health`, { signal: AbortSignal.timeout(10_000) });
    checks.push(
      res.ok
        ? { name: "tracker: bored", level: "ok", detail: `HTTP ${res.status} at ${boredRoot}` }
        : { name: "tracker: bored", level: "fail", detail: `HTTP ${res.status} from ${boredRoot}/health` },
    );
  } catch (err) {
    checks.push({ name: "tracker: bored", level: "fail", detail: `unreachable at ${boredRoot}: ${(err as Error).message}` });
  }

  // 3b. Live token probes — the only honest answer to "is this credential still good?".
  const probes: Array<{ name: string; key: string; required: boolean; url: (v: string) => string; headers: (v: string) => Record<string, string>; missingDetail?: string }> = [
    {
      name: "token: discord",
      key: "DISCORD_TOKEN",
      required: true,
      url: () => "https://discord.com/api/v10/users/@me",
      headers: (v) => ({ Authorization: `Bot ${v}` }),
    },
    {
      name: "token: github",
      key: "GITHUB_PAT",
      required: true,
      url: () => "https://api.github.com/user",
      headers: (v) => ({ Authorization: `Bearer ${v}`, "User-Agent": "beckett-doctor" }),
    },
    {
      name: "token: cloudflare",
      key: "CLOUDFLARE_API_TOKEN",
      required: false,
      url: () => "https://api.cloudflare.com/client/v4/user/tokens/verify",
      headers: (v) => ({ Authorization: `Bearer ${v}` }),
    },
    {
      // A GET on a Discord webhook URL returns its metadata without posting — a free validity probe.
      name: "token: alert webhook",
      key: "DISCORD_ALERT_WEBHOOK_URL",
      required: false,
      url: (v) => v,
      headers: () => ({}),
      missingDetail: "crash alerts are OFF — set DISCORD_ALERT_WEBHOOK_URL in ~/.beckett/.env",
    },
  ];
  for (const p of probes) {
    const value = env[p.key]?.trim();
    if (!value) {
      checks.push({
        name: p.name,
        level: p.required ? "fail" : "warn",
        detail: p.missingDetail ?? `${p.key} is not set`,
      });
      continue;
    }
    try {
      const res = await fetchFn(p.url(value), { headers: p.headers(value), signal: AbortSignal.timeout(10_000) });
      if (res.ok && p.name === "token: github") {
        const body = await res.json().catch(() => null) as { login?: unknown } | null;
        const login = typeof body?.login === "string" ? body.login.trim() : "";
        const expected = resolveGitHubAccount(config, env);
        if (!login) {
          checks.push({ name: p.name, level: "fail", detail: `HTTP ${res.status} but GitHub returned no account login` });
        } else if (login.toLowerCase() !== expected.toLowerCase()) {
          checks.push({
            name: p.name,
            level: "fail",
            detail: `PAT belongs to ${login}, but the configured authenticated account is ${expected}`,
          });
        } else {
          checks.push({ name: p.name, level: "ok", detail: `HTTP ${res.status} as ${login}` });
        }
        continue;
      }
      checks.push(
        res.ok
          ? { name: p.name, level: "ok", detail: `HTTP ${res.status}` }
          : { name: p.name, level: "fail", detail: `HTTP ${res.status} — the credential is present but rejected` },
      );
    } catch (err) {
      checks.push({ name: p.name, level: "fail", detail: `probe failed: ${(err as Error).message}` });
    }
  }

  // 4. Env completeness: the committed `.env.example` is the key inventory; drift is a finding.
  const examplePath = join(import.meta.dir, "..", "..", ".env.example");
  const example = readFile(examplePath);
  const envBody = readFile(join(paths.beckettDir, ".env"));
  if (!example) {
    checks.push({ name: "env: inventory", level: "skip", detail: `.env.example not found at ${examplePath}` });
  } else if (envBody === null) {
    checks.push({ name: "env: inventory", level: "fail", detail: `no ${join(paths.beckettDir, ".env")} — every secret is missing` });
  } else {
    const inv = parseEnvInventory(example);
    const present = envKeys(envBody);
    const missingReq = inv.required.filter((k) => !present.has(k));
    const missingOpt = inv.optional.filter((k) => !present.has(k));
    const undocumented = [...present].filter((k) => !inv.required.includes(k) && !inv.optional.includes(k));
    if (missingReq.length > 0) {
      checks.push({ name: "env: required keys", level: "fail", detail: `missing: ${missingReq.join(", ")}` });
    } else {
      checks.push({ name: "env: required keys", level: "ok", detail: `all ${inv.required.length} present` });
    }
    if (missingOpt.length > 0) {
      // Informational, not a warn: optional means optional — a permanently-yellow line here
      // would train people to ignore the warns that matter.
      checks.push({ name: "env: optional keys", level: "skip", detail: `${missingOpt.length} not set (optional): ${missingOpt.join(", ")}` });
    }
    if (undocumented.length > 0) {
      checks.push({ name: "env: undocumented keys", level: "warn", detail: `in .env but not .env.example: ${undocumented.join(", ")} — document or remove` });
    }
  }

  // 5. Process hygiene: harness processes systemd/the dispatcher don't know about are leaks.
  try {
    const projectsRoot = env.BECKETT_PROJECTS_ROOT?.trim() || join(home, "Projects");
    const ledgerRaw = readFile(join(paths.beckettDir, "dispatcher-state.json"));
    const ledgerPids = new Set<number>();
    if (ledgerRaw) {
      try {
        const parsed = JSON.parse(ledgerRaw) as { liveWorkers?: Record<string, { pid?: number }> };
        for (const w of Object.values(parsed.liveWorkers ?? {})) {
          if (typeof w.pid === "number" && w.pid > 0) ledgerPids.add(w.pid);
        }
      } catch {
        /* unreadable ledger → treat as empty */
      }
    }
    const harnessBins = new Set(
      KNOWN_HARNESSES.map((h) => basename(harnessCfg[h]?.bin || h)),
    );
    const looksLikeHarness = (command: string): boolean => {
      const argv = command.split(/\s+/);
      // Direct (`claude -p ...`) or interpreter-wrapped (`node /path/to/pi ...`) invocations.
      return harnessBins.has(basename(argv[0] ?? "")) || (argv[1] !== undefined && harnessBins.has(basename(argv[1])));
    };
    const strays: string[] = [];
    let orphaned = 0;
    for (const proc of await listProcesses()) {
      if (!looksLikeHarness(proc.command)) continue;
      const inProjects = proc.cwd !== null && proc.cwd.startsWith(projectsRoot);
      if (proc.ppid === 1 && inProjects) {
        orphaned += 1;
        strays.push(`pid ${proc.pid} ORPHANED (ppid=1, cwd ${proc.cwd})`);
      } else if (inProjects && !ledgerPids.has(proc.pid)) {
        strays.push(`pid ${proc.pid} not in the dispatcher ledger (cwd ${proc.cwd})`);
      }
    }
    if (strays.length > 0) {
      checks.push({
        name: "processes: harness leaks",
        level: orphaned > 0 ? "fail" : "warn",
        detail: strays.join("; "),
      });
    } else {
      checks.push({ name: "processes: harness leaks", level: "ok", detail: "no stray harness processes" });
    }
  } catch (err) {
    checks.push({ name: "processes: harness leaks", level: "warn", detail: `sweep failed: ${(err as Error).message}` });
  }

  // 6. Is the daemon itself alive and answering?
  try {
    const status = await busStatus();
    if (status) {
      const version = typeof status.version === "string" ? status.version : "?";
      const uptime = typeof status.uptimeSecs === "number" ? `${status.uptimeSecs}s` : "?";
      checks.push({ name: "daemon: control.sock", level: "ok", detail: `answering (v${version}, up ${uptime})` });
    } else {
      checks.push({
        name: "daemon: control.sock",
        level: "fail",
        detail: "not answering — is beckett-v4.service running?",
      });
    }
  } catch (err) {
    checks.push({ name: "daemon: control.sock", level: "fail", detail: (err as Error).message });
  }

  // 7. cloudflared ingress config (the tunnels behind *.0xbeckett.me).
  const cfConfig = join(home, ".cloudflared", "config.yml");
  if (readFile(cfConfig) === null) {
    checks.push({ name: "cloudflared: ingress", level: "skip", detail: `no ${cfConfig}` });
  } else {
    const r = await exec(["cloudflared", "tunnel", "ingress", "validate"], { env: binEnv, timeoutMs: 15_000 });
    checks.push(
      r.code === 0
        ? { name: "cloudflared: ingress", level: "ok", detail: "config.yml validates" }
        : { name: "cloudflared: ingress", level: "fail", detail: (r.stderr || r.stdout).trim().split("\n")[0] ?? "validation failed" },
    );
  }

  // 8. Disk space where all the state lives.
  const freeKb = await diskFreeKb(existsSync(paths.beckettDir) ? paths.beckettDir : home);
  if (freeKb === null) {
    checks.push({ name: "disk: ~/.beckett", level: "skip", detail: "df unavailable" });
  } else {
    const gb = freeKb / 1024 / 1024;
    const detail = `${gb.toFixed(1)} GB free`;
    checks.push({
      name: "disk: ~/.beckett",
      level: gb < 1 ? "fail" : gb < 5 ? "warn" : "ok",
      detail,
    });
  }

  return { ok: !checks.some((c) => c.level === "fail"), checks };
}

/** Render a report the way a human over ssh wants it: one aligned line per check. */
export function renderReport(report: DoctorReport): string {
  const icon: Record<DoctorCheck["level"], string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => `${icon[c.level]} ${c.name.padEnd(width)}  ${c.detail}`);
  lines.push("", report.ok ? "healthy — no failing checks" : "UNHEALTHY — fix the ✗ lines above");
  return lines.join("\n");
}
