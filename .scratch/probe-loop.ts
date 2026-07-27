import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory } from "../src/memory/index.ts";
import { openLoop, settleLoop, listLoops, renderOpenLoopsBlock } from "../src/memory/loops.ts";
import { SELF_AUDIENCE } from "../src/memory/search.ts";

const dir = mkdtempSync(join(tmpdir(), "probe-loop-"));
const quiet = { debug(){}, info(){}, warn(){}, error(){}, child(){ return quiet; } };
const memory = createMemory({ memoryDir: dir, logger: quiet as any, git: false });

const entry = await openLoop(memory, {
  name: "probe-loop",
  kind: "commitment",
  due: "2026-08-01",
  source: "discord 123, 2026-07-26 (to ro)",
  description: "I said I'd probe this",
});
console.log("--- raw file ---");
console.log(readFileSync(entry.node.path, "utf8"));

console.log("--- listLoops (self) ---");
console.log(JSON.stringify(listLoops(memory, { audience: SELF_AUDIENCE }), null, 2));

console.log("--- open-loops block ---");
console.log(renderOpenLoopsBlock(memory));

const closed = await settleLoop(memory, "probe-loop", "done", "verified", SELF_AUDIENCE);
console.log("--- after close ---");
console.log(readFileSync(closed.node.path, "utf8"));
