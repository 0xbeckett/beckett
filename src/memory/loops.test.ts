/** Open-loop ledger reads and state transitions stay in the canonical MemoryStore. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { listLoops, openLoop, renderOpenLoopsBlock, settleLoop } from "./loops.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

async function seed(memory: MemoryStore, name: string, due: string, kind = "commitment", extra: Record<string, unknown> = {}) {
  await memory.remember({
    op: "create",
    name,
    type: "loop",
    description: `I owe ${name}`,
    body: `Body for ${name}.`,
    metadata: {
      kind,
      status: "open",
      due,
      opened: "2026-07-01",
      source: `source for ${name}`,
      closes: `check ${name}`,
      ...extra,
    },
    source: "manual",
    reason: "test",
  });
}

test("lists valid visible open loops due-first and flags overdue without recall ranking", async () => {
  const { memory, dir } = store();
  await seed(memory, "later", "2026-08-03", "wishlist");
  await seed(memory, "late", "2026-07-01", "recurring-error");
  await seed(memory, "middle", "2026-07-20");
  // It is valid memory markdown but an invalid loop contract, so one bad file cannot poison reads.
  writeFileSync(join(dir, "loop", "bad-loop.md"), "---\nname: bad-loop\ndescription: >\n  broken loop\nmetadata:\n  type: loop\n  status: open\n---\n");

  const loops = listLoops(memory, { audience: SELF_AUDIENCE, today: "2026-07-20" });
  expect(loops.map((loop) => loop.node.name)).toEqual(["late", "middle", "later"]);
  expect(loops.map((loop) => loop.overdue)).toEqual([true, true, false]);
  expect(renderOpenLoopsBlock(memory)).toContain("[recurring-error]");
});

test("close and drop round-trip through MemoryStore without losing body or unknown metadata", async () => {
  const { memory, dir } = store();
  await seed(memory, "close-me", "2026-07-01", "commitment", { watchdog: "still-here" });
  await seed(memory, "drop-me", "2026-07-02");

  const closed = await settleLoop(memory, "close-me", "done", "verified by ro", SELF_AUDIENCE);
  const dropped = await settleLoop(memory, "drop-me", "dropped", "ro released this", SELF_AUDIENCE);
  expect(closed.status).toBe("done");
  expect(dropped.status).toBe("dropped");

  const fresh = createMemory({ memoryDir: dir, logger: quiet, git: false });
  const closeNode = fresh.buildGraph().nodes.get("close-me")!;
  const dropNode = fresh.buildGraph().nodes.get("drop-me")!;
  expect(closeNode.metadata.status).toBe("done");
  expect(closeNode.metadata.closed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(closeNode.metadata.watchdog).toBe("still-here");
  expect(closeNode.body).toContain("Body for close-me.");
  expect(closeNode.body).toContain("verified by ro");
  expect(dropNode.metadata.status).toBe("dropped");
  expect(dropNode.metadata.closed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(dropNode.body).toContain("ro released this");
  expect(readFileSync(closeNode.path, "utf8")).toContain("watchdog: still-here");
});

test("opening a loop creates the conventional loop file and an empty ledger renders nothing", async () => {
  const { memory, dir } = store();
  expect(renderOpenLoopsBlock(memory)).toBe("");
  const opened = await openLoop(memory, {
    name: "new-loop",
    kind: "commitment",
    due: "2026-08-01",
    source: "self",
    description: "I said I'd add the ledger",
  });
  expect(opened.node.path).toBe(join(dir, "loop", "new-loop.md"));
  const raw = readFileSync(opened.node.path, "utf8");
  expect(raw).toContain("type: loop");
  expect(raw).toContain("status: open");
  expect(raw).toContain("closes:");
});
