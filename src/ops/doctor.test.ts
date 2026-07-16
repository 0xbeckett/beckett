/**
 * `beckett doctor` regression checklist (issue #30): the doctor must detect each of the real
 * outages that motivated it - Pi running under an unsupported Node, a stale Pi version, a leaked worker
 * process on a done ticket, and missing env keys — plus report healthy when everything is.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { runDoctor, parseEnvInventory, daemonPath, type DoctorDeps, type DoctorCheck } from "./doctor.ts";

const HOME = "/home/beckett";

/** Baseline deps where EVERYTHING is healthy; tests break one thing at a time. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const versions: Record<string, string> = {
    bun: "1.3.13",
    node: "v24.4.1",
    claude: "2.1.0 (Claude Code)",
    codex: "codex-cli 0.99.0",
    pi: "0.80.2",
    gh: "gh version 2.62.0",
    cloudflared: "cloudflared version 2025.5.0",
    bwrap: "bubblewrap 0.11.0",
    prlimit: "prlimit from util-linux 2.40",
  };
  return {
    config: defaultConfig(),
    home: HOME,
    platform: "linux",
    env: {
      DISCORD_TOKEN: "t",
      GITHUB_PAT: "t",
      CLOUDFLARE_API_TOKEN: "t",
      DISCORD_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x",
    },
    exec: async (argv) => {
      const bin = argv[0]!;
      if (argv[1] === "--version" && versions[bin]) return { code: 0, stdout: versions[bin], stderr: "" };
      if (bin === "bwrap") return { code: 0, stdout: "", stderr: "" };
      if (bin === "cloudflared") return { code: 0, stdout: "OK", stderr: "" };
      return { code: 127, stdout: "", stderr: "not found" };
    },
    preflight: async () => ({ ok: true, problems: [] }),
    fetchFn: (async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? Response.json({ login: "0xbeckett" })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch,
    listProcesses: async () => [],
    readFile: (path: string) => {
      if (path.endsWith(".env.example")) {
        return "DISCORD_TOKEN=\nGITHUB_PAT=\nDISCORD_ALERT_WEBHOOK_URL= # optional\n";
      }
      if (path.endsWith("/.env")) {
        return "DISCORD_TOKEN=x\nGITHUB_PAT=x\nDISCORD_ALERT_WEBHOOK_URL=x\n";
      }
      if (path.endsWith("dispatcher-state.json")) return JSON.stringify({ liveWorkers: {} });
      if (path.endsWith("config.yml")) return "tunnel: abc\n";
      return null;
    },
    busStatus: async () => ({ version: "3.5.0", uptimeSecs: 42 }),
    diskFreeKb: async () => 50 * 1024 * 1024, // 50 GB
    browserProbe: async () => ({ executable: "/home/beckett/.cache/ms-playwright/chromium/chrome", launchable: true }),
    ...overrides,
  };
}

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}" in: ${checks.map((c) => c.name).join(", ")}`);
  return found;
}

describe("doctor — healthy box", () => {
  test("all green → report.ok", async () => {
    const report = await runDoctor(healthyDeps());
    expect(report.checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(report.ok).toBeTrue();
    expect(byName(report.checks, "daemon: control.sock").detail).toContain("v3.5.0");
  });
});

describe("doctor — the issue-#30 regression checklist", () => {
  test("an installed Chromium that cannot launch is a FAIL", async () => {
    const report = await runDoctor(healthyDeps({
      browserProbe: async () => ({
        executable: "/home/beckett/.cache/ms-playwright/chromium/chrome",
        launchable: false,
        error: "libnss3.so: cannot open shared object file",
      }),
    }));
    const browser = byName(report.checks, "browser: chromium");
    expect(browser.level).toBe("fail");
    expect(browser.detail).toContain("libnss3.so");
  });

  test("a Linux host that blocks bubblewrap user namespaces is a FAIL", async () => {
    const base = healthyDeps();
    const report = await runDoctor(healthyDeps({
      exec: async (argv, opts) =>
        argv[0] === "bwrap" && argv[1] === "--unshare-all"
          ? { code: 1, stdout: "", stderr: "No permissions to create new namespace" }
          : base.exec!(argv, opts),
    }));
    const sandbox = byName(report.checks, "browser: process sandbox");
    expect(sandbox.level).toBe("fail");
    expect(sandbox.detail).toContain("No permissions");
  });

  test("node below Pi's 22.19 floor on the daemon PATH is a FAIL", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        exec: async (argv, opts) => {
          if (argv[0] === "node") return { code: 0, stdout: "v22.18.0", stderr: "" };
          return base.exec!(argv, opts);
        },
      }),
    );
    const node = byName(report.checks, "binary: node");
    expect(node.level).toBe("fail");
    expect(node.detail).toContain("v22.18.0");
    expect(node.detail).toContain("22.19.0");
    expect(report.ok).toBeFalse();
  });

  test("disabled Pi does not impose its Node 22.19 floor", async () => {
    const config = defaultConfig();
    config.harness.pi.enabled = false;
    const base = healthyDeps({ config });
    const report = await runDoctor(
      healthyDeps({
        config,
        exec: async (argv, opts) =>
          argv[0] === "node"
            ? { code: 0, stdout: "v20.18.0", stderr: "" }
            : base.exec!(argv, opts),
      }),
    );

    expect(byName(report.checks, "binary: node")).toEqual({
      name: "binary: node",
      level: "ok",
      detail: "v20.18.0",
    });
  });

  test("disabled optional harnesses are not probed or reported missing", async () => {
    const config = defaultConfig();
    config.harness.pi.enabled = false;
    config.harness.codex.enabled = false;
    const probed: string[] = [];
    const base = healthyDeps({ config });
    const report = await runDoctor(
      healthyDeps({
        config,
        exec: async (argv, opts) => {
          if (argv[0] === "pi" || argv[0] === "codex") return { code: 127, stdout: "", stderr: "not found" };
          return base.exec!(argv, opts);
        },
        preflight: async (harness) => {
          probed.push(harness);
          return { ok: true, problems: [] };
        },
      }),
    );
    expect(probed).toEqual(["claude"]);
    expect(report.checks.some((check) => check.name === "binary: pi")).toBeFalse();
    expect(report.checks.some((check) => check.name === "binary: codex")).toBeFalse();
  });

  test("an enabled Codex harness is required and preflighted", async () => {
    const config = defaultConfig();
    config.harness.codex.enabled = true;
    const base = healthyDeps({ config });
    const report = await runDoctor(
      healthyDeps({
        config,
        exec: async (argv, opts) =>
          argv[0] === "codex"
            ? { code: 127, stdout: "", stderr: "not found" }
            : base.exec!(argv, opts),
      }),
    );
    expect(byName(report.checks, "binary: codex").level).toBe("fail");
    expect(byName(report.checks, "preflight: codex").level).toBe("ok");
  });

  test("a stale pi (0.72.1 < 0.78) surfaces as a preflight FAIL", async () => {
    const report = await runDoctor(
      healthyDeps({
        preflight: async (h) =>
          h === "pi" ? { ok: false, problems: ["pi 0.72.1 is older than the 0.78 minimum"] } : { ok: true, problems: [] },
      }),
    );
    const pi = byName(report.checks, "preflight: pi");
    expect(pi.level).toBe("fail");
    expect(pi.detail).toContain("0.72.1");
    expect(report.ok).toBeFalse();
  });

  test("a leaked worker process (orphaned in ~/Projects) is a FAIL", async () => {
    const report = await runDoctor(
      healthyDeps({
        listProcesses: async () => [
          // The OPS-56 shape: a pi worker whose parent (the daemon) died, reparented to init,
          // still chewing away inside a project checkout.
          { pid: 4242, ppid: 1, command: "pi -p --session s1", cwd: `${HOME}/Projects/balloons` },
        ],
      }),
    );
    const procs = byName(report.checks, "processes: harness leaks");
    expect(procs.level).toBe("fail");
    expect(procs.detail).toContain("4242");
    expect(procs.detail).toContain("ORPHANED");
    expect(report.ok).toBeFalse();
  });

  test("a live harness process missing from the dispatcher ledger is a WARN", async () => {
    const report = await runDoctor(
      healthyDeps({
        listProcesses: async () => [
          { pid: 5151, ppid: 900, command: "pi -p --mode json", cwd: `${HOME}/Projects/widgets` },
        ],
      }),
    );
    const procs = byName(report.checks, "processes: harness leaks");
    expect(procs.level).toBe("warn");
    expect(procs.detail).toContain("5151");
    expect(procs.detail).toContain("ledger");
  });

  test("a disabled harness process is still reported as a leak", async () => {
    const config = defaultConfig();
    config.harness.codex.enabled = false;
    const report = await runDoctor(
      healthyDeps({
        config,
        listProcesses: async () => [
          { pid: 5252, ppid: 900, command: "codex exec --json", cwd: `${HOME}/Projects/widgets` },
        ],
      }),
    );
    const procs = byName(report.checks, "processes: harness leaks");
    expect(procs.level).toBe("warn");
    expect(procs.detail).toContain("5252");
    expect(procs.detail).toContain("ledger");
  });

  test("ledgered worker processes are NOT flagged", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        listProcesses: async () => [
          { pid: 6161, ppid: 900, command: "claude -p --output-format stream-json", cwd: `${HOME}/Projects/widgets` },
        ],
        readFile: (path: string) => {
          if (path.endsWith("dispatcher-state.json")) {
            return JSON.stringify({ liveWorkers: { "tkt-1": { pid: 6161 } } });
          }
          return base.readFile!(path);
        },
      }),
    );
    expect(byName(report.checks, "processes: harness leaks").level).toBe("ok");
  });

  test("a missing required env key is a FAIL that names the key", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        readFile: (path: string) => {
          if (path.endsWith("/.env")) return "DISCORD_TOKEN=x\n"; // no GITHUB_PAT
          return base.readFile!(path);
        },
      }),
    );
    const env = byName(report.checks, "env: required keys");
    expect(env.level).toBe("fail");
    expect(env.detail).toContain("GITHUB_PAT");
    expect(report.ok).toBeFalse();
  });

  test("an undocumented key in .env is a WARN (inventory drift)", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        readFile: (path: string) => {
          if (path.endsWith("/.env")) {
            return "DISCORD_TOKEN=x\nGITHUB_PAT=x\nMYSTERY_KEY=x\n";
          }
          return base.readFile!(path);
        },
      }),
    );
    const drift = byName(report.checks, "env: undocumented keys");
    expect(drift.level).toBe("warn");
    expect(drift.detail).toContain("MYSTERY_KEY");
  });

  test("a rejected credential (present but 401) is a FAIL", async () => {
    const report = await runDoctor(
      healthyDeps({
        fetchFn: (async (url: string | URL | Request) =>
          String(url).includes("api.github.com")
            ? new Response("{}", { status: 401 })
            : new Response("{}", { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const gh = byName(report.checks, "token: github");
    expect(gh.level).toBe("fail");
    expect(gh.detail).toContain("401");
  });

  test("a GitHub PAT for a different account is a FAIL", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) =>
          String(url).includes("api.github.com")
            ? Response.json({ login: "someone-else" })
            : base.fetchFn!(url, init)) as unknown as typeof fetch,
      }),
    );
    const gh = byName(report.checks, "token: github");
    expect(gh.level).toBe("fail");
    expect(gh.detail).toContain("someone-else");
    expect(gh.detail).toContain("0xbeckett");
  });

  test("GITHUB_ACCOUNT selects the PAT identity even when projects publish to an org", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        env: {
          ...base.env,
          GITHUB_ACCOUNT: "publisher-bot",
          BECKETT_GH_ORG: "acme-labs",
        },
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) =>
          String(url).includes("api.github.com")
            ? Response.json({ login: "publisher-bot" })
            : base.fetchFn!(url, init)) as unknown as typeof fetch,
      }),
    );

    expect(byName(report.checks, "token: github")).toEqual({
      name: "token: github",
      level: "ok",
      detail: "HTTP 200 as publisher-bot",
    });
  });

  test("no alert webhook → WARN, daemon down → FAIL", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        env: { ...base.env, DISCORD_ALERT_WEBHOOK_URL: undefined },
        busStatus: async () => null,
      }),
    );
    expect(byName(report.checks, "token: alert webhook").level).toBe("warn");
    expect(byName(report.checks, "daemon: control.sock").level).toBe("fail");
    expect(report.ok).toBeFalse();
  });
});

describe("doctor — plumbing", () => {
  test("parseEnvInventory splits required from optional", () => {
    const inv = parseEnvInventory("A=\nB= # optional\n# comment\nexport C=\n\nnot a key\n");
    expect(inv.required).toEqual(["A", "C"]);
    expect(inv.optional).toEqual(["B"]);
  });

  test("daemonPath mirrors the systemd unit", () => {
    expect(daemonPath("/home/beckett")).toBe(
      "/home/beckett/.local/bin:/home/beckett/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    );
  });
});
