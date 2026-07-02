/**
 * `beckett doctor` regression checklist (issue #30): the doctor must detect each of the real
 * outages that motivated it — pi running under node 18, a stale pi version, a leaked worker
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
    node: "v22.14.0",
    claude: "2.1.0 (Claude Code)",
    codex: "codex-cli 0.99.0",
    pi: "0.80.2",
    gh: "gh version 2.62.0",
    cloudflared: "cloudflared version 2025.5.0",
  };
  return {
    config: defaultConfig(),
    home: HOME,
    env: {
      PLANE_API_TOKEN: "t",
      DISCORD_TOKEN: "t",
      GITHUB_PAT: "t",
      CLOUDFLARE_API_TOKEN: "t",
      DISCORD_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x",
    },
    exec: async (argv) => {
      const bin = argv[0]!;
      if (argv[1] === "--version" && versions[bin]) return { code: 0, stdout: versions[bin], stderr: "" };
      if (bin === "cloudflared") return { code: 0, stdout: "OK", stderr: "" };
      return { code: 127, stdout: "", stderr: "not found" };
    },
    preflight: async () => ({ ok: true, problems: [] }),
    fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    listProcesses: async () => [],
    readFile: (path: string) => {
      if (path.endsWith(".env.example")) {
        return "DISCORD_TOKEN=\nPLANE_API_TOKEN=\nGITHUB_PAT=\nDISCORD_ALERT_WEBHOOK_URL= # optional\n";
      }
      if (path.endsWith("/.env")) {
        return "DISCORD_TOKEN=x\nPLANE_API_TOKEN=x\nGITHUB_PAT=x\nDISCORD_ALERT_WEBHOOK_URL=x\n";
      }
      if (path.endsWith("dispatcher-state.json")) return JSON.stringify({ liveWorkers: {} });
      if (path.endsWith("config.yml")) return "tunnel: abc\n";
      return null;
    },
    busStatus: async () => ({ version: "3.5.0", uptimeSecs: 42 }),
    diskFreeKb: async () => 50 * 1024 * 1024, // 50 GB
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
  test("node 18 on the daemon PATH is a FAIL (the hidden pi crash)", async () => {
    const base = healthyDeps();
    const report = await runDoctor(
      healthyDeps({
        exec: async (argv, opts) => {
          if (argv[0] === "node") return { code: 0, stdout: "v18.19.1", stderr: "" };
          return base.exec!(argv, opts);
        },
      }),
    );
    const node = byName(report.checks, "binary: node");
    expect(node.level).toBe("fail");
    expect(node.detail).toContain("v18.19.1");
    expect(node.detail).toContain("20");
    expect(report.ok).toBeFalse();
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
          { pid: 5151, ppid: 900, command: "codex exec --json", cwd: `${HOME}/Projects/widgets` },
        ],
      }),
    );
    const procs = byName(report.checks, "processes: harness leaks");
    expect(procs.level).toBe("warn");
    expect(procs.detail).toContain("5151");
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
          if (path.endsWith("/.env")) return "DISCORD_TOKEN=x\nPLANE_API_TOKEN=x\n"; // no GITHUB_PAT
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
            return "DISCORD_TOKEN=x\nPLANE_API_TOKEN=x\nGITHUB_PAT=x\nMYSTERY_KEY=x\n";
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
