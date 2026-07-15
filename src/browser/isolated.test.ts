import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateConfig } from "../config.ts";
import type { Logger } from "../types.ts";
import { buildBrowserEvaluatorLaunch } from "./evaluator-runner.ts";
import { buildBrowserHostLaunch, createIsolatedBrowserRuntime } from "./isolated.ts";
import { browserHostSettings, type BrowserHostSettings } from "./runtime.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();
const CONTROL_TOKEN = "test-control-token-0123456789abcdef0123456789abcdef";

function fixturePaths(): {
  dir: string;
  settings: BrowserHostSettings;
  browser: string;
  host: string;
  node: string;
  prlimit: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-policy-test-"));
  const browser = join(dir, "ms-playwright", "chromium-123", "chrome-linux", "chrome");
  const host = join(dir, "host.mjs");
  const node = join(dir, "node");
  const prlimit = join(dir, "prlimit");
  mkdirSync(dirname(browser), { recursive: true });
  writeFileSync(browser, "fixture");
  writeFileSync(host, "fixture");
  writeFileSync(node, "fixture");
  writeFileSync(prlimit, "fixture");
  return {
    dir,
    browser,
    host,
    node,
    prlimit,
    settings: {
      profileDir: join(dir, "profile"),
      artifactsRoot: join(dir, "run", "artifacts"),
      headless: true,
      viewportWidth: 1440,
      viewportHeight: 900,
      launchTimeoutMs: 30_000,
      actionTimeoutMs: 10_000,
      navigationTimeoutMs: 30_000,
      evalTimeoutMs: 60_000,
      maxOutputChars: 24_000,
    },
  };
}

