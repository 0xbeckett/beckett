/**
 * Headless Concierge validation — drives ConciergeSession.ask() WITHOUT Discord and checks the
 * decision quality: trivia is answered inline (no ticket), real backend work is filed as a Plane
 * ticket with the codex-implement / Opus-review casting. Run on a host where `claude` + the
 * `beckett` CLI + Plane are reachable (loom-desk), with PLANE_* in the env / ~/.beckett.
 *
 *   bun run scripts/e2e/v3-concierge-headless.ts
 */
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { ConciergeSession } from "../../src/concierge/index.ts";
import { PlaneClient } from "../../src/plane/client.ts";

const repoRoot = process.env.BECKETT_REPO_ROOT ?? join(import.meta.dir, "../..");
const config = loadConfig();
const client = new PlaneClient({ config });
const before = (await client.listIssues()).length;

const s = new ConciergeSession({ config, cwd: repoRoot });
console.log("starting concierge session (model:", config.concierge.model, ")…");
await s.start();

console.log("\n--- TRIVIA ask (expect inline answer, NO ticket) ---");
console.log("REPLY:", (await s.ask("yo beckett, what's 2 + 2? just making conversation")).slice(0, 400));

console.log("\n--- REAL BACKEND TASK ask (expect a filed ticket, codex casting) ---");
console.log(
  "REPLY:",
  (await s.ask("can you get a /healthz endpoint added to our API backend? should return 200 with body 'ok'. build it please.")).slice(0, 500),
);

await s.stop();

const after = await client.listIssues();
console.log("\ntickets before:", before, "| after:", after.length);
const newest = [...after].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
if (after.length > before && newest) {
  console.log("NEW TICKET:", newest.identifier, "| title:", newest.title, "| state:", newest.state);
  console.log("  casting:", JSON.stringify(newest.casting));
  console.log("  criteria:", JSON.stringify(newest.criteria));
}
process.exit(0);
