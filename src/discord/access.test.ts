import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAccess, classify, grantAccess, revokeAccess, ACCESS_CAP } from "./access.ts";

describe("discord/access", () => {
  let testDir: string;
  let accessFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "access-test-"));
    accessFile = join(testDir, "access.txt");
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("loadAccess", () => {
    it("missing file => empty set, unlocked", () => {
      const r = loadAccess(accessFile);
      expect(r.ids.size).toBe(0);
      expect(r.locked).toBe(false);
    });

    it("parses IDs, ignores comments and blank lines", () => {
      const content = `# comment
123456

789012
# another comment

345678
`;
      Bun.write(accessFile, content);
      const r = loadAccess(accessFile);
      expect(r.ids.size).toBe(3);
      expect(r.ids.has("123456")).toBe(true);
      expect(r.ids.has("789012")).toBe(true);
      expect(r.ids.has("345678")).toBe(true);
    });

    it("strips whitespace from IDs", () => {
      Bun.write(accessFile, "  111111  \n222222\n");
      const r = loadAccess(accessFile);
      expect(r.ids.has("111111")).toBe(true);
      expect(r.ids.has("222222")).toBe(true);
    });

    it("locked = true if .lock sentinel exists", () => {
      Bun.write(accessFile, "123456\n");
      Bun.write(`${accessFile}.lock`, "locked\n");
      const r = loadAccess(accessFile);
      expect(r.locked).toBe(true);
    });

    it("locked = true if count >= ACCESS_CAP", () => {
      const ids = Array.from({ length: ACCESS_CAP }, (_, i) => `${100000 + i}`);
      Bun.write(accessFile, ids.join("\n") + "\n");
      const r = loadAccess(accessFile);
      expect(r.ids.size).toBe(ACCESS_CAP);
      expect(r.locked).toBe(true);
    });

    it("never throws on read errors", () => {
      // non-existent file
      expect(() => loadAccess("/nonexistent/path/to/access.txt")).not.toThrow();
    });
  });

  describe("classify", () => {
    it("owner match => 'owner'", () => {
      const access = { ids: new Set<string>(), locked: false };
      expect(classify("999999", "999999", access)).toBe("owner");
    });

    it("in access set => 'member'", () => {
      const access = { ids: new Set(["123456"]), locked: false };
      expect(classify("123456", "999999", access)).toBe("member");
    });

    it("else => 'outsider'", () => {
      const access = { ids: new Set(["123456"]), locked: false };
      expect(classify("888888", "999999", access)).toBe("outsider");
    });

    it("FAIL-SAFE: empty ownerId => outsider for unknown user", () => {
      const access = { ids: new Set<string>(), locked: false };
      expect(classify("123456", undefined, access)).toBe("outsider");
      expect(classify("123456", "", access)).toBe("outsider");
    });

    it("FAIL-SAFE: but known member still gets through even if ownerId undefined", () => {
      const access = { ids: new Set(["123456"]), locked: false };
      expect(classify("123456", undefined, access)).toBe("member");
    });
  });

  describe("grantAccess", () => {
    it("rejects invalid (non-digit) IDs", () => {
      const r = grantAccess(accessFile, "not-a-snowflake", "999999");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("invalid-id");
    });

    it("rejects IDs with letters", () => {
      const r = grantAccess(accessFile, "123abc456", "999999");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("invalid-id");
    });

    it("owner ID => 'is-owner' (no-op, ok:true)", () => {
      const r = grantAccess(accessFile, "999999", "999999");
      expect(r.ok).toBe(true);
      expect(r.status).toBe("is-owner");
      expect(existsSync(accessFile)).toBe(false); // never written
    });

    it("already-member => 'already-member' (ok:true)", () => {
      Bun.write(accessFile, "123456\n");
      const r = grantAccess(accessFile, "123456", "999999");
      expect(r.ok).toBe(true);
      expect(r.status).toBe("already-member");
    });

    it("locked => 'locked' (ok:false)", () => {
      Bun.write(accessFile, "123456\n");
      Bun.write(`${accessFile}.lock`, "locked\n");
      const r = grantAccess(accessFile, "789012", "999999");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("locked");
    });

    it("appends new ID successfully", () => {
      const r = grantAccess(accessFile, "123456", "999999");
      expect(r.ok).toBe(true);
      expect(r.status).toBe("granted");
      expect(r.count).toBe(1);
      expect(r.locked).toBe(false);

      const content = readFileSync(accessFile, "utf8");
      expect(content).toContain("123456");
    });

    it("granting the 10th ID flips locked=true", () => {
      // add 9 IDs
      for (let i = 1; i <= 9; i++) {
        const r = grantAccess(accessFile, `${100000 + i}`, "999999");
        expect(r.ok).toBe(true);
        expect(r.locked).toBe(false);
      }

      // grant the 10th
      const r10 = grantAccess(accessFile, "200000", "999999");
      expect(r10.ok).toBe(true);
      expect(r10.status).toBe("granted");
      expect(r10.count).toBe(10);
      expect(r10.locked).toBe(true);

      // check the lock sentinel exists
      expect(existsSync(`${accessFile}.lock`)).toBe(true);

      // check the file is read-only (chmod to 0o444)
      const stats = statSync(accessFile);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o444);
    });

    it("11th grant fails with 'locked'", () => {
      // add 10 IDs
      for (let i = 1; i <= 10; i++) {
        grantAccess(accessFile, `${100000 + i}`, "999999");
      }

      // try an 11th
      const r11 = grantAccess(accessFile, "300000", "999999");
      expect(r11.ok).toBe(false);
      expect(r11.status).toBe("locked");
    });
  });

  describe("revokeAccess", () => {
    it("removes an ID from the list", () => {
      Bun.write(accessFile, "123456\n789012\n");
      const r = revokeAccess(accessFile, "123456");
      expect(r.ok).toBe(true);
      expect(r.status).toBe("revoked");
      expect(r.count).toBe(1);

      const content = readFileSync(accessFile, "utf8");
      expect(content).not.toContain("123456");
      expect(content).toContain("789012");
    });

    it("not-member => 'not-member' (ok:true, no-op)", () => {
      Bun.write(accessFile, "123456\n");
      const r = revokeAccess(accessFile, "999999");
      expect(r.ok).toBe(true);
      expect(r.status).toBe("not-member");
    });

    it("preserves comments and blank lines", () => {
      const content = `# top comment
123456

789012
# bottom comment
`;
      Bun.write(accessFile, content);
      revokeAccess(accessFile, "123456");
      const after = readFileSync(accessFile, "utf8");
      expect(after).toContain("# top comment");
      expect(after).toContain("# bottom comment");
      expect(after).toContain("789012");
      expect(after).not.toContain("123456");
    });

    it("locked => refuses (ok:false, 'locked')", () => {
      Bun.write(accessFile, "123456\n");
      Bun.write(`${accessFile}.lock`, "locked\n");
      const r = revokeAccess(accessFile, "123456");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("locked");
      expect(r.locked).toBe(true);
    });
  });

  describe("lock behavior integration", () => {
    it("loadAccess sees locked=true after the 10th grant", () => {
      for (let i = 1; i <= 10; i++) {
        grantAccess(accessFile, `${100000 + i}`, "999999");
      }

      const access = loadAccess(accessFile);
      expect(access.locked).toBe(true);
    });

    it("revoke refuses when locked", () => {
      for (let i = 1; i <= 10; i++) {
        grantAccess(accessFile, `${100000 + i}`, "999999");
      }

      const r = revokeAccess(accessFile, "100001");
      expect(r.ok).toBe(false);
      expect(r.status).toBe("locked");

      // ID still present
      const access = loadAccess(accessFile);
      expect(access.ids.has("100001")).toBe(true);
    });
  });
});
