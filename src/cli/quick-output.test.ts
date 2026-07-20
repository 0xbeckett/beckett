import { expect, test } from "bun:test";
import { quickDetachedMessage } from "./quick-output.ts";

test("detached output routes the report through a quick-agent update turn", () => {
  const ordinary = quickDetachedMessage("quick-code", "run-2", 2);
  expect(ordinary).toContain("quick-agent update turn");
  expect(ordinary).toContain("run-2");
});
