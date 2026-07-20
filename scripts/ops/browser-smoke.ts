#!/usr/bin/env bun

/**
 * End-to-end BetterWright MCP backend smoke: the actual stdio MCP bridge drives
 * a live page through the isolated host, then verifies the persistent profile.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { createBrowserRuntime } from "../../src/browser/runtime.ts";
import { serveBus } from "../../src/shell/control-bus.ts";
import type { BrowserEvalResult } from "../../src/browser/runtime.ts";
import type { Logger } from "../../src/types.ts";

const logger = (() => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
  return log as unknown as Logger;
})();

const dir = mkdtempSync(join(tmpdir(), "beckett-betterwright-smoke-"));
const socket = join(dir, "control.sock");
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
const runId = "betterwright-smoke";
const runtime = createBrowserRuntime({
  config: validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 20_000 },
  }),
  logger,
});

interface McpClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  stop(): Promise<void>;
}

/** Minimal line-framed client so this smoke covers the production stdio MCP bridge too. */
function startMcp(run: string): McpClient {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "..", "src", "browser", "mcp.ts")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BECKETT_CONTROL_SOCKET: socket,
      BECKETT_BROWSER_RUN_ID: run,
      BECKETT_BROWSER_CONTROL_TOKEN: token,
      BECKETT_BROWSER_EVAL_TIMEOUT_MS: "30000",
      BECKETT_BROWSER_MAX_OUTPUT_CHARS: "24000",
    },
  });
  const sink = child.stdin;
  if (!sink || typeof sink === "number") throw new Error("could not open BetterWright MCP stdin");
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const pending = new Map<number, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  let buffer = "";
  let nextId = 1;
  const receive = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, any>;
          const request = pending.get(message.id);
          if (!request) continue;
          pending.delete(message.id);
          request.resolve(message);
        }
      }
      for (const request of pending.values()) request.reject(new Error("BetterWright MCP closed before responding"));
    } catch (error) {
      for (const request of pending.values()) request.reject(error as Error);
    }
  })();
  return {
    call(method, params = {}) {
      const id = nextId++;
      const response = new Promise<Record<string, any>>((resolve, reject) => pending.set(id, { resolve, reject }));
      sink.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    async stop() {
      sink.end();
      await Promise.all([receive, child.exited]);
      if ((await child.exited) !== 0) {
        const stderr = await new Response(child.stderr as ReadableStream).text();
        throw new Error(`BetterWright MCP exited unexpectedly: ${stderr}`);
      }
    },
  };
}

function mcpResult(response: Record<string, any>): BrowserEvalResult {
  if (response.error) throw new Error(`MCP error: ${response.error.message}`);
  const result = response.result as { isError?: boolean; content?: Array<{ type?: string; text?: string; data?: string }> };
  if (result.isError) throw new Error(`browser tool error: ${result.content?.[0]?.text ?? "unknown error"}`);
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("BetterWright MCP returned no browser result");
  return JSON.parse(text) as BrowserEvalResult;
}

let stopBus: (() => void) | undefined;
let mcp: McpClient | undefined;
try {
  await runtime.acquire({
    runId,
    channelId: null,
    artifactsDir: join(dir, "browser-agent", runId, "artifacts"),
    controlToken: token,
  });
  stopBus = serveBus(socket, async (request) => {
    if (request.cmd !== "browser.eval" || request.args.runId !== runId || request.args.controlToken !== token || typeof request.args.code !== "string") {
      return { ok: false, error: "unexpected browser smoke request" };
    }
    return { ok: true, data: await runtime.evaluate(runId, request.args.code, token) };
  });
  mcp = startMcp(runId);
  const initialized = await mcp.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  if (initialized.result?.serverInfo?.name !== "beckett-browser") throw new Error("BetterWright MCP did not initialize");
  const tools = await mcp.call("tools/list");
  if (tools.result?.tools?.[0]?.name !== "betterwright_browser") throw new Error("BetterWright browser tool was not exposed");

  const result = mcpResult(await mcp.call("tools/call", {
    name: "betterwright_browser",
    arguments: {
      code: `
        await page.goto(${JSON.stringify(baseUrl)});
        await page.getByLabel('Message').fill('browser-ready');
        await page.getByRole('button', { name: 'Save' }).click();
        return await page.locator('output').innerText();
      `,
    },
  }));
  if (result.value !== "saved:browser-ready") throw new Error(`unexpected BetterWright result: ${String(result.value)}`);

  const captured = await mcp.call("tools/call", {
    name: "betterwright_browser",
    arguments: { code: "return await screenshot({ kind: 'proof', name: 'betterwright-smoke' })" },
  });
  const image = (captured.result?.content as Array<{ type?: string; data?: string }> | undefined)?.find((entry) => entry.type === "image");
  if (!image?.data) throw new Error("BetterWright MCP screenshot handoff failed");
  await mcp.stop();
  mcp = undefined;
  await runtime.release(runId, false);

  await runtime.acquire({
    runId: "betterwright-smoke-restart",
    channelId: null,
    artifactsDir: join(dir, "browser-agent", "betterwright-smoke-restart", "artifacts"),
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
  process.stdout.write("betterwright browser MCP smoke passed\n");
} finally {
  if (mcp) await mcp.stop().catch(() => undefined);
  stopBus?.();
  await runtime.stop();
  server.stop(true);
  if (previousDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
}
