import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { browserHostSettings } from "../../src/browser/runtime.ts";
import { createIsolatedBrowserRuntime } from "../../src/browser/isolated.ts";
const logger: any = { info: () => {}, warn: (...a: any) => console.error("W", ...a), error: (...a: any) => console.error("E", ...a), debug: () => {}, child() { return logger; } };
const dir = mkdtempSync(join(tmpdir(), "dbg-"));
const server = Bun.serve({ port: 0, fetch() { return new Response(`<!doctype html><title>t</title><main><h1 id="content">hello world lorem ipsum</h1><button id="go">Go</button><output id="out"></output></main><script>document.getElementById('go').onclick=()=>{document.getElementById('out').textContent='clicked';};</script>`, { headers: { "content-type": "text/html" } }); } });
const baseUrl = `http://127.0.0.1:${server.port}`;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 8000 } });
const rt = createIsolatedBrowserRuntime({ settings: browserHostSettings(config), logger, backend: "betterwright" });
const runId = "dbg";
const code = `
  await page.goto(${JSON.stringify(baseUrl)});
  await page.locator('#content').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Go' }).click();
  const text = await page.locator('#content').innerText();
  const out = await page.locator('#out').innerText();
  await screenshot({ kind: 'question', name: 'bench' });
  return text.length + ':' + out;
`;
try {
  await rt.acquire({ runId, channelId: null, artifactsDir: join(dir, "browser-agent", runId, "artifacts"), controlToken: token });
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    const r = await rt.evaluate(runId, code, token);
    console.error(`iter ${i}: ${JSON.stringify(r.value)} ${(performance.now() - t).toFixed(0)}ms`);
  }
} finally { await rt.release(runId, false).catch(() => {}); await rt.stop().catch(() => {}); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
