import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ACCESS_CAP, classify, grantAccess, loadAccess, revokeAccess } from "./access.ts";

describe("discord/access red-team", () => {
  let testDir: string;
  let accessFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "access-redteam-"));
    accessFile = join(testDir, "access.txt");
  });

  afterEach(() => {
    chmodSync(testDir, 0o755);
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("bypass attempts", () => {
    it("unknown users stay outsiders when owner id is unset, empty, or whitespace-like", () => {
      const access = { ids: new Set<string>(), locked: false };

      expect(classify("123456", undefined, access)).toBe("outsider");
      expect(classify("123456", "", access)).toBe("outsider");
      expect(classify("123456", " ", access)).toBe("outsider");
    });

    it("only an exact owner id match becomes owner; substrings and whitespace do not", () => {
      const access = { ids: new Set(["222222"]), locked: false };

      expect(classify("111111", "111111", access)).toBe("owner");
      expect(classify("111111\n222222", "111111", access)).toBe("outsider");
      expect(classify(" 111111 ", "111111", access)).toBe("outsider");
      expect(classify("222222", "111111", access)).toBe("member");
    });
  });

  describe("cap overflow attempts", () => {
    it("locks exactly on the 10th grant and refuses the 11th", () => {
      for (let i = 0; i < ACCESS_CAP; i++) {
        const result = grantAccess(accessFile, String(100000 + i), "999999");
        expect(result.ok).toBe(true);
        expect(result.count).toBe(i + 1);
        expect(result.locked).toBe(i + 1 === ACCESS_CAP);
      }

      expect(loadAccess(accessFile).ids.size).toBe(ACCESS_CAP);
      expect(loadAccess(accessFile).locked).toBe(true);
      expect(existsSync(`${accessFile}.lock`)).toBe(true);

      const overflow = grantAccess(accessFile, "200000", "999999");
      expect(overflow.ok).toBe(false);
      expect(overflow.status).toBe("locked");
      expect(loadAccess(accessFile).ids.size).toBe(ACCESS_CAP);
    });

    it("refuses grants when the lock sentinel is deleted but the file already has 10 ids", () => {
      const ids = Array.from({ length: ACCESS_CAP }, (_, i) => String(300000 + i));
      writeFileSync(accessFile, `${ids.join("\n")}\n`, "utf8");

      const result = grantAccess(accessFile, "400000", "999999");

      expect(result.ok).toBe(false);
      expect(result.status).toBe("locked");
      expect(result.count).toBe(ACCESS_CAP);
      expect(readFileSync(accessFile, "utf8")).not.toContain("400000");
    });

    it("grantAccess is single-writer check-then-append (no interprocess lock — accepted: the parent is the only granter)", () => {
      const source = readFileSync(resolve(import.meta.dir, "access.ts"), "utf8");
      const grantStart = source.indexOf("export function grantAccess");
      const grantEnd = source.indexOf("export type RevokeStatus");
      const grantSource = source.slice(grantStart, grantEnd);

      expect(grantSource).toContain("const access = loadAccess(accessFile);");
      expect(grantSource).toContain("appendFileSync(accessFile");
      expect(grantSource.indexOf("const access = loadAccess(accessFile);")).toBeLessThan(
        grantSource.indexOf("appendFileSync(accessFile"),
      );
      expect(grantSource).not.toContain("renameSync");
      expect(grantSource).not.toContain("openSync");
      expect(grantSource).not.toContain("flock");
    });
  });

  describe("owner lockout attempts", () => {
    it("owner remains owner even when the list is locked and contains malformed state", () => {
      writeFileSync(accessFile, Array.from({ length: ACCESS_CAP }, (_, i) => String(500000 + i)).join("\n"), "utf8");
      writeFileSync(`${accessFile}.lock`, "locked\n", "utf8");

      const access = loadAccess(accessFile);

      expect(access.locked).toBe(true);
      expect(classify("999999", "999999", access)).toBe("owner");
    });

    it("granting the owner id is a no-op and does not write the owner into access.txt", () => {
      const result = grantAccess(accessFile, "999999", "999999");

      expect(result.ok).toBe(true);
      expect(result.status).toBe("is-owner");
      expect(existsSync(accessFile)).toBe(false);
    });
  });

  describe("id injection attempts", () => {
    const maliciousIds = [
      "123\n456",
      "123 456",
      "../123456",
      "#123456",
      "123456 # smuggled comment",
      "123456\t789",
      "",
    ];

    it.each(maliciousIds)("grant rejects malformed id %p without writing access.txt", (id) => {
      const result = grantAccess(accessFile, id, "999999");

      expect(result.ok).toBe(false);
      expect(result.status).toBe("invalid-id");
      expect(existsSync(accessFile)).toBe(false);
    });

    it("grant accepts only digits and writes exactly one line", () => {
      const result = grantAccess(accessFile, "1234567890", "999999");

      expect(result.ok).toBe(true);
      expect(readFileSync(accessFile, "utf8")).toBe("1234567890\n");
    });

    it("grant rejects an arbitrarily long all-digit id (bounded length, FIXED)", () => {
      const veryLongDigits = "9".repeat(10_000);

      const result = grantAccess(accessFile, veryLongDigits, "999999");

      expect(result.ok).toBe(false);
      expect(result.status).toBe("invalid-id");
      expect(existsSync(accessFile)).toBe(false);
    });
  });

  describe("enforcement reality", () => {
    it("Discord injection still forwards outsider messages to the parent with only a bouncer directive", () => {
      const mainSource = readFileSync(resolve(import.meta.dir, "../shell/main.ts"), "utf8");

      expect(mainSource).toContain("const level = classify(m.userId, ownerId, access);");
      expect(mainSource).toContain('level === "outsider"');
      expect(mainSource).toContain("parent.inject(full);");
      expect(mainSource).toContain("BOUNCER MODE");
      expect(mainSource).not.toContain("if (level === \"outsider\") return");
    });
  });

  describe("parse/state attacks", () => {
    it("loadAccess ignores malformed non-digit lines (fail-safe parse, FIXED)", () => {
      writeFileSync(accessFile, "not-a-snowflake\n../123\n123456 # comment\n789012\n", "utf8");

      const access = loadAccess(accessFile);

      // malformed lines are dropped — never trusted as members
      expect(access.ids.has("not-a-snowflake")).toBe(false);
      expect(access.ids.has("../123")).toBe(false);
      expect(access.ids.has("123456 # comment")).toBe(false);
      expect(classify("not-a-snowflake", "999999", access)).toBe("outsider");
      // a clean digit line is still accepted
      expect(access.ids.has("789012")).toBe(true);
      expect(classify("789012", "999999", access)).toBe("member");
    });

    it("handles a UTF-8 BOM before the first id", () => {
      writeFileSync(accessFile, "\uFEFF123456\n", "utf8");

      const access = loadAccess(accessFile);

      expect(access.ids.has("123456")).toBe(true);
      expect(access.ids.has("\uFEFF123456")).toBe(false);
      expect(classify("123456", "999999", access)).toBe("member");
    });

    it("deduplicates duplicate ids for cap counting and revoke removes all duplicate lines", () => {
      writeFileSync(accessFile, "123456\n123456\n789012\n", "utf8");

      const before = loadAccess(accessFile);
      expect(before.ids.size).toBe(2);

      const result = revokeAccess(accessFile, "123456");

      expect(result.ok).toBe(true);
      expect(result.status).toBe("revoked");
      expect(result.count).toBe(1);
      expect(readFileSync(accessFile, "utf8")).not.toContain("123456");
      expect(loadAccess(accessFile).ids.has("789012")).toBe(true);
    });

    it("preserves comments, blank lines, and unrelated whitespace while revoking", () => {
      writeFileSync(accessFile, "# keep\n\n 123456 \n789012\n", "utf8");

      const result = revokeAccess(accessFile, "123456");

      expect(result.ok).toBe(true);
      expect(readFileSync(accessFile, "utf8")).toContain("# keep\n\n");
      expect(loadAccess(accessFile).ids.has("789012")).toBe(true);
      expect(loadAccess(accessFile).ids.has("123456")).toBe(false);
    });
  });
});
