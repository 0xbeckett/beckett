/**
 * Unit coverage for the concierge's context-size accounting (issue #5 auto-compaction).
 * The one thing that must be right: context size sums ALL input-side usage fields, not just
 * `input_tokens` (which is only the uncached delta and would never reach the rotate ceiling).
 */

import { expect, test } from "bun:test";
import { contextTokensFromUsage } from "./index.ts";

test("sums input + cache_creation + cache_read", () => {
  expect(
    contextTokensFromUsage({
      input_tokens: 12,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 188_000,
    }),
  ).toBe(189_012);
});

test("warm session: nearly all mass is cache_read, tiny input delta", () => {
  // input_tokens alone (12) is far below any ceiling; the real context size is ~191k.
  const usage = { input_tokens: 12, cache_read_input_tokens: 191_000 };
  expect(contextTokensFromUsage(usage)).toBe(191_012);
});

test("output_tokens never counts toward context size", () => {
  expect(contextTokensFromUsage({ input_tokens: 100, output_tokens: 5_000 })).toBe(100);
});

test("non-usage / partial input is 0, never NaN", () => {
  expect(contextTokensFromUsage(null)).toBe(0);
  expect(contextTokensFromUsage(undefined)).toBe(0);
  expect(contextTokensFromUsage("nope")).toBe(0);
  expect(contextTokensFromUsage({})).toBe(0);
  expect(contextTokensFromUsage({ input_tokens: "x" })).toBe(0);
});
