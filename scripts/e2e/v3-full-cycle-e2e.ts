/**
 * v3 FULL-CYCLE e2e — the capstone. Wires the real PlanePoller + Dispatcher against the live
 * Plane instance (reached via an SSH tunnel → PLANE_INTERNAL_URL) and drives ONE ticket through
 * the entire machine: create(in_progress) → poller → implement worker → in_review → reviewer →
 * done. Spawns real Claude workers in real git worktrees. Cleans up the ticket at the end.
 *
 * Run (with `ssh -fN -L 8751:localhost:8750 loom-desk` up):
 *   PLANE_INTERNAL_URL=http://localhost:8751 PLANE_API_TOKEN=... bun run scripts/e2e/v3-full-cycle-e2e.ts
 */
import { loadConfig } from "../../src/config.ts";
import { PlaneClient } from "../../src/plane/client.ts";
import { PlanePoller } from "../../src/plane/poll.ts";
import { Dispatcher } from "../../src/dispatch/dispatcher.ts";

const repoRoot = "/Users/jason/Code/beckett";
const config = {
  ...loadConfig(),
  plane: {
    base_url: "https://plane.0xbeckett.me",
    workspace_slug: "beckett",
    project_slug: "ops",
    poll_secs: 3,
    state_map: {
      backlog: "Backlog",
      todo: "Todo",
      in_progress: "In Progress",
      in_review: "In Review",
      done: "Done",
      cancelled: "Cancelled",
    },
  },
} as any;

const client = new PlaneClient({ config });
const dispatcher = new Dispatcher({ client, config, resolveRepoRoot: () => repoRoot });
const poller = new PlanePoller({ client, pollSecs: 3 });

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

// cleanup
try {
  const internal = process.env.PLANE_INTERNAL_URL ?? "http://localhost:8751";
  await fetch(`${internal}/api/v1/workspaces/beckett/projects/${ticket.projectId}/issues/${ticket.id}/`, {
    method: "DELETE",
    headers: { "X-API-Key": process.env.PLANE_API_TOKEN ?? "" },
  });
  console.log("  cleaned up test ticket.");
} catch {
  /* best effort */
}
process.exit(0);
