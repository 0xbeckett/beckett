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
