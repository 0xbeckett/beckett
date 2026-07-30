/**
 * Beckett — deploy-in-flight marker (`src/shell/deploy-activity.ts`)
 * =======================================================================================
 * A deploy runs in whatever process invoked `beckett deploy` (a worker's build, the deploy skill,
 * a bus command) — NOT in the daemon. The daemon derives presence (#132) on its status-snapshot
 * tick, so it needs a cross-process way to see "a deploy is in flight". This is that: a tiny marker
 * file under the beckett dir, written for the duration of a deploy and cleared when it finishes.
 *
 * The marker carries a timestamp and is treated as stale after {@link DEPLOY_MARKER_TTL_MS}, so a
 * process that crashes mid-deploy (and never clears it) cannot pin presence to "a deploy" forever.
 * Every operation is best-effort: a marker read/write must never break a deploy or a status tick.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A deploy older than this without being cleared is assumed dead (crash-safety stale guard). */
export const DEPLOY_MARKER_TTL_MS = 5 * 60_000;

function markerPath(beckettDir: string): string {
  return join(beckettDir, "deploy-active.json");
}

/** Record that a deploy has started. Best-effort — never throws into the deploy path. */
export function markDeployActive(beckettDir: string, now: number = Date.now()): void {
  const path = markerPath(beckettDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ at: now })}\n`, "utf8");
  } catch {
    /* presence is a read-out; a failed marker write is not worth failing a deploy over */
  }
}

/** Clear the deploy marker once a deploy finishes (success or failure). Best-effort. */
export function clearDeployActive(beckettDir: string): void {
  try {
    rmSync(markerPath(beckettDir), { force: true });
  } catch {
    /* the TTL stale guard covers a missed clear */
  }
}

/** True iff a deploy started within the last {@link DEPLOY_MARKER_TTL_MS}. Best-effort → false. */
export function isDeployActive(beckettDir: string, now: number = Date.now()): boolean {
  const path = markerPath(beckettDir);
  try {
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown };
    if (typeof parsed.at !== "number") return false;
    return now - parsed.at < DEPLOY_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

/** Run `fn` with the deploy marker held for its duration, clearing it however `fn` settles. */
export async function withDeployMarker<T>(beckettDir: string, fn: () => Promise<T>): Promise<T> {
  markDeployActive(beckettDir);
  try {
    return await fn();
  } finally {
    clearDeployActive(beckettDir);
  }
}
