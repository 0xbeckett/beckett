import { expect, test } from "bun:test";
import { classifyPublishError, PUBLISH_RETRY_DELAYS_MS } from "./publish-outbox.ts";

test("publish failure classifier retries only transient GitHub/transport failures", () => {
  for (const message of ["fetch failed", "ETIMEDOUT contacting api.github.com", "GitHub returned 503", "request timeout"]) {
    expect(classifyPublishError(new Error(message))).toBe("transient");
  }
  for (const message of ["gh api failed (401): Bad credentials", "HTTP 403 forbidden", "cross-fork PAT limit reached"]) {
    expect(classifyPublishError(new Error(message))).toBe("permanent");
  }
  expect(PUBLISH_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000]);
});
