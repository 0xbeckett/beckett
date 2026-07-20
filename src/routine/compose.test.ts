import { expect, test } from "bun:test";
import { buildXPostTask, composeShitpost, seededRng, SHITPOSTS } from "./compose.ts";

test("composeShitpost returns an in-pool line", () => {
  const text = composeShitpost(seededRng(1));
  expect(SHITPOSTS).toContain(text);
});

test("composeShitpost varies across seeds", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 40; seed++) seen.add(composeShitpost(seededRng(seed)));
  expect(seen.size).toBeGreaterThan(3);
});

test("buildXPostTask embeds the exact text and the account, never a credential", () => {
  const task = buildXPostTask("if i eat a clock is that time consuming", "@beckposting");
  expect(task).toContain("if i eat a clock is that time consuming");
  expect(task).toContain("@beckposting");
  expect(task).toContain("already authenticated");
  // The task must never inline creds — it references the injected session only.
  expect(task.toLowerCase()).not.toContain("password");
});
