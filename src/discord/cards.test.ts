import { expect, test } from "bun:test";
import { renderBranchEmbed, renderSubscriptionUsageEmbeds, renderTaskEmbed } from "./cards.ts";
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

test("task card lists public branch refs without internal Plane identifiers", () => {
  const embed = renderTaskEmbed({
    id: "t1",
    number: 42,
    title: "Build voting",
    status: "active",
    branches: [{
      id: "b1",
      ref: "42.1",
      path: [1],
      title: "API",
      status: "running",
      needs: [],
      ticket: { id: "uuid", identifier: "OPS-143", board: "ops", projectId: "p1", url: "https://plane" },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    }],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(embed.title).toBe("#42 - Build voting");
  expect(JSON.stringify(embed)).toContain("#42.1");
  expect(JSON.stringify(embed)).not.toContain("OPS-143");
});

test("task card stays inside Discord's 1,024-character field limit", () => {
  const timestamp = "2026-07-12T00:00:00.000Z";
  const embed = renderTaskEmbed({
    id: "t1",
    number: 42,
    title: "Large task",
    status: "active",
    branches: Array.from({ length: 20 }, (_, index) => ({
      id: `b${index}`,
      ref: `42.${index + 1}`,
      path: [index + 1],
      title: `Branch ${index + 1} ${"x".repeat(100)}`.slice(0, 100),
      status: "running" as const,
      needs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const work = embed.fields?.find((field) => field.name === "Work")?.value ?? "";
  expect(work.length).toBeLessThanOrEqual(1_024);
  expect(work).toContain("...and 12 more");
});

test("subscription cards emphasize remaining allowance and never expose account data", () => {
  const embeds = renderSubscriptionUsageEmbeds([
    {
      provider: "claude",
      plan: "Max",
      status: "ok",
      windows: [{
        label: "Weekly window",
        usedPercent: 17,
        remainingPercent: 83,
        reset: { kind: "label", text: "Sunday at 5pm" },
      }],
      observedAt: 1_784_000_000_000,
    },
    {
      provider: "codex",
      plan: "Pro",
      status: "ok",
      windows: [{
        label: "5-hour window",
        usedPercent: 8,
        remainingPercent: 92,
        reset: { kind: "timestamp", at: 1_784_354_510 },
      }],
      credits: { unlimited: false, balance: "12.50", resetCount: 3 },
      observedAt: 1_784_000_000_000,
    },
  ]);

  const json = JSON.stringify(embeds);
  expect(embeds.map((embed) => embed.title)).toEqual(["Claude usage", "Codex usage"]);
  expect(json).toContain("83% left");
  expect(json).toContain("<t:1784354510:R>");
  expect(json).toContain("Balance: 12.50");
  expect(json).not.toContain("email");
  expect(json).not.toContain("raw");
});

test("unavailable subscription renders a quiet provider-specific state", () => {
  const [embed] = renderSubscriptionUsageEmbeds([{
    provider: "codex",
    plan: null,
    status: "unavailable",
    reason: "timeout",
    windows: [],
    observedAt: 1_784_000_000_000,
  }]);
  expect(embed?.title).toBe("Codex usage");
  expect(embed?.description).toContain("timed out");
});
