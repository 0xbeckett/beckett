/**
 * Beckett — structured logger (`src/log.ts`)
 * =======================================================================================
 * A tiny dependency-free structured logger. Emits one JSON object per line to **stderr**
 * (journald captures stderr for the systemd user service, Spec 01 §5.3), with a stable
 * shape: {level, ts, component, msg, ...fields}. Also offers a helper to append
 * human-prettified per-worker lines to `logs_dir` (Spec 00 §5: "daemon + per-worker
 * prettified logs").
 *
 * No deps; safe to import anywhere (it is owned by Foundation alongside types/config/paths).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger, LogLevel } from "./types.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const v = (process.env.BECKETT_LOG_LEVEL ?? "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

let minLevel: LogLevel = envLevel();

/** Override the global minimum level (e.g. after config load). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const rec: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    component,
    msg,
    ...(fields ?? {}),
  };
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    // never let a non-serializable field crash logging
    line = JSON.stringify({ level, ts: rec.ts, component, msg, fields: "[unserializable]" });
  }
  process.stderr.write(line + "\n");
}

/** Create a logger bound to a component name. */
export function makeLogger(component = "beckett"): Logger {
  return {
    debug: (msg, fields) => emit("debug", component, msg, fields),
    info: (msg, fields) => emit("info", component, msg, fields),
    warn: (msg, fields) => emit("warn", component, msg, fields),
    error: (msg, fields) => emit("error", component, msg, fields),
    child: (sub: string) => makeLogger(component === "beckett" ? sub : `${component}.${sub}`),
  };
}

/** The root logger. Most modules call `log.child("<component>")`. */
export const log: Logger = makeLogger();

/**
 * Append a prettified line to a worker's own log file under `<logsDir>/workers/<id>.log`.
 * Best-effort and synchronous (single-writer daemon); failures are swallowed so logging
 * never takes down the loop. Returns the file path written.
 */
export function appendWorkerLog(
  logsDir: string,
  workerId: string,
  line: string,
): string {
  const dir = join(logsDir, "workers");
  const file = join(dir, `${workerId}.log`);
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    appendFileSync(file, `${stamp}  ${line}\n`);
  } catch {
    // swallow — per-worker pretty logs are a convenience, not a durability surface
  }
  return file;
}
