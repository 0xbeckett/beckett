import { expect, test } from "bun:test";
import { diffStatSync, parseNumstat } from "./diff.ts";

test("parseNumstat accumulates added/removed and distinct paths", () => {
  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  parseNumstat("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n", acc);
  expect(acc.added).toBe(13);
  expect(acc.removed).toBe(1);
  expect(acc.paths.size).toBe(2);
});

test("parseNumstat counts binary rows as files with zero line delta", () => {
  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  parseNumstat("-\t-\tassets/logo.png\n2\t2\tsrc/a.ts\n", acc);
  expect(acc.added).toBe(2);
  expect(acc.removed).toBe(2);
  expect(acc.paths.size).toBe(2);
});

test("parseNumstat dedups a path seen in both unstaged and staged passes", () => {
  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  parseNumstat("3\t0\tsrc/a.ts\n", acc);
  parseNumstat("1\t1\tsrc/a.ts\n", acc); // second (staged) pass, same file
  expect(acc.paths.size).toBe(1);
  expect(acc.added).toBe(4);
});

test("parseNumstat keeps tabs inside a path intact and skips malformed rows", () => {
  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  parseNumstat("1\t0\tweird\tname.txt\nnot-a-numstat-row\n", acc);
  expect([...acc.paths]).toEqual(["weird\tname.txt"]);
  expect(acc.added).toBe(1);
});

test("diffStatSync is best-effort: no workspace / non-repo yields zeros, never throws", () => {
  expect(diffStatSync(null)).toEqual({ added: 0, removed: 0, files: 0 });
  expect(diffStatSync(undefined)).toEqual({ added: 0, removed: 0, files: 0 });
  expect(diffStatSync("/definitely/not/a/real/dir-xyz")).toEqual({ added: 0, removed: 0, files: 0 });
});
