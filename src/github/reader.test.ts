/**
 * Coverage for `GitHubCli.prSignals` (OPS-124): the single `gh pr view --json …` read the PR poller
 * diffs. The subprocess runner is injected, so JSON parsing + the CI rollup reduction are exercised
 * without touching live GitHub.
 */
import { expect, test } from "bun:test";
import { GitHubCli } from "../agency/index.ts";
import type { Logger } from "../types.ts";

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } } as unknown as Logger;

function cli(stdout: string, code = 0) {
  return new GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/tmp",
    logger: noopLog,
    run: async () => ({ code, stdout, stderr: code === 0 ? "" : "boom" }),
  });
}

function recordingCli(stdout: string, code = 0) {
  const calls: string[][] = [];
  const gh = new GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/tmp",
    logger: noopLog,
    run: async (cmd) => {
      calls.push(cmd);
      return { code, stdout, stderr: code === 0 ? "" : "boom" };
    },
  });
  return { gh, calls };
}

test("activity reads parse main commits and only merged pull requests through GitHubCli", async () => {
  const commits = cli(
    JSON.stringify([
      { sha: "abcdef123", author: { login: "zoom" }, commit: { message: "relay activity\n\nmore" } },
      { sha: "fedcba987", commit: { author: { name: "external" }, message: "fallback author" } },
    ]),
  );
  expect(await commits.mainCommits("0xbeckett/beckett", "main")).toEqual([
    { sha: "abcdef123", author: "zoom", message: "relay activity" },
    { sha: "fedcba987", author: "external", message: "fallback author" },
  ]);

  const prs = cli(
    JSON.stringify([
      { number: 100, title: "Relay", user: { login: "zoom" }, merged_at: "2026-07-11T00:00:00Z" },
      { number: 101, title: "Open then closed", user: { login: "ro" }, merged_at: null },
    ]),
  );
  expect(await prs.mergedPullRequests("0xbeckett/beckett")).toEqual([
    { number: 100, title: "Relay", author: "zoom", mergedAt: "2026-07-11T00:00:00Z" },
  ]);
});

test("prSignals parses lifecycle, reviews, comments, and a green rollup", async () => {
  const gh = cli(
    JSON.stringify({
      number: 96,
      url: "https://github.com/0xbeckett/foo/pull/96",
      title: "Add sense",
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc123",
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ id: 1, author: { login: "ro" }, state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00Z", body: "fix" }],
      comments: [{ id: 5, author: { login: "ro" }, createdAt: "2026-01-01T00:01:00Z", body: "hi" }],
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
  const s = await gh.prSignals("0xbeckett/foo", 96);
  expect(s.state).toBe("OPEN");
  expect(s.headRefOid).toBe("abc123");
  expect(s.reviews[0]).toMatchObject({ id: "1", author: "ro", state: "CHANGES_REQUESTED" });
  expect(s.comments[0]).toMatchObject({ id: "5", author: "ro" });
  expect(s.checkConclusion).toBe("SUCCESS");
});

test("prSignals rolls a mix with any failure up to FAILURE (failures loudest)", async () => {
  const gh = cli(
    JSON.stringify({
      number: 1,
      state: "OPEN",
      statusCheckRollup: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    }),
  );
  expect((await gh.prSignals("0xbeckett/foo", 1)).checkConclusion).toBe("FAILURE");
});

test("prSignals reports PENDING while checks run, and NONE when there are none", async () => {
  const pending = cli(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ status: "QUEUED" }] }));
  expect((await pending.prSignals("0xbeckett/foo", 1)).checkConclusion).toBe("PENDING");
  const none = cli(JSON.stringify({ state: "OPEN", statusCheckRollup: [] }));
  expect((await none.prSignals("0xbeckett/foo", 1)).checkConclusion).toBe("NONE");
});

test("prSignals handles legacy commit-status contexts", async () => {
  const failing = cli(JSON.stringify({ state: "OPEN", statusCheckRollup: [{ state: "FAILURE", context: "ci" }] }));
  expect((await failing.prSignals("0xbeckett/foo", 1)).checkConclusion).toBe("FAILURE");
});

test("prSignals throws a clear error on an unreadable PR", async () => {
  const gh = cli("", 1);
  await expect(gh.prSignals("0xbeckett/foo", 404)).rejects.toThrow(/gh pr view/);
});

test("branchCard reads aggregate PR metrics in one gh query without requesting diff content", async () => {
  const { gh, calls } = recordingCli(
    JSON.stringify({
      number: 96,
      url: "https://github.com/0xbeckett/foo/pull/96",
      title: "Add branch cards",
      state: "OPEN",
      isDraft: false,
      headRefName: "beckett/42-1-branch-cards",
      baseRefName: "main",
      headRefOid: "abc123",
      updatedAt: "2026-07-12T08:00:00Z",
      additions: 184,
      deletions: 37,
      changedFiles: 6,
      commits: [{ oid: "a" }, { oid: "b" }, { oid: "c" }],
      reviewDecision: "CHANGES_REQUESTED",
      latestReviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
      comments: [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }],
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { status: "COMPLETED", conclusion: "TIMED_OUT" },
      ],
    }),
  );

  const card = await gh.branchCard("0xbeckett/foo", "beckett/42-1-branch-cards");
  expect(card).toMatchObject({
    repo: "0xbeckett/foo",
    number: 96,
    state: "OPEN",
    headRefName: "beckett/42-1-branch-cards",
    baseRefName: "main",
    additions: 184,
    deletions: 37,
    changedFiles: 6,
    commits: 3,
    reviewDecision: "CHANGES_REQUESTED",
    reviewCount: 2,
    commentCount: 4,
    checks: { total: 4, passed: 1, pending: 1, failed: 1, skipped: 1, conclusion: "FAILURE" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 7)).toEqual([
    "gh", "pr", "view", "beckett/42-1-branch-cards", "--repo", "0xbeckett/foo", "--json",
  ]);
  const fields = calls[0]?.[7] ?? "";
  expect(fields).toContain("additions,deletions,changedFiles,commits");
  expect(fields).toContain("latestReviews,comments,statusCheckRollup");
  expect(fields.split(",")).not.toContain("files");
});

test("branchCard distinguishes no checks from green checks and accepts a PR number selector", async () => {
  const { gh } = recordingCli(JSON.stringify({ number: 7, state: "MERGED", statusCheckRollup: [] }));
  const card = await gh.branchCard("0xbeckett/foo", 7);
  expect(card.state).toBe("MERGED");
  expect(card.checks).toEqual({
    total: 0,
    passed: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    conclusion: "NONE",
  });
});

test("branchCard fails clearly on command errors, malformed JSON, and missing PR identity", async () => {
  await expect(recordingCli("", 1).gh.branchCard("0xbeckett/foo", 404)).rejects.toThrow(/branch card.*boom/i);
  await expect(recordingCli("not-json").gh.branchCard("0xbeckett/foo", 1)).rejects.toThrow(/unparseable JSON/);
  await expect(recordingCli("{}").gh.branchCard("0xbeckett/foo", "branch")).rejects.toThrow(/valid PR number/);
});
