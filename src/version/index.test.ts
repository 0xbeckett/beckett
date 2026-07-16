/**
 * Coverage for the version source-of-truth I/O and the deploy-time bump orchestration (OPS-188),
 * against a throwaway package.json + git repo. Pins: package.json is edited in place (formatting
 * preserved), the base is the newest vX.Y.Z tag, and MAJOR is override-only (resolveVersion never
 * yields a major without an explicit choice).
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVersion,
  writeVersion,
  lastDeployedVersion,
  commitsSinceVersion,
  computeBumpSuggestion,
  resolveVersion,
} from "./index.ts";
import { classifyBump } from "./semver.ts";

const git = async (args: string[], cwd: string): Promise<string> => {
  const p = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out;
};

/** Init a throwaway repo with signing disabled (some dev machines force signed/annotated tags). */
const initRepo = async (cwd: string): Promise<void> => {
  await git(["init", "-q", "-b", "main"], cwd);
  await git(["config", "user.email", "t@t.io"], cwd);
  await git(["config", "user.name", "t"], cwd);
  await git(["config", "commit.gpgSign", "false"], cwd);
  await git(["config", "tag.gpgSign", "false"], cwd);
  await git(["config", "tag.forceSignAnnotated", "false"], cwd);
};

/** Annotated tag at HEAD (works regardless of the host's lightweight-tag policy). */
const tag = async (cwd: string, name: string): Promise<void> => {
  await git(["tag", "-a", name, "-m", name], cwd);
};

describe("readVersion / writeVersion (source of truth)", () => {
  test("reads the version and rewrites it in place, preserving formatting", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "4.1.2",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(readVersion(dir)).toBe("4.1.2");
    writeVersion("4.2.0", dir);
    expect(readVersion(dir)).toBe("4.2.0");
    const after = readFileSync(join(dir, "package.json"), "utf8");
    // Only the version token changed — surrounding shape (keys, indent, trailing newline) intact.
    expect(after).toBe(`{\n  "name": "x",\n  "version": "4.2.0",\n  "type": "module"\n}\n`);
  });

  test("rejects a non-semver version on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    writeFileSync(join(dir, "package.json"), `{\n  "version": "1.0.0"\n}\n`);
    expect(() => writeVersion("banana", dir)).toThrow();
  });
});

describe("resolveVersion (MAJOR is override-only)", () => {
  const patchSuggestion = classifyBump(["fix: a thing"]);

  test("no override → uses the auto-suggested level", () => {
    expect(resolveVersion("4.1.2", patchSuggestion)).toEqual({ version: "4.1.3", level: "patch" });
  });
  test("explicit --minor override", () => {
    expect(resolveVersion("4.1.2", patchSuggestion, "minor")).toEqual({ version: "4.2.0", level: "minor" });
  });
  test("MAJOR only via an explicit override, never from the suggestion", () => {
    // The suggestion here is patch; the ONLY way to reach a major is the explicit choice.
    expect(resolveVersion("4.1.2", patchSuggestion, "major")).toEqual({ version: "5.0.0", level: "major" });
    // Auto path can never be major regardless of the base.
    expect(resolveVersion("4.1.2", patchSuggestion).level).not.toBe("major");
  });
  test("an explicit target version infers the level it moved", () => {
    expect(resolveVersion("4.1.2", patchSuggestion, "6.0.0")).toEqual({ version: "6.0.0", level: "major" });
    expect(resolveVersion("4.1.2", patchSuggestion, "4.3.0")).toEqual({ version: "4.3.0", level: "minor" });
  });
});

describe("git-backed base + commits + suggestion", () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "beckett-verrepo-"));
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    // v4.1.2 is the "last deployed" tag.
    writeFileSync(join(repo, "package.json"), `{\n  "version": "4.1.2"\n}\n`);
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "release v4.1.2"], repo);
    await tag(repo, "v4.1.2");
    // An older tag, to prove sort picks the newest.
    await tag(repo, "v3.6.1");
    // Two feature commits merged since.
    writeFileSync(join(repo, "a"), "1");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "fix: tidy a wart"], repo);
    writeFileSync(join(repo, "b"), "2");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "feat: add a shiny new capability"], repo);
  });

  test("lastDeployedVersion picks the newest vX.Y.Z tag", async () => {
    expect(await lastDeployedVersion(repo)).toBe("4.1.2");
  });

  test("commitsSinceVersion lists what merged since the tag, newest first", async () => {
    expect(await commitsSinceVersion(repo, "4.1.2")).toEqual([
      "feat: add a shiny new capability",
      "fix: tidy a wart",
    ]);
  });

  test("computeBumpSuggestion → MINOR from the feature commit, base = the tag", async () => {
    const s = await computeBumpSuggestion(repo);
    expect(s.base).toBe("4.1.2");
    expect(s.fromTag).toBe(true);
    expect(s.suggestion.level).toBe("minor");
    expect(s.suggested).toBe("4.2.0");
    expect(s.commits).toContain("feat: add a shiny new capability");
  });

  test("no tags → base falls back to package.json, never throws", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "beckett-verrepo2-"));
    mkdirSync(fresh, { recursive: true });
    await initRepo(fresh);
    writeFileSync(join(fresh, "package.json"), `{\n  "version": "0.1.0"\n}\n`);
    await git(["add", "-A"], fresh);
    await git(["commit", "-q", "-m", "fix: initial"], fresh);
    expect(await lastDeployedVersion(fresh)).toBeNull();
    const s = await computeBumpSuggestion(fresh);
    expect(s.base).toBe("0.1.0");
    expect(s.fromTag).toBe(false);
  });
});
