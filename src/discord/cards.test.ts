import { expect, test } from "bun:test";
import { branchCardButtons, renderBranchEmbed, renderTaskCardEmbed, taskCardButtons } from "./cards.ts";
import type { BranchCardSnapshot, TaskCardBranchSnapshot, TaskCardSnapshot } from "../task/status.ts";
import type { TaskBranchStatus, TaskStatus } from "../task/store.ts";

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

test("a finished branch card carries merge, cancel, and attach interaction buttons", () => {
  const buttons = branchCardButtons({
    ref: "7.1",
    title: "Main",
    taskNumber: 7,
    taskTitle: "Uploads",
    status: "done",
    source: "pull_request",
    pullRequest: { number: 3, url: "https://github.com/acme/repo/pull/3", state: "OPEN", draft: false },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  expect(buttons).toContainEqual({ label: "Merge branch", customId: "beckett:v1:merge:7.1" });
  expect(buttons).toContainEqual({ label: "Cancel branch", customId: "beckett:v1:cancel:7.1", danger: true });
  expect(buttons).toContainEqual({ label: "Attach to this thread", customId: "beckett:v1:attach:7" });
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

// ── task card (#104) ────────────────────────────────────────────────────────────────────────

function taskCard(over: Partial<TaskCardSnapshot> = {}, branch: Partial<TaskCardBranchSnapshot> = {}): TaskCardSnapshot {
  return {
    number: 104,
    title: "One self-editing task card",
    status: "active",
    updatedAt: "2026-07-28T00:00:00.000Z",
    branches: [{ ref: "104.1", title: "Main", status: "running", ...branch }],
    ...over,
  };
}

test("task card titles itself and states its aggregate progress", () => {
  const embed = renderTaskCardEmbed(taskCard());
  expect(embed.title).toBe("#104 - One self-editing task card");
  expect(embed.description).toContain("0/1 branches done");
  expect(embed.footer?.text).toContain("updates in place");
  expect(embed.timestamp).toBe("2026-07-28T00:00:00.000Z");
});

// Each lifecycle state renders with the right label and colour.
const LIFECYCLE: Array<{ status: TaskBranchStatus; taskStatus: TaskStatus; label: string; color: number }> = [
  { status: "ready", taskStatus: "active", label: "Queued", color: 0x6e7681 },
  { status: "running", taskStatus: "active", label: "Running", color: 0x2f81f7 },
  { status: "review", taskStatus: "active", label: "In review", color: 0xd29922 },
  { status: "blocked", taskStatus: "active", label: "Stalled", color: 0xda3633 },
  { status: "done", taskStatus: "done", label: "Done", color: 0x2ea043 },
  { status: "cancelled", taskStatus: "cancelled", label: "Cancelled", color: 0x6e7681 },
];
for (const state of LIFECYCLE) {
  test(`task card renders the ${state.status} lifecycle state`, () => {
    const embed = renderTaskCardEmbed(taskCard({ status: state.taskStatus }, { status: state.status }));
    expect(JSON.stringify(embed.fields)).toContain(state.label);
    expect(embed.color).toBe(state.color);
  });
}

test("a stalled branch turns the whole card red even mid-flight", () => {
  const embed = renderTaskCardEmbed(taskCard({ status: "active" }, { status: "blocked" }));
  expect(embed.color).toBe(0xda3633);
});

test("task card shows the artifact link once a branch is finished", () => {
  const embed = renderTaskCardEmbed(taskCard({ status: "done" }, {
    status: "done",
    artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
    pullRequestNumber: 9,
  }));
  const json = JSON.stringify(embed.fields);
  expect(json).toContain("https://github.com/acme/repo/pull/9");
  expect(json).toContain("PR #9");
});

test("task card surfaces a live preview link while in review", () => {
  const embed = renderTaskCardEmbed(taskCard({}, {
    status: "review",
    preview: { url: "https://beckett-preview.0xbeckett.me" },
  }));
  expect(JSON.stringify(embed.fields)).toContain("https://beckett-preview.0xbeckett.me");
});

test("task card lists every branch with its own state", () => {
  const embed = renderTaskCardEmbed(taskCard({}, {}));
  const multi = renderTaskCardEmbed({
    ...taskCard(),
    branches: [
      { ref: "104.1", title: "Backend", status: "done", artifact: { url: "https://x/pull/1", kind: "pull_request" }, pullRequestNumber: 1 },
      { ref: "104.2", title: "Frontend", status: "running" },
    ],
  });
  expect(embed.fields).toHaveLength(1);
  expect(multi.fields).toHaveLength(2);
  expect(multi.fields?.[0]?.name).toContain("#104.1 · Backend");
  expect(multi.fields?.[1]?.name).toContain("#104.2 · Frontend");
});

test("task card carries the 73.1 action buttons: link, merge, cancel, attach", () => {
  const done = taskCardButtons(taskCard({ status: "done" }, {
    status: "done",
    artifact: { url: "https://github.com/acme/repo/pull/9", kind: "pull_request" },
    pullRequestNumber: 9,
  }));
  expect(done).toContainEqual({ label: "Open PR #9", url: "https://github.com/acme/repo/pull/9" });
  expect(done).toContainEqual({ label: "Merge #104.1", customId: "beckett:v1:merge:104.1" });
  expect(done).toContainEqual({ label: "Attach to this thread", customId: "beckett:v1:attach:104" });
  // A finished branch is no longer cancellable.
  expect(done.some((b) => "customId" in b && b.customId.startsWith("beckett:v1:cancel"))).toBe(false);
});

test("an in-flight branch offers cancel but not merge", () => {
  const running = taskCardButtons(taskCard({}, { status: "running" }));
  expect(running).toContainEqual({ label: "Cancel #104.1", customId: "beckett:v1:cancel:104.1", danger: true });
  expect(running.some((b) => "customId" in b && b.customId.startsWith("beckett:v1:merge"))).toBe(false);
  expect(running).toContainEqual({ label: "Attach to this thread", customId: "beckett:v1:attach:104" });
});

test("a cancelled branch offers neither merge nor cancel, still attach", () => {
  const buttons = taskCardButtons(taskCard({ status: "cancelled" }, { status: "cancelled" }));
  expect(buttons.some((b) => "customId" in b && b.customId.startsWith("beckett:v1:cancel"))).toBe(false);
  expect(buttons.some((b) => "customId" in b && b.customId.startsWith("beckett:v1:merge"))).toBe(false);
  expect(buttons).toContainEqual({ label: "Attach to this thread", customId: "beckett:v1:attach:104" });
});

test("a task with no branches still renders and offers attach", () => {
  const snapshot: TaskCardSnapshot = { number: 5, title: "Fresh", status: "active", updatedAt: "2026-07-28T00:00:00.000Z", branches: [] };
  const embed = renderTaskCardEmbed(snapshot);
  expect(JSON.stringify(embed.fields)).toContain("No branches yet");
  expect(taskCardButtons(snapshot)).toContainEqual({ label: "Attach to this thread", customId: "beckett:v1:attach:5" });
});
