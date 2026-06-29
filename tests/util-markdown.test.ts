/**
 * Beckett — shared markdown util tests (`tests/util-markdown.test.ts`)
 * =======================================================================================
 * Guards the Phase-A consolidation: one listMarkdownFiles + one splitFrontmatter replacing the
 * three near-copies in memory / cli / skills. The key assertion is that the parameterized
 * helper reproduces each former caller's EXACT behavior — including where they differed
 * (memory excludes the top-level rel "MEMORY.md" + ".git"; cli excludes the basename anywhere;
 * skills is non-recursive).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { listMarkdownFiles, splitFrontmatter } from "../src/util/markdown.ts";

const ROOT = join(process.env.BECKETT_TEST_SCRATCH || join(tmpdir(), "beckett-test-scratch"), "util-md");

/** Results as root-relative paths, sorted — readdir order is not guaranteed. */
function rels(paths: string[]): string[] {
  return paths.map((p) => relative(ROOT, p).split("\\").join("/")).sort();
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "sub"), { recursive: true });
  mkdirSync(join(ROOT, ".git"), { recursive: true });
  writeFileSync(join(ROOT, "a.md"), "A");
  writeFileSync(join(ROOT, "MEMORY.md"), "INDEX");
  writeFileSync(join(ROOT, "sub", "b.md"), "B");
  writeFileSync(join(ROOT, "sub", "MEMORY.md"), "NESTED-INDEX");
  writeFileSync(join(ROOT, ".git", "c.md"), "GITFILE");
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("missing dir → []", () => {
  expect(listMarkdownFiles(join(ROOT, "nope"))).toEqual([]);
});

test("memory mode: recursive, exact-rel MEMORY.md + .git excluded", () => {
  const got = rels(
    listMarkdownFiles(ROOT, { recursive: true, excludeRels: ["MEMORY.md"], excludeDirSegments: [".git"] }),
  );
  // Top-level MEMORY.md gone; .git gone; but nested sub/MEMORY.md KEPT (exact-rel, not basename).
  expect(got).toEqual(["a.md", "sub/MEMORY.md", "sub/b.md"]);
});

test("cli mode: recursive, basename MEMORY.md excluded (any depth), no .git filter", () => {
  const got = rels(listMarkdownFiles(ROOT, { recursive: true, excludeBasenames: ["MEMORY.md"] }));
  // Both MEMORY.md gone (basename); .git/c.md KEPT (cli never filtered it).
  expect(got).toEqual([".git/c.md", "a.md", "sub/b.md"]);
});

test("skills mode: non-recursive top-level only, no exclusions", () => {
  const got = rels(listMarkdownFiles(ROOT, { recursive: false }));
  expect(got).toEqual(["MEMORY.md", "a.md"]);
});

test("splitFrontmatter: fenced block + body", () => {
  expect(splitFrontmatter("---\nname: x\n---\nbody here")).toEqual({
    frontmatter: "name: x",
    body: "body here",
  });
});

test("splitFrontmatter: no fence → empty frontmatter, whole body", () => {
  expect(splitFrontmatter("just text")).toEqual({ frontmatter: "", body: "just text" });
});

test("splitFrontmatter: tolerates CRLF and a leading BOM", () => {
  expect(splitFrontmatter("---\r\nk: v\r\n---\r\nb")).toEqual({ frontmatter: "k: v", body: "b" });
  expect(splitFrontmatter("﻿---\nk: v\n---\nb")).toEqual({ frontmatter: "k: v", body: "b" });
});
