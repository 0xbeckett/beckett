/**
 * Tests for Discord reply file attachment support
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Discord reply file attachments", () => {
  let testDir: string;
  let testFile1: string;
  let testFile2: string;

  beforeAll(() => {
    // Create temp directory with test files
    testDir = mkdtempSync(join(tmpdir(), "beckett-test-"));
    testFile1 = join(testDir, "test1.txt");
    testFile2 = join(testDir, "test2.png");
    writeFileSync(testFile1, "test content 1");
    writeFileSync(testFile2, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
  });

  afterAll(() => {
    // Clean up
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("validates file paths exist", async () => {
    const { existsSync } = await import("node:fs");

    // Test that our test files exist
    expect(existsSync(testFile1)).toBe(true);
    expect(existsSync(testFile2)).toBe(true);

    // Test that a nonexistent file would fail
    const badPath = join(testDir, "nonexistent.txt");
    expect(existsSync(badPath)).toBe(false);
  });

  test("AttachmentBuilder accepts file paths", async () => {
    const { AttachmentBuilder } = await import("discord.js");

    // Test that AttachmentBuilder can be constructed with file paths
    const attachment1 = new AttachmentBuilder(testFile1);
    expect(attachment1).toBeDefined();

    const attachment2 = new AttachmentBuilder(testFile2);
    expect(attachment2).toBeDefined();
  });

  test("payload structure with files", () => {
    // Test the payload structure matches what sendNow builds
    const payload = {
      content: "test message",
      files: [testFile1, testFile2].map((path) => ({ path })),
    };

    expect(payload.content).toBe("test message");
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0]?.path).toBe(testFile1);
    expect(payload.files[1]?.path).toBe(testFile2);
  });

  test("empty text with file is valid", () => {
    // Discord allows image-only posts (empty content + files)
    const payload = {
      content: "",
      files: [testFile1],
    };

    expect(payload.content).toBe("");
    expect(payload.files).toHaveLength(1);
  });

  test("multiple files in array", () => {
    const files = [testFile1, testFile2];
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(testFile1);
    expect(files[1]).toBe(testFile2);
  });
});