describe("browser host sandbox policy", () => {
  test("Linux uses bubblewrap with only the current profile and artifacts writable", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        parentEnv: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "https://user:secret@proxy.invalid" },
      });
      expect(launch.isolation).toBe("bubblewrap");
      expect(launch.command).toContain("--unshare-all");
      expect(launch.command).toContain("--clearenv");
      expect(launch.command).toContain("--cap-drop");
      expect(launch.command).not.toContain("CAP_SYS_ADMIN");
      expect(launch.command).toContain("/runtime/node");
      expect(launch.command).not.toContain("/runtime/bun");
      expect(launch.command.slice(0, 3)).toEqual([fixture.prlimit, "--fsize=134217728", "--"]);
      const writable = launch.command.flatMap((value, index, all) => (value === "--bind" ? [all[index + 1]] : []));
      expect(writable).toEqual([fixture.settings.profileDir, fixture.settings.artifactsRoot]);
      expect(launch.command.join(" ")).not.toContain(".env");
      expect(JSON.stringify(launch)).not.toContain("user:secret");
      expect(launch.command.some((value, index) => value === resolve(import.meta.dir, "../..") && launch.command[index + 1] === "/repo")).toBe(false);
      expect(launch.command).toContain("/repo/node_modules/.cache/beckett-browser/host.mjs");
      expect(launch.command).not.toContain("/repo/src/browser");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("Linux fails closed when bubblewrap is unavailable", () => {
    const fixture = fixturePaths();
    try {
      expect(() =>
        buildBrowserHostLaunch({
          settings: fixture.settings,
          platform: "linux",
          sandbox: "auto",
          execPath: process.execPath,
          nodePath: fixture.node,
          hostPath: fixture.host,
          chromiumExecutable: fixture.browser,
          repoRoot: resolve(import.meta.dir, "../.."),
          bwrapPath: "",
          parentEnv: { PATH: "" },
        }),
      ).toThrow("requires bubblewrap");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("process-only development mode keeps Chromium's Unix socket path short", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "none",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
      });
      const runtimeTmp = launch.env.TMPDIR!;
      expect(runtimeTmp).toMatch(/^\/tmp\/beckett-browser-[a-f0-9]{12}$/);
      expect(runtimeTmp).not.toContain(fixture.settings.profileDir);
      expect(runtimeTmp.length).toBeLessThan(64);
      expect(launch.command).toEqual([realpathSync(fixture.node), realpathSync(fixture.host)]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("macOS uses sandbox-exec when supplied", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "darwin",
        sandbox: "macos",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
        sandboxExecPath: "/usr/bin/sandbox-exec",
      });
      expect(launch.isolation).toBe("sandbox-exec");
      expect(launch.command[0]).toBe("/usr/bin/sandbox-exec");
      expect(launch.command.join(" ")).toContain("(deny default)");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("browser evaluator sandbox policy", () => {
  test("Linux uses a fresh bounded bubblewrap without controller state mounts", () => {
    const fixture = fixturePaths();
    const repoRoot = resolve(import.meta.dir, "../..");
    try {
      const launch = buildBrowserEvaluatorLaunch(
        { evalTimeoutMs: 60_000 },
        {
          isolation: "bubblewrap",
          repoRoot,
          bwrapPath: "/usr/bin/bwrap",
          nodePath: fixture.node,
          prlimitPath: fixture.prlimit,
          parentEnv: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "https://user:secret@proxy.invalid" },
        },
      );

      expect(launch.isolation).toBe("bubblewrap");
      expect(launch.command[0]).toBe("/usr/bin/bwrap");
      expect(launch.command).toContain("--unshare-all");
      expect(launch.command).toContain("--share-net");
      expect(launch.command).toContain("--cap-drop");
      expect(launch.command).not.toContain("CAP_SYS_ADMIN");
      expect(launch.command).toContain("/runtime/prlimit");
      expect(launch.command).toContain("--as=17179869184");
      expect(launch.command).toContain("--max-old-space-size=256");
      expect(launch.command).toContain("--nproc=256");
      expect(launch.command).toContain("--fsize=33554432");
      expect(launch.command).toContain("--cpu=62");
      expect(launch.command).not.toContain("--bind");
      expect(launch.command.join(" ")).not.toContain(fixture.settings.profileDir);
      expect(launch.command.join(" ")).not.toContain(fixture.settings.artifactsRoot);
      expect(launch.command.some((value, index) => value === repoRoot && launch.command[index + 1] === "/repo")).toBe(false);
      expect(launch.command).toContain("/repo/src/browser/evaluator.cjs");
      expect(JSON.stringify(launch)).not.toContain("user:secret");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

test("isolated leases require the exact high-entropy control capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-capability-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await expect(runtime.acquire({
      runId: "capability",
      channelId: null,
      artifactsDir: join(dir, "quick", "capability", "artifacts"),
      controlToken: "short",
    })).rejects.toThrow("high-entropy");
    await runtime.acquire({
      runId: "capability",
      channelId: null,
      artifactsDir: join(dir, "quick", "capability", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await expect(runtime.evaluate("capability", "return 42", "wrong-token-that-is-long-enough-000000")).rejects.toThrow(
      "capability rejected",
    );
    expect((await runtime.evaluate("capability", "return 42", CONTROL_TOKEN)).value).toBe(42);
    await runtime.release("capability", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("evaluator never receives a screenshot path and daemon delivers a trusted PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-nofollow-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await runtime.acquire({
      runId: "nofollow",
      channelId: null,
      artifactsDir: join(dir, "quick", "nofollow", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const evaluated = await runtime.evaluate("nofollow", `
      await page.setContent('<main>trusted screenshot</main>');
      return await screenshot('shot-link');
    `, CONTROL_TOKEN);
    expect(evaluated.value).toBe("[screenshot queued: shot-link]");
    expect(evaluated.screenshots).toHaveLength(1);
    expect(evaluated.screenshots[0]).not.toContain(join("nofollow", "artifacts"));
    expect(readFileSync(evaluated.screenshots[0]!).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  } finally {
    if (runtime.hasLease("nofollow")) await runtime.release("nofollow", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("persistent browser state survives lease host replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-persistence-test-"));
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<!doctype html><title>state</title><main>state</main>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await runtime.acquire({
      runId: "first",
      channelId: null,
      artifactsDir: join(dir, "quick", "first", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await runtime.evaluate("first", `
      await page.goto(${JSON.stringify(url)});
      await page.evaluate(() => {
        document.cookie = 'host_session=persisted; path=/; max-age=3600';
        localStorage.setItem('host-state', 'persisted');
      });
    `, CONTROL_TOKEN);
    await runtime.release("first", false);
    expect(runtime.stats().ready).toBe(false);

    await runtime.acquire({
      runId: "second",
      channelId: null,
      artifactsDir: join(dir, "quick", "second", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const restored = await runtime.evaluate("second", `
      await page.goto(${JSON.stringify(url)});
      return await page.evaluate(() => document.cookie + '|' + localStorage.getItem('host-state'));
    `, CONTROL_TOKEN);
    expect(restored.value).toContain("host_session=persisted|persisted");
    await runtime.release("second", false);
  } finally {
    await runtime.stop();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("isolated stop interrupts a cold acquisition without leaving a host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-stop-host-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    const acquisition = runtime.acquire({
      runId: "stopping",
      channelId: null,
      artifactsDir: join(dir, "quick", "stopping", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const stopping = runtime.stop();
    await expect(acquisition).rejects.toThrow("interrupted by shutdown");
    await stopping;
    expect(runtime.stats()).toMatchObject({ ready: false, activeRunId: null });
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
