/**
 * Coverage for the restart "what's new" changelog helpers: the SYSTEM release-note framing, the
 * announced-sha state file, and the commits-since-a-sha derivation (against a throwaway git repo).
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  buildReleaseNote,
  readAnnouncedSha,
  writeAnnouncedSha,
  commitSubjectsSince,
  currentGitSha,
} from "./index.ts";

describe("buildReleaseNote", () => {
  test("frames a SYSTEM turn that routes through beckett discord reply --channel", () => {
    const note = buildReleaseNote("999", ["chunk: split on blank lines", "federation: peers"]);
    expect(note).toContain("SYSTEM (release note");
    expect(note).toContain("beckett discord reply --channel 999");
    expect(note).toContain("- chunk: split on blank lines");
    expect(note).toContain("- federation: peers");
    expect(note.toLowerCase()).toContain("your gen-z voice");
  });

  test("instructs a funny/witty/self-aware tone, not a dry changelog", () => {
    const note = buildReleaseNote("999", ["x"]).toLowerCase();
    expect(note).toContain("funny");
    expect(note).toContain("witty");
    expect(note).toContain("stupid");
    expect(note).toContain("not a dry list");
  });

  test("stamps the CURRENT version from package.json as a Discord -# subheader tail", () => {
    const note = buildReleaseNote("999", ["x"]);
    expect(note).toContain(`-# beckett v${pkg.version}`);
    // The version must be read dynamically, never a literal — the live pkg version must appear.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("leads with the version front-and-center as a big header + a readable what-changed summary (OPS-188)", () => {
    const note = buildReleaseNote("999", ["x"]);
    // The message must OPEN with the version as a loud Discord header (## …), not bury it in the tail.
    expect(note).toContain(`## beckett v${pkg.version}`);
    expect(note.toLowerCase()).toContain("open with the version front and center");
    // …and it must ask for a readable summary of what changed (the "what's new"), not just commits.
    expect(note.toLowerCase()).toContain("readable summary");
    expect(note.toLowerCase()).toContain("what's new");
  });

  test("instructs the 'we're so back' sign-off three times, before the version subheader", () => {
    const note = buildReleaseNote("999", ["x"]);
    expect(note.toLowerCase()).toContain("we're so back");
    expect(note.toLowerCase()).toContain("three");
    // The modeled tail: three sign-offs then the version subheader as the very last line.
    const tail = `  we're so back\n  we're so back\n  we're so back\n  -# beckett v${pkg.version}\n`;
    expect(note).toContain(tail);
  });
});

describe("announced-sha state file", () => {
  test("missing file reads as empty; write then read round-trips", () => {
    const f = join(mkdtempSync(join(tmpdir(), "beckett-ann-")), "announced.txt");
    expect(readAnnouncedSha(f)).toBe("");
    writeAnnouncedSha(f, "abc123");
    expect(readAnnouncedSha(f)).toBe("abc123");
  });
});

describe("commitSubjectsSince (real git)", () => {
  let repo: string;
  let firstSha = "";

  const git = async (args: string[], cwd: string): Promise<string> => {
    const p = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return out;
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "beckett-gitrepo-"));
    mkdirSync(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"], repo);
    await git(["config", "user.email", "t@t.io"], repo);
    await git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a"), "1");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "first commit"], repo);
    firstSha = await git(["rev-parse", "HEAD"], repo);
    writeFileSync(join(repo, "b"), "2");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "second commit"], repo);
    writeFileSync(join(repo, "c"), "3");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "third commit"], repo);
  });

  test("empty since → just the latest commit", async () => {
    expect(await commitSubjectsSince(repo, "", 20)).toEqual(["third commit"]);
  });

  test("since the first commit → the two later ones, newest first", async () => {
    expect(await commitSubjectsSince(repo, firstSha, 20)).toEqual(["third commit", "second commit"]);
  });

  test("max bounds the count", async () => {
    expect(await commitSubjectsSince(repo, firstSha, 1)).toEqual(["third commit"]);
  });

  test("a bad/unrelated sha falls back to the latest commit (never throws)", async () => {
    expect(await commitSubjectsSince(repo, "0000000000000000000000000000000000000000", 20)).toEqual([
      "third commit",
    ]);
  });

  test("currentGitSha returns HEAD", async () => {
    expect(await currentGitSha(repo)).toBe(await git(["rev-parse", "HEAD"], repo));
  });
});
