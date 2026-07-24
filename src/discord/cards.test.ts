import { expect, test } from "bun:test";
import { renderBranchEmbed } from "./cards.ts";
import type { BranchCardSnapshot } from "../task/status.ts";

test("branch card shows aggregate Git and PR health without diff content", () => {
  const card: BranchCardSnapshot = {
    ref: "42.2",
    title: "Voting interface",
    taskNumber: 42,
    taskTitle: "Build voting",
    status: "review",
    source: "pull_request",
    gitRef: "beckett/42-2-voting-interface",
    repo: "0xbeckett/voting",
    changes: { additions: 184, deletions: 37, files: 6, commits: 3 },
    pullRequest: { number: 96, url: "https://github.com/0xbeckett/voting/pull/96", state: "OPEN", draft: false },
    checks: { total: 9, passed: 8, pending: 1, failed: 0, skipped: 0, conclusion: "PENDING" },
    review: { decision: "APPROVED", count: 2 },
    discussion: { comments: 4 },
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const embed = renderBranchEmbed(card);
  const json = JSON.stringify(embed);
  expect(embed.title).toBe("#42.2 - Voting interface");
  expect(json).toContain("+184");
  expect(json).toContain("8 passed");
  expect(json).toContain("4");
  expect(json).not.toContain("@@");
  expect(json).not.toContain("diff --git");
});

test("local cards admit that checks are unavailable", () => {
  const embed = renderBranchEmbed({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "running",
    source: "local",
    changes: { additions: 10, deletions: 2, files: 2, commits: 1 },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(JSON.stringify(embed)).toContain("Not published yet");
});

test("a done branch with an open PR and pending checks stays amber, not shipped green", () => {
  const embed = renderBranchEmbed({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "done",
    source: "pull_request",
    pullRequest: { number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", draft: false },
    checks: { total: 1, passed: 0, pending: 1, failed: 0, skipped: 0, conclusion: "PENDING" },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(embed.color).toBe(0xd29922);
});

test("a direct push card links the published repository instead of calling it local", () => {
  const embed = renderBranchEmbed({
    ref: "8.1",
    title: "Main",
    taskNumber: 8,
    taskTitle: "Voting",
    status: "done",
    source: "published",
    publication: { url: "https://github.com/acme/voting", kind: "pushed" },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(embed.url).toBe("https://github.com/acme/voting");
  expect(embed.description).toContain("PUBLISHED");
  expect(JSON.stringify(embed)).toContain("Published without a pull request");
  expect(embed.color).toBe(0x2ea043);
});
