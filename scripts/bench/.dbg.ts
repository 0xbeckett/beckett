import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { browserHostSettings } from "../../src/browser/runtime.ts";
import { createIsolatedBrowserRuntime } from "../../src/browser/isolated.ts";
const logger: any = { info: () => {}, warn: (...a: any) => console.error("W", ...a), error: (...a: any) => console.error("E", ...a), debug: () => {}, child() { return logger; } };
const dir = mkdtempSync(join(tmpdir(), "dbg-"));
const server = Bun.serve({ port: 0, fetch() { return new Response(`<!doctype html><title>t</title><main><h1 id="content">hello world</h1></main><script>const m=document.createElement('div');m.id='ready';document.body.appendChild(m);</script>`, { headers: { "content-type": "text/html" } }); } });
const baseUrl = `http://127.0.0.1:${server.port}`;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 8000 } });
const rt = createIsolatedBrowserRuntime({ settings: browserHostSettings(config), logger, backend: "betterwright" });
const runId = "dbg";
try {
  await rt.acquire({ runId, channelId: null, artifactsDir: join(dir, "browser-agent", runId, "artifacts"), controlToken: token });
  await rt.evaluate(runId, `await page.goto(${JSON.stringify(baseUrl)}); return page.url();`, token);
  console.error("navigated");
  const steps: Array<[string, string]> = [
    ["locator.waitFor", `await page.locator('#ready').waitFor(); return 'ok';`],
    ["waitForLoadState", `await page.waitForLoadState('networkidle'); return 'ok';`],
    ["read", `return await page.locator('#content').innerText();`],
    ["$eval", `return await page.$eval('#content', el => el.textContent);`],
    ["shot", `return await screenshot({kind:'question',name:'x'});`],
  ];
  for (const [label, code] of steps) {
    const t = performance.now();
    try { const r = await rt.evaluate(runId, code, token); console.error(label, "->", JSON.stringify(r.value).slice(0, 60), (performance.now() - t).toFixed(0) + "ms"); }
    catch (e: any) { console.error(label, "ERR", e.message.slice(0, 90)); }
  }
} finally { await rt.release(runId, false).catch(() => {}); await rt.stop().catch(() => {}); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
