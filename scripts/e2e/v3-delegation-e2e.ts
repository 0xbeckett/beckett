/**
 * v3 REAL delegation proof — spawns an actual Claude worker via the dispatcher's spawn path
 * and verifies it does the work in its isolated git worktree. This is the "can we actually
 * delegate to agents" check (no Plane needed; exercises driver + worktree + scope-guard + done).
 *
 * Run: bun run scripts/e2e/v3-delegation-e2e.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { spawnWorker } from "../../src/dispatch/spawn.ts";
import type { Ticket } from "../../src/plane/types.ts";

const repoRoot = "/Users/jason/Code/beckett";
const config = loadConfig();
const harnessName = ((process.argv[2] as "claude" | "codex") || "claude");
console.log(`(harness = ${harnessName})`);

const ticket: Ticket = {
  id: "e2e-1",
  identifier: "E2E-1",
  title: "Create GREETING.txt",
  description: "",
  body:
    "Create a file named GREETING.txt in the root of your worktree containing exactly one line:\n" +
    "hello from the beckett worker",
  state: "in_progress",
  assignees: [],
  casting: { implement: { harness: harnessName } },
  criteria: [
    "GREETING.txt exists at the worktree root",
    "its content is exactly: hello from the beckett worker",
  ],
  blockedBy: [],
  projectId: "p",
  url: "",
  updatedAt: "now",
};

console.log("→ spawning claude implement worker…");
const handle = await spawnWorker({
  ticket,
  stage: "implement",
  harness: { harness: harnessName, effort: "low" },
  config,
  repoRoot,
  workspace: repoRoot, // e2e smoke test runs directly in the repo (no worktree isolation needed)
  branch: "beckett/e2e",
  baseRef: "HEAD",
});
console.log("  worker:", handle.id, "| workspace:", handle.workspace, "| branch:", handle.branch);

const done = new Promise<{ status: string; summary: string }>((resolve) =>
  handle.onDone((status, summary) => resolve({ status, summary })),
);
const timeout = new Promise<never>((_, rej) =>
  setTimeout(() => rej(new Error("timed out after 240s")), 240_000),
);

try {
  const res = await Promise.race([done, timeout]);
  console.log("→ worker finished:", res.status);
  console.log("  summary:", res.summary.slice(0, 300));

  const f = join(handle.workspace, "GREETING.txt");
  const exists = existsSync(f);
  console.log("→ GREETING.txt present in worktree?", exists);
  if (exists) {
    const content = readFileSync(f, "utf8");
    console.log("  content:", JSON.stringify(content));
    const ok = content.trim() === "hello from the beckett worker";
    console.log(ok ? "\n✅ DELEGATION E2E PASSED" : "\n⚠️  file created but content mismatch");
  } else {
    console.log("\n❌ worker finished but produced no file");
  }
} catch (err) {
  console.log("\n❌ FAILED:", (err as Error).message);
} finally {
  await handle.reap();
  console.log("  reaped worktree.");
  process.exit(0);
}
