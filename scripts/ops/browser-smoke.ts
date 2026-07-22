#!/usr/bin/env bun

/**
 * End-to-end smoke of the Concierge browser lane: `beckett browser` invocation building,
 * the agent-browser daemon, a live local page, cross-invocation state, and the persistent
 * per-session profile. Run on the deploy box (`bun run browser:smoke`) before restarting.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../src/config.ts";
import { buildBrowserInvocation } from "../../src/browser/cli.ts";

const dir = mkdtempSync(join(tmpdir(), "beckett-browser-smoke-"));
const session = `smoke-${process.pid}`;
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(`<!doctype html><title>Beckett browser smoke</title>
      <main><h1>Beckett browser smoke</h1>
      <label>Message <input aria-label="Message"></label><button>Save</button><output></output></main>
      <script>document.querySelector('button').onclick = () => {
        const value = document.querySelector('input').value;
        localStorage.setItem('browser-smoke', value);
        document.querySelector('output').textContent = 'saved:' + value;
      }</script>`, { headers: { "content-type": "text/html" } });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;
const config = validateConfig({ paths: { beckett_dir: dir }, browser: { session } });

async function browser(...argv: string[]): Promise<string> {
  const invocation = buildBrowserInvocation(config, argv);
  const child = Bun.spawn({ cmd: invocation.cmd, env: invocation.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`agent-browser ${argv.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

function expect(actual: unknown, wanted: unknown, what: string): void {
  if (actual !== wanted) throw new Error(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

try {
  // Each command is its own process; the daemon must carry page state between them.
  await browser("open", baseUrl);
  const snapshot = await browser("snapshot", "-i");
  if (!snapshot.includes("Message") || !snapshot.includes("Save")) {
    throw new Error(`interactive snapshot is missing the page controls:\n${snapshot}`);
  }
  await browser("fill", "input", "hello-from-beckett");
  await browser("click", "button");
  expect(await browser("get", "text", "output"), "saved:hello-from-beckett", "click handler result");
  // `eval` prints the result JSON-encoded, so a string value arrives quoted.
  expect(await browser("eval", "localStorage.getItem('browser-smoke')"), '"hello-from-beckett"', "localStorage");
  const url = await browser("get", "url");
  expect(url, `${baseUrl}/`, "page url");
  console.log("browser smoke OK", { baseUrl, session });
} finally {
  await browser("close").catch(() => undefined);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
