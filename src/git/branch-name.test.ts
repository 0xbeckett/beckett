import { expect, test } from "bun:test";
import { gitBranchForTicket, worktreeDirForTicket } from "./branch-name.ts";

test("task-backed Git branches use the public branch number", () => {
  expect(gitBranchForTicket({ identifier: "OPS-77", branchRef: "42.2.1" })).toBe("beckett/task-42-2-1");
});

test("legacy tickets keep their established Git branch", () => {
  expect(gitBranchForTicket({ identifier: "OPS-77" })).toBe("beckett/ops-77");
});

// #134: a raw `#` in the worktree dir segment breaks npm/Vite inside the worker's cwd.
test("worktree dir segment strips '#' from a public ticket id", () => {
  const seg = worktreeDirForTicket({ id: "#131" });
  expect(seg).not.toContain("#");
  expect(seg).toBe("131");
});

test("worktree dir segment strips '#' from a branch-ref-style id", () => {
  const seg = worktreeDirForTicket({ id: "#131.1" });
  expect(seg).not.toContain("#");
  expect(seg).toBe("131.1");
});

test("worktree dir segment is unique per distinct ticket id within a repo", () => {
  expect(worktreeDirForTicket({ id: "#131" })).not.toBe(worktreeDirForTicket({ id: "#131.1" }));
  expect(worktreeDirForTicket({ id: "#132" })).not.toBe(worktreeDirForTicket({ id: "#131" }));
});

test("worktree dir segment leaves an already-safe id untouched", () => {
  expect(worktreeDirForTicket({ id: "tkt-1" })).toBe("tkt-1");
});
