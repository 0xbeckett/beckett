/**
 * Maintainers (OPS-144) — pure library tests. The security invariants pinned here:
 * only the OWNER's authenticated author id can turn a pending maintainer grant into a
 * maintainer (no self-elevation, no peer-elevation), the bundled seed is read-only to the
 * runtime flow, and membership is the bundled ∪ runtime union.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccess, loadPending } from "./access.ts";
import {
  bundledMaintainersFile,
  isMaintainer,
  loadMaintainers,
  requestMaintainerGrant,
  resolveMaintainerPending,
  revokeMaintainer,
} from "./maintainers.ts";

const OWNER = "111111111111111111";
const ZOOM = "222222222222222222";
const PEER = "888888888888888888";
const CANDIDATE = "999999999999999999";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): { runtime: string; bundled: string; pending: string } {
  const d = mkdtempSync(join(tmpdir(), "beckett-maintainers-"));
  dirs.push(d);
  const bundled = join(d, "bundled-maintainers.txt");
  writeFileSync(bundled, `# seed\n${OWNER}\n${ZOOM}\n`, "utf8");
  return { runtime: join(d, "maintainers.txt"), bundled, pending: join(d, "maintainers-pending.json") };
}

test("the repo ships an empty bundled maintainer baseline", () => {
  expect(loadAccess(bundledMaintainersFile()).ids).toEqual(new Set());
});

test("runtime maintainer additions remain effective with the empty shipped baseline", () => {
  const { runtime } = tmp();
  writeFileSync(runtime, `${PEER}\n`, "utf8");
  expect(loadMaintainers(runtime)).toEqual(new Set([PEER]));
});

test("membership is the union of the bundled seed and runtime additions", () => {
  const { runtime, bundled } = tmp();
  writeFileSync(runtime, `${PEER}\n`, "utf8");
  const set = loadMaintainers(runtime, bundled);
  expect(set.has(ZOOM)).toBe(true);
  expect(set.has(PEER)).toBe(true);
  expect(set.has(CANDIDATE)).toBe(false);
  // Missing runtime file → just the seed; never throws.
  const { runtime: fresh, bundled: b2 } = tmp();
  expect(loadMaintainers(fresh, b2).has(ZOOM)).toBe(true);
});

test("isMaintainer: owner implicit, seed and runtime ids yes, others no", () => {
  const { runtime, bundled } = tmp();
  expect(isMaintainer(OWNER, OWNER, runtime, bundled)).toBe(true);
  expect(isMaintainer(ZOOM, OWNER, runtime, bundled)).toBe(true);
  expect(isMaintainer(CANDIDATE, OWNER, runtime, bundled)).toBe(false);
});

test("grant is two-phase: the request parks a code and adds nobody", () => {
  const { runtime, bundled, pending } = tmp();
  const r = requestMaintainerGrant(pending, runtime, CANDIDATE, OWNER, bundled);
  expect(r.status).toBe("pending");
  expect(r.code).toBeDefined();
  expect(loadMaintainers(runtime, bundled).has(CANDIDATE)).toBe(false);
});

test("requesting a bundled maintainer is a no-op 'already-member'", () => {
  const { runtime, bundled, pending } = tmp();
  const r = requestMaintainerGrant(pending, runtime, ZOOM, OWNER, bundled);
  expect(r.status).toBe("already-member");
  expect(loadPending(pending)).toHaveLength(0);
});

test("only the owner's authenticated id can approve — a maintainer cannot mint maintainers", () => {
  const { runtime, bundled, pending } = tmp();
  const code = requestMaintainerGrant(pending, runtime, CANDIDATE, OWNER, bundled).code!;

  // An existing maintainer (zoom) tries to approve: refused, code NOT consumed.
  const byMaintainer = resolveMaintainerPending(pending, runtime, code, ZOOM, OWNER, "approve");
  expect(byMaintainer.ok).toBe(false);
  expect(byMaintainer.status).toBe("not-owner");
  // The candidate approving themselves: refused too.
  const bySelf = resolveMaintainerPending(pending, runtime, code, CANDIDATE, OWNER, "approve");
  expect(bySelf.status).toBe("not-owner");
  expect(loadMaintainers(runtime, bundled).has(CANDIDATE)).toBe(false);

  // The real owner can still spend the surviving code.
  const byOwner = resolveMaintainerPending(pending, runtime, code, OWNER, OWNER, "approve");
  expect(byOwner.status).toBe("approved");
  expect(loadMaintainers(runtime, bundled).has(CANDIDATE)).toBe(true);
});

test("with no owner configured, nobody can approve (fail-safe deny)", () => {
  const { runtime, bundled, pending } = tmp();
  const code = requestMaintainerGrant(pending, runtime, CANDIDATE, OWNER, bundled).code!;
  const r = resolveMaintainerPending(pending, runtime, code, ZOOM, undefined, "approve");
  expect(r.status).toBe("not-owner");
  expect(loadMaintainers(runtime, bundled).has(CANDIDATE)).toBe(false);
});

test("revoke removes a runtime grant but refuses bundled seed ids", () => {
  const { runtime, bundled, pending } = tmp();
  const code = requestMaintainerGrant(pending, runtime, CANDIDATE, OWNER, bundled).code!;
  resolveMaintainerPending(pending, runtime, code, OWNER, OWNER, "approve");
  expect(revokeMaintainer(runtime, CANDIDATE, bundled).ok).toBe(true);
  expect(loadMaintainers(runtime, bundled).has(CANDIDATE)).toBe(false);

  const r = revokeMaintainer(runtime, ZOOM, bundled);
  expect(r.ok).toBe(false);
  expect(r.status).toBe("bundled");
  expect(loadMaintainers(runtime, bundled).has(ZOOM)).toBe(true);
});
