#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { createBrowserRuntime } from "../../src/browser/runtime.ts";
import type { Logger } from "../../src/types.ts";

const logger = (() => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return log as unknown as Logger;
})();

const dir = mkdtempSync(join(tmpdir(), "beckett-browser-smoke-"));
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<!doctype html><title>smoke</title><main>${path === "/ready" ? "browser-ready" : path}</main>`, {
      headers: { "content-type": "text/html" },
    });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;
const previousDir = process.env.BECKETT_DIR;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runtime = createBrowserRuntime({
  config: validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 10_000 },
  }),
  logger,
});

try {
  await runtime.acquire({
    runId: "production-smoke",
    channelId: null,
    artifactsDir: join(dir, "quick", "production-smoke", "artifacts"),
    controlToken: token,
  });
  await runtime.evaluate(
    "production-smoke",
    `
      const first = await context.newPage();
      const second = await context.newPage();
      await page.goto(${JSON.stringify(`${baseUrl}/seed`)});
      await page.evaluate(() => {
        document.cookie = 'browser_smoke=warm; path=/';
        localStorage.setItem('browser-smoke', 'warm');
      });
      await Promise.all([
        first.goto(${JSON.stringify(`${baseUrl}/first`)}),
        second.goto(${JSON.stringify(`${baseUrl}/ready`)}),
      ]);
      usePage(second);
    `,
    token,
  );
  const result = await runtime.evaluate(
    "production-smoke",
    "return await page.locator('main').innerText()",
    token,
  );
  if (result.value !== "browser-ready") throw new Error(`unexpected browser result: ${String(result.value)}`);
  const captured = await runtime.evaluate(
    "production-smoke",
    "await screenshot('production-smoke'); return page.url()",
    token,
  );
  if (captured.screenshots.length !== 1 || !existsSync(captured.screenshots[0]!)) {
    throw new Error("production browser screenshot handoff failed");
  }
  await runtime.release("production-smoke", false);

  await runtime.acquire({
    runId: "production-smoke-restart",
    channelId: null,
    artifactsDir: join(dir, "quick", "production-smoke-restart", "artifacts"),
    controlToken: token,
  });
  const persisted = await runtime.evaluate(
    "production-smoke-restart",
    `
      await page.goto(${JSON.stringify(`${baseUrl}/check`)});
      return await page.evaluate(() => document.cookie + '|' + localStorage.getItem('browser-smoke'));
    `,
    token,
  );
  if (persisted.value !== "browser_smoke=warm|warm") {
    throw new Error(`persistent browser state failed: ${String(persisted.value)}`);
  }
  await runtime.release("production-smoke-restart", false);
  process.stdout.write("browser sandbox smoke passed\n");
} finally {
  await runtime.stop();
  server.stop(true);
  if (previousDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
}
