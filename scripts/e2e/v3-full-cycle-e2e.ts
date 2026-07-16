/**
 * FULL-CYCLE e2e — the capstone. Wires the real TrackerPoller + Dispatcher against the live
 * bored tracker (loopback; BECKETT_BORED_URL, default http://127.0.0.1:7770) and drives ONE
 * ticket through the entire machine: create(in_progress) → poller → implement worker →
 * in_review → reviewer → done. Spawns real Claude workers in real git worktrees. Cancels an
 * unfinished ticket at the end (bored keeps history; there is no destructive delete).
 *
 * Run on a host where bored + the `claude` harness are available:
 *   bun run scripts/e2e/v3-full-cycle-e2e.ts
 */
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createTrackerClient } from "../../src/tracker/client.ts";
import { TrackerPoller } from "../../src/tracker/poll.ts";
import { Dispatcher } from "../../src/dispatch/dispatcher.ts";

const repoRoot = process.env.BECKETT_REPO_ROOT ?? join(import.meta.dir, "../..");
const config = loadConfig();

const client = createTrackerClient({ config });
const dispatcher = new Dispatcher({ client, config, resolveRepoRoot: () => repoRoot });
const poller = new TrackerPoller({ client, pollSecs: 3 });

console.log("→ creating ticket (cast: implement=claude, review=claude) in state in_progress…");
const ticket = await client.createIssue({
  title: "Full-cycle e2e: create CYCLE.txt",
  body: "Create a file CYCLE.txt in your worktree root containing exactly: cycle ok",
  casting: { implement: { harness: "claude", effort: "low" }, review: { harness: "claude", effort: "low" } },
  criteria: ["CYCLE.txt exists at the worktree root", "its content is exactly: cycle ok"],
  state: "in_progress",
});
console.log("  created", ticket.identifier, "id", ticket.id);

await poller.start((events) => dispatcher.handle(events));
console.log("  poller running; watching the ticket flow through states…\n");

const DEADLINE = Date.now() + 240_000;
let lastState = "";
let finalState = "";
while (Date.now() < DEADLINE) {
  await new Promise((r) => setTimeout(r, 3000));
  const t = await client.getIssue(ticket.id);
  if (!t) continue;
  if (t.state !== lastState) {
    console.log(`  state: ${lastState || "(start)"} → ${t.state}`);
    lastState = t.state;
  }
  if (t.state === "done" || t.state === "cancelled") {
    finalState = t.state;
    break;
  }
}

poller.stop();
console.log(`\n→ final state: ${finalState || lastState}`);
console.log(finalState === "done" ? "✅ FULL CYCLE PASSED (in_progress → in_review → done)" : "⚠️  did not reach done within the deadline");

// cleanup: cancel anything unfinished so the board doesn't accumulate stuck e2e tickets
if (finalState !== "done" && finalState !== "cancelled") {
  try {
    await client.setState(ticket.id, "cancelled");
    console.log("  cancelled unfinished test ticket.");
  } catch {
    /* best effort */
  }
}
process.exit(0);
