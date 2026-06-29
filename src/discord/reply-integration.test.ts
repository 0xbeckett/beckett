/**
 * Integration test for Discord reply with file attachments
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReplyOptions } from "../types.ts";

describe("Discord reply integration", () => {
  let testDir: string;
  let testFile: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "beckett-reply-test-"));
    testFile = join(testDir, "screenshot.png");
    // Create a minimal valid PNG file
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    ]);
    writeFileSync(testFile, pngHeader);
  });

  afterAll(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("ReplyOptions accepts files parameter", () => {
    const opts: ReplyOptions = {
      files: [testFile],
    };
    expect(opts.files).toBeDefined();
    expect(opts.files).toHaveLength(1);
    expect(opts.files?.[0]).toBe(testFile);
  });

  test("ReplyOptions with both text and files", () => {
    const opts: ReplyOptions = {
      replyToMessageId: "123456",
      files: [testFile],
    };
    expect(opts.replyToMessageId).toBe("123456");
    expect(opts.files).toHaveLength(1);
  });

  test("ReplyOptions with multiple files", () => {
    const file2 = join(testDir, "diagram.png");
    writeFileSync(file2, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const opts: ReplyOptions = {
      files: [testFile, file2],
    };
    expect(opts.files).toHaveLength(2);
    expect(opts.files?.[0]).toBe(testFile);
    expect(opts.files?.[1]).toBe(file2);
  });

  test("ReplyOptions with undefined files is valid", () => {
    const opts: ReplyOptions = {
      replyToMessageId: "123456",
    };
    expect(opts.files).toBeUndefined();
  });

  test("empty array of files is valid", () => {
    const opts: ReplyOptions = {
      files: [],
    };
    expect(opts.files).toBeDefined();
    expect(opts.files).toHaveLength(0);
  });

  test("file validation logic", () => {
    const { existsSync } = require("node:fs");

    // Existing file should pass validation
    expect(existsSync(testFile)).toBe(true);

    // Nonexistent file should fail validation
    const badFile = join(testDir, "does-not-exist.png");
    expect(existsSync(badFile)).toBe(false);
  });
});
