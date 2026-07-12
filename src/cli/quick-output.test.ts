import { expect, test } from "bun:test";
import { quickDetachedMessage } from "./quick-output.ts";

test("computer-use detached output describes direct screenshot and proof delivery only", () => {
  const browser = quickDetachedMessage("computer-use", "run-1", 2);
  expect(browser).toContain("page screenshot");
  expect(browser).toContain("proof when applicable");
  expect(browser).not.toContain("quick-agent update turn");

  const ordinary = quickDetachedMessage("quick-code", "run-2", 2);
  expect(ordinary).toContain("quick-agent update turn");
  expect(ordinary).not.toContain("page screenshot");
});
