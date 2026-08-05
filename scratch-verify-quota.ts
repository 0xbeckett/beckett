#!/usr/bin/env bun
/**
 * Ticket #7 verification harness: run arbitrary BetterWright code inside THIS worktree's
 * sandboxed browser lane (not the daemon's checkout).
 *
 *   bun scratch-verify-quota.ts <code-file.js> [evalTimeoutMs]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const evalTimeoutMs = Number(process.env.VERIFY_EVAL_TIMEOUT_MS ?? 120_000);
const codeFiles = process.argv.slice(2);
if (codeFiles.length === 0) throw new Error("usage: bun scratch-verify-quota.ts <code-file.js>...");

// On /home deliberately: resolveLaneStorageBytes statfs's the profile's filesystem, and
// production's beckett_dir lives on the real disk, not the 16G tmpfs.
const dir = process.env.VERIFY_REUSE_DIR ?? mkdtempSync("/home/beckett/.cache/beckett-quota-verify-");
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runId = "quota-verify";
const runtime = createBrowserRuntime({
  config: validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: evalTimeoutMs },
  }),
  logger,
});

try {
  await runtime.acquire({ runId, channelId: null, artifactsDir: join(dir, "browser-agent", runId, "artifacts"), controlToken: token });
  for (const file of codeFiles) {
    const started = Date.now();
    const result = await runtime.evaluate(runId, readFileSync(file, "utf8"), token);
    process.stdout.write(`RESULT[${file} ${Date.now() - started}ms] ${JSON.stringify(result.value)}\n`);
  }
} finally {
  await runtime.release(runId, false).catch(() => {});
  await runtime.stop().catch(() => {});
  if (!process.env.VERIFY_REUSE_DIR) rmSync(dir, { recursive: true, force: true });
}
