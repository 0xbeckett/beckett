/**
 * Coverage for the harness failure taxonomy (`src/drivers/failure.ts`, issue #17): the
 * classifier drives the dispatcher's per-class recovery policy, so a misclassification either
 * retries a closed door (auth) or parks a transient blip.
 */

import { expect, test } from "bun:test";
import { classifyHarnessFailure, StderrRing } from "./failure.ts";

test("auth failures classify as auth", () => {
  expect(classifyHarnessFailure("Error: Not logged in. Please run `claude` to log in.")).toBe("auth");
  expect(classifyHarnessFailure("401 Unauthorized")).toBe("auth");
  expect(classifyHarnessFailure("OAuth token expired — re-authenticate")).toBe("auth");
  expect(classifyHarnessFailure("invalid API key provided")).toBe("auth");
});

test("rate limits classify as rate_limit", () => {
  expect(classifyHarnessFailure("429 Too Many Requests")).toBe("rate_limit");
  expect(classifyHarnessFailure("rate limit exceeded, retry later")).toBe("rate_limit");
  expect(classifyHarnessFailure("API overloaded_error")).toBe("rate_limit");
  expect(classifyHarnessFailure("usage limit reached for the current period")).toBe("rate_limit");
});

test("auth wins over rate-limit wording on ambiguous text", () => {
  expect(classifyHarnessFailure("401 unauthorized: rate limit plan expired")).toBe("auth");
});

test("spawn-class failures classify as spawn", () => {
  expect(classifyHarnessFailure("setsid: failed to execute pi: No such file or directory")).toBe("spawn");
  expect(classifyHarnessFailure("bash: codex: command not found")).toBe("spawn");
  expect(classifyHarnessFailure("ClaudeDriver: exited (code 1) before init")).toBe("spawn");
});

test("unrecognized text returns undefined (callers default to crash)", () => {
  expect(classifyHarnessFailure("segmentation fault (core dumped)")).toBeUndefined();
  expect(classifyHarnessFailure("")).toBeUndefined();
  expect(classifyHarnessFailure(null)).toBeUndefined();
});

test("StderrRing keeps only the newest N lines", () => {
  const ring = new StderrRing(3);
  ring.record("one\ntwo");
  ring.record("three");
  ring.record("four");
  expect(ring.tail()).toBe("two\nthree\nfour");
});
