import { createBetterWrightRuntime } from "./src/browser/betterwright.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profileDir = mkdtempSync(join(tmpdir(), "bw-smoke-"));

const logger = {
  info: (...args: unknown[]) => console.log("[info]", ...args),
  warn: (...args: unknown[]) => console.log("[warn]", ...args),
  error: (...args: unknown[]) => console.log("[error]", ...args),
  debug: (...args: unknown[]) => console.log("[debug]", ...args),
};

const settings = {
  profileDir,
  artifactsRoot: join(profileDir, "artifacts"),
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 800,
  launchTimeoutMs: 30_000,
  actionTimeoutMs: 15_000,
  navigationTimeoutMs: 20_000,
  evalTimeoutMs: 20_000,
  maxOutputChars: 20_000,
};

const runtime = createBetterWrightRuntime(settings as any, logger as any);

const lease = {
  runId: "smoke-1",
  channelId: "smoke",
  artifactsDir: join(profileDir, "artifacts"),
};

async function main() {
  await runtime.acquire(lease as any);
  console.log("acquired lease");
  const result = await runtime.evaluate("smoke-1", "await openPage('https://example.com'); return { url: page.url(), title: await page.title() }");
  console.log("evaluate result:", JSON.stringify(result, null, 2));
  await runtime.release("smoke-1", false);
  console.log("released lease");
  await runtime.stop();
  console.log("SMOKE OK");
}

main().catch((error) => {
  console.error("SMOKE FAILED", error);
  process.exit(1);
});
