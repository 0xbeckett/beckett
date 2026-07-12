import { expect, test } from "bun:test";
import { gitBranchForTicket } from "./branch-name.ts";

test("task-backed Git branches use the public branch number", () => {
  expect(gitBranchForTicket({ identifier: "OPS-77", branchRef: "42.2.1" })).toBe("beckett/task-42-2-1");
});

test("legacy tickets keep their established Git branch", () => {
  expect(gitBranchForTicket({ identifier: "OPS-77" })).toBe("beckett/ops-77");
});
