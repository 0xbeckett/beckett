import { test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory } from "./src/memory/index.ts";

test("update with only body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const store = createMemory({ memoryDir: dir, logger: { info(){}, warn(){}, error(){}, debug(){} } as any, git: false });
  await store.remember({ op: "create", name: "cross-fork-pr-limit", type: "reference",
    description: "PAT can't open PRs on external repos; hand a compare link",
    body: "Old body", source: "manual", reason: "seed" });
  await store.remember({ op: "update", name: "cross-fork-pr-limit", type: "reference",
    body: "CONFIRMED WORKING under the classic PAT — open cross-fork PRs natively", source: "manual", reason: "reobserve" });
  console.log("AFTER (body-only update):\n" + readFileSync(join(dir, "MEMORY.md"), "utf8"));
});
