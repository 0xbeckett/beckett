#!/usr/bin/env bun
/** Ticket #7 verification: read navigator.storage.estimate() inside the real sandboxed lane. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "./src/config.ts";
import { createBrowserRuntime } from "./src/browser/runtime.ts";
import type { Logger } from "./src/types.ts";

const logger = (() => {
  const emit = (level: string) => (msg: unknown, meta?: unknown) => {
    process.stderr.write(`[verify:${level}] ${String(msg)}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
  };
  const log = { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug"), child() { return log; } };
  return log as unknown as Logger;
})();

// On /home deliberately: resolveLaneStorageBytes statfs's the profile's filesystem, and
// production's beckett_dir lives on the real disk, not the 16G tmpfs.
const dir = mkdtempSync("/home/beckett/.cache/beckett-quota-verify-");
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runId = "quota-verify";
const runtime = createBrowserRuntime({
  config: validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 120_000 },
  }),
  logger,
});

const target = process.argv[2] ?? "https://huggingface.co/spaces/ProCreations/maple-webgpu";

try {
  await runtime.acquire({ runId, channelId: null, artifactsDir: join(dir, "browser-agent", runId, "artifacts"), controlToken: token });
  const result = await runtime.evaluate(
    runId,
    `
      await page.goto(${JSON.stringify(target)}, { waitUntil: 'domcontentloaded' });
      return await page.evaluate(async () => {
        const est = await navigator.storage.estimate();
        const persisted = await navigator.storage.persist();
        const est2 = await navigator.storage.estimate();
        return JSON.stringify({ origin: location.origin, quota: est.quota, usage: est.usage, persisted, quotaAfterPersist: est2.quota });
      });
    `,
    token,
  );
  process.stdout.write(`RESULT ${JSON.stringify(result.value)}\n`);
} finally {
  await runtime.release(runId, false).catch(() => {});
  await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
