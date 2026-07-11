import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubBranchCardReader } from "../github/types.ts";
import { BranchStatusService } from "./status.ts";
import { TaskStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-branch-status-"));
  dirs.push(dir);
  return new TaskStore(join(dir, "tasks.json"));
}

test("local branch status returns aggregate persisted counts without a patch", async () => {
  const tasks = store();
  await tasks.createTask({ title: "Voting", project: "polls" });
  await tasks.setGit("1.1", { project: "polls", gitRef: "beckett/1-1-voting" });
  await tasks.setDiff("1.1", { additions: 34, deletions: 8, files: 3, commits: 2 });

  const card = await new BranchStatusService({ store: tasks, githubOwner: "0xbeckett" }).read("#1.1");
  expect(card).toMatchObject({
    ref: "1.1",
    source: "local",
    repo: "0xbeckett/polls",
    gitRef: "beckett/1-1-voting",
    changes: { additions: 34, deletions: 8, files: 3, commits: 2 },
  });
  expect(card).not.toHaveProperty("diff");
});

test("published branch status uses one GitHub aggregate including checks, reviews, and comments", async () => {
  const tasks = store();
  await tasks.createTask({ title: "Voting", project: "polls" });
  await tasks.setPullRequest("1.1", {
    repo: "0xbeckett/polls",
    number: 42,
    url: "https://github.com/0xbeckett/polls/pull/42",
  });
  const calls: Array<[string, string | number]> = [];
  const github: GitHubBranchCardReader = {
    branchCard: async (repo, ref) => {
      calls.push([repo, ref]);
      return {
        repo,
        number: 42,
        url: "https://github.com/0xbeckett/polls/pull/42",
        title: "Voting",
        state: "OPEN",
        isDraft: false,
        headRefName: "beckett/1-1-voting",
        baseRefName: "main",
        headRefOid: "abc123",
        updatedAt: "2026-07-12T00:00:00.000Z",
        additions: 120,
        deletions: 11,
        changedFiles: 5,
        commits: 3,
        reviewDecision: "APPROVED",
        reviewCount: 2,
        commentCount: 4,
        checks: { total: 6, passed: 6, pending: 0, failed: 0, skipped: 0, conclusion: "SUCCESS" },
      };
    },
  };

  const card = await new BranchStatusService({ store: tasks, github }).read("1.1");
  expect(calls).toEqual([["0xbeckett/polls", 42]]);
  expect(card).toMatchObject({
    source: "pull_request",
    changes: { additions: 120, deletions: 11, files: 5, commits: 3 },
    checks: { passed: 6, failed: 0 },
    review: { decision: "APPROVED", count: 2 },
    discussion: { comments: 4 },
  });
});

test("direct-pushed branch is reported as published after its worktree is gone", async () => {
  const tasks = store();
  await tasks.createTask({ title: "Voting", project: "polls" });
  await tasks.setDiff("1.1", { additions: 8, deletions: 2, files: 2, commits: 1 });
  await tasks.setPublication("1.1", {
    repo: "0xbeckett/polls",
    url: "https://github.com/0xbeckett/polls",
    kind: "pushed",
  });

  const card = await new BranchStatusService({ store: tasks }).read("1.1");
  expect(card).toMatchObject({
    source: "published",
    repo: "0xbeckett/polls",
    publication: { url: "https://github.com/0xbeckett/polls", kind: "pushed" },
    changes: { additions: 8, deletions: 2, files: 2, commits: 1 },
  });
});

test("a pre-publish snapshot wins over a still-live worktree after its direct-push rebase", async () => {
  const tasks = store();
  const workspace = mkdtempSync(join(tmpdir(), "beckett-rebased-worktree-"));
  dirs.push(workspace);
  await tasks.createTask({ title: "Voting", project: "polls" });
  await tasks.setGit("1.1", { project: "polls", workspace, baseSha: "base-before-parallel-main" });
  await tasks.setDiff("1.1", { additions: 4, deletions: 1, files: 2, commits: 1 });
  await tasks.setPublication("1.1", {
    repo: "0xbeckett/polls",
    url: "https://github.com/0xbeckett/polls",
    kind: "pushed",
  });
  let liveReads = 0;

  const card = await new BranchStatusService({
    store: tasks,
    localStats: async () => {
      liveReads++;
      return { additions: 11, deletions: 3, changedFiles: 5, commits: 2 };
    },
  }).read("1.1");

  expect(liveReads).toBe(0);
  expect(card.changes).toEqual({ additions: 4, deletions: 1, files: 2, commits: 1 });
});
