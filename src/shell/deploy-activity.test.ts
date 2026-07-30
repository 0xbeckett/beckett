import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDeployActive,
  DEPLOY_MARKER_TTL_MS,
  isDeployActive,
  markDeployActive,
  withDeployMarker,
} from "./deploy-activity.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "beckett-deploy-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("no marker → not active", () => {
  expect(isDeployActive(dir, 0)).toBe(false);
});

test("mark → active; clear → inactive", () => {
  markDeployActive(dir, 1_000);
  expect(isDeployActive(dir, 1_000)).toBe(true);
  clearDeployActive(dir);
  expect(isDeployActive(dir, 1_000)).toBe(false);
});

test("a stale marker is ignored (crash-safety)", () => {
  markDeployActive(dir, 1_000);
  expect(isDeployActive(dir, 1_000 + DEPLOY_MARKER_TTL_MS - 1)).toBe(true);
  expect(isDeployActive(dir, 1_000 + DEPLOY_MARKER_TTL_MS)).toBe(false);
});

test("withDeployMarker holds the marker for the duration then clears it", async () => {
  let sawActive = false;
  const result = await withDeployMarker(dir, async () => {
    sawActive = isDeployActive(dir);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(sawActive).toBe(true);
  expect(isDeployActive(dir)).toBe(false);
});

test("withDeployMarker clears even when the body throws", async () => {
  await expect(
    withDeployMarker(dir, async () => { throw new Error("deploy failed"); }),
  ).rejects.toThrow("deploy failed");
  expect(isDeployActive(dir)).toBe(false);
});
