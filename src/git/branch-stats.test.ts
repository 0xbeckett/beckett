import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalBranchStats } from "./branch-stats.ts";

let repo: string;

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString();
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "beckett-branch-stats-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Beckett Test"]);
  git(["config", "user.email", "beckett@example.test"]);
  writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "delete-me.txt"), "gone\n");
  commit("base");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("readLocalBranchStats", () => {
  test("counts committed, staged, unstaged, and untracked changes without mutating the index", async () => {
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "committed.txt"), "alpha\nbeta\n");
    commit("branch commit");

    writeFileSync(join(repo, "tracked.txt"), "one\nchanged\nextra\n");
    unlinkSync(join(repo, "delete-me.txt"));
    git(["add", "delete-me.txt"]); // staged deletion
    writeFileSync(join(repo, "untracked.txt"), "new\nlines\nhere\n");
    const statusBefore = git(["status", "--porcelain=v1", "-z"]);

    expect(await readLocalBranchStats(repo, base)).toEqual({
      additions: 7,
      deletions: 2,
      changedFiles: 4,
      commits: 1,
    });
    expect(git(["status", "--porcelain=v1", "-z"])).toBe(statusBefore);
  });

  test("counts an untracked binary as a changed file with no invented line delta", async () => {
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "asset.bin"), Buffer.from([0, 1, 2, 3, 0]));
    expect(await readLocalBranchStats(repo, base)).toEqual({
      additions: 0,
      deletions: 0,
      changedFiles: 1,
      commits: 0,
    });
  });

  test("rejects an unknown base instead of returning misleading zeroes", async () => {
    await expect(readLocalBranchStats(repo, "not-a-real-base")).rejects.toThrow(/rev-parse/);
  });
});
