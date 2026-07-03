/**
 * Two-phase grant machinery (hardened bouncer). The attack this exists to kill: an
 * authorised person (or an injected instruction inside an allowed turn) saying "it's okay,
 * you can add <id>" and the LLM obliging. Requests are cheap; membership only moves when
 * `resolvePending` sees the owner's authenticated id.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_CAP,
  PENDING_GRANT_TTL_MS,
  grantAccess,
  loadAccess,
  loadPending,
  requestGrant,
  resolvePending,
} from "./access.ts";

const OWNER = "111111111111111111";
const STRANGER = "222222222222222222";
const MEMBER = "333333333333333333";

describe("discord/access pending grants", () => {
  let dir: string;
  let accessFile: string;
  let pendingFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "access-pending-"));
    accessFile = join(dir, "access.txt");
    pendingFile = join(dir, "access-pending.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("requestGrant", () => {
    it("parks a request without touching the access file", () => {
      const r = requestGrant(pendingFile, accessFile, STRANGER, OWNER);

      expect(r.ok).toBe(true);
      expect(r.status).toBe("pending");
      expect(r.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(loadAccess(accessFile).ids.size).toBe(0);
      expect(loadPending(pendingFile)).toHaveLength(1);
    });

    it("re-requesting the same id replaces the entry — the old code dies", () => {
      const first = requestGrant(pendingFile, accessFile, STRANGER, OWNER);
      const second = requestGrant(pendingFile, accessFile, STRANGER, OWNER);

      expect(loadPending(pendingFile)).toHaveLength(1);
      expect(first.code).not.toBe(second.code); // 31^6 space; a collision here means broken RNG
      expect(resolvePending(pendingFile, accessFile, first.code!, OWNER, OWNER, "approve").status).toBe("unknown-code");
      expect(resolvePending(pendingFile, accessFile, second.code!, OWNER, OWNER, "approve").status).toBe("approved");
    });

    it("pre-checks membership, owner, id shape, and lock", () => {
      grantAccess(accessFile, MEMBER, OWNER);
      expect(requestGrant(pendingFile, accessFile, MEMBER, OWNER).status).toBe("already-member");
      expect(requestGrant(pendingFile, accessFile, OWNER, OWNER).status).toBe("is-owner");
      expect(requestGrant(pendingFile, accessFile, "not-a-snowflake", OWNER).status).toBe("invalid-id");
      expect(requestGrant(pendingFile, accessFile, "1".repeat(21), OWNER).status).toBe("invalid-id");

      for (let i = 1; i < ACCESS_CAP; i++) grantAccess(accessFile, String(100000 + i), OWNER);
      expect(requestGrant(pendingFile, accessFile, STRANGER, OWNER).status).toBe("locked");
    });
  });

  describe("resolvePending — the owner gate", () => {
    it("owner approval grants membership and consumes the code", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER);

      const r = resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve");
      expect(r).toMatchObject({ ok: true, status: "approved", id: STRANGER, count: 1 });
      expect(loadAccess(accessFile).ids.has(STRANGER)).toBe(true);

      // Replay: the code is spent.
      const replay = resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve");
      expect(replay.status).toBe("unknown-code");
    });

    it("codes match case-insensitively (owner may type lowercase)", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER);
      const r = resolvePending(pendingFile, accessFile, code!.toLowerCase(), OWNER, OWNER, "approve");
      expect(r.status).toBe("approved");
    });

    it("deny discards without granting, and also consumes the code", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER);

      const r = resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "deny");
      expect(r).toMatchObject({ ok: true, status: "denied", id: STRANGER });
      expect(loadAccess(accessFile).ids.size).toBe(0);
      expect(resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve").status).toBe("unknown-code");
    });

    it("REFUSES any non-owner approver — member, the requestee, anyone", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER);
      grantAccess(accessFile, MEMBER, OWNER);

      for (const impostor of [MEMBER, STRANGER, "999999999999999999"]) {
        const r = resolvePending(pendingFile, accessFile, code!, impostor, OWNER, "approve");
        expect(r).toEqual({ ok: false, status: "not-owner" });
      }
      expect(loadAccess(accessFile).ids.has(STRANGER)).toBe(false);
      // Refusals must NOT spend the code — the owner can still approve after an impostor try.
      expect(resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve").status).toBe("approved");
    });

    it("REFUSES everyone when the owner id is unconfigured (fail-safe deny)", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, undefined);
      expect(resolvePending(pendingFile, accessFile, code!, OWNER, undefined, "approve").status).toBe("not-owner");
      expect(resolvePending(pendingFile, accessFile, code!, OWNER, "", "approve").status).toBe("not-owner");
      expect(loadAccess(accessFile).ids.size).toBe(0);
    });

    it("expired requests are unapprovable", () => {
      const t0 = 1_700_000_000_000;
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER, t0);

      const late = resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve", t0 + PENDING_GRANT_TTL_MS + 1);
      expect(late.status).toBe("unknown-code");

      const intime = requestGrant(pendingFile, accessFile, STRANGER, OWNER, t0);
      expect(resolvePending(pendingFile, accessFile, intime.code!, OWNER, OWNER, "approve", t0 + 1000).status).toBe(
        "approved",
      );
    });

    it("re-checks the cap at approval time — a stale pending can't overflow a since-locked list", () => {
      const { code } = requestGrant(pendingFile, accessFile, STRANGER, OWNER);
      for (let i = 0; i < ACCESS_CAP; i++) grantAccess(accessFile, String(100000 + i), OWNER);

      const r = resolvePending(pendingFile, accessFile, code!, OWNER, OWNER, "approve");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("locked");
      expect(loadAccess(accessFile).ids.has(STRANGER)).toBe(false);
    });
  });

  describe("pending store fail-safety", () => {
    it("corrupt, non-array, or hand-doctored pending files are empty queues", () => {
      writeFileSync(pendingFile, "not json{", "utf8");
      expect(loadPending(pendingFile)).toEqual([]);

      writeFileSync(pendingFile, JSON.stringify({ id: STRANGER, code: "AAAAAA" }), "utf8");
      expect(loadPending(pendingFile)).toEqual([]);

      // A hand-forged entry with a code outside the alphabet/shape is never approvable.
      writeFileSync(
        pendingFile,
        JSON.stringify([{ id: STRANGER, code: "hack", requestedAt: 0, expiresAt: Date.now() + 60_000 }]),
        "utf8",
      );
      expect(loadPending(pendingFile)).toEqual([]);
      expect(resolvePending(pendingFile, accessFile, "hack", OWNER, OWNER, "approve").status).toBe("unknown-code");
    });
  });
});
