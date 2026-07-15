#!/usr/bin/env bun

/** End-to-end BetterWright MCP backend smoke: navigate, type/click, read, screenshot, persist. */

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

const dir = mkdtempSync(join(tmpdir(), "beckett-betterwright-smoke-"));
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(`<!doctype html><title>BetterWright smoke</title>
      <main><label>Message <input aria-label="Message"></label><button>Save</button><output></output></main>
      <script>document.querySelector('button').onclick = () => {
        const value = document.querySelector('input').value;
        localStorage.setItem('browser-smoke', value); document.cookie = 'browser_smoke=' + value + '; path=/; max-age=3600';
        document.querySelector('output').textContent = 'saved:' + value;
      }</script>`, { headers: { "content-type": "text/html" } });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;
const previousDir = process.env.BECKETT_DIR;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runtime = createBrowserRuntime({
  config: validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 20_000 },
  }),
  logger,
});

try {
  await runtime.acquire({
    runId: "betterwright-smoke",
    channelId: null,
    artifactsDir: join(dir, "quick", "betterwright-smoke", "artifacts"),
    controlToken: token,
  });
  const result = await runtime.evaluate(
    "betterwright-smoke",
    `
      await page.goto(${JSON.stringify(baseUrl)});
      await page.getByLabel('Message').fill('browser-ready');
      await page.getByRole('button', { name: 'Save' }).click();
      return await page.locator('output').innerText();
    `,
    token,
  );
  if (result.value !== "saved:browser-ready") throw new Error(`unexpected BetterWright result: ${String(result.value)}`);
  const captured = await runtime.evaluate(
    "betterwright-smoke",
    "return await screenshot({ kind: 'proof', name: 'betterwright-smoke' })",
    token,
  );
  if (captured.screenshots.length !== 1 || !existsSync(captured.screenshots[0]!)) {
    throw new Error("BetterWright screenshot handoff failed");
  }
  await runtime.release("betterwright-smoke", false);

  await runtime.acquire({
    runId: "betterwright-smoke-restart",
    channelId: null,
    artifactsDir: join(dir, "quick", "betterwright-smoke-restart", "artifacts"),
    controlToken: token,
  });
  const persisted = await runtime.evaluate(
    "betterwright-smoke-restart",
    `
      await page.goto(${JSON.stringify(baseUrl)});
      return await page.evaluate(() => document.cookie + '|' + localStorage.getItem('browser-smoke'));
    `,
    token,
  );
  if (persisted.value !== "browser_smoke=browser-ready|browser-ready") {
    throw new Error(`persistent BetterWright state failed: ${String(persisted.value)}`);
  }
  await runtime.release("betterwright-smoke-restart", false);
  process.stdout.write("betterwright browser smoke passed\n");
} finally {
  await runtime.stop();
  server.stop(true);
  if (previousDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
}
