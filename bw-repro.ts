import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "./src/config.ts";
import { createBrowserRuntime } from "./src/browser/runtime.ts";
import type { Logger } from "./src/types.ts";

const log: any = {
  info(m: string, x?: unknown) { console.error("INFO", m, x ?? ""); },
  warn(m: string, x?: unknown) { console.error("WARN", m, x ?? ""); },
  error(m: string, x?: unknown) { console.error("ERROR", m, x ?? ""); },
  debug(m: string, x?: unknown) { console.error("DEBUG", m, JSON.stringify(x) ?? ""); },
  child() { return log; },
};
const dir = mkdtempSync(join(tmpdir(), "bw-repro-"));
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runtime = createBrowserRuntime({
  config: validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 20000 } }),
  logger: log as Logger,
});
try {
  await runtime.acquire({ runId: "r1", channelId: null, artifactsDir: join(dir, "quick", "r1", "artifacts"), controlToken: token });
  const res = await runtime.evaluate("r1", "return 1+1", token);
  console.error("EVAL OK", JSON.stringify(res.value));
} catch (e) {
  console.error("CAUGHT", e);
} finally {
  await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
