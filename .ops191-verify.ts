/** OPS-191 cutover verification: real host config + live bored, full ticket lifecycle. */
import { loadConfig } from "./src/config.ts";
import { createTrackerClient } from "./src/tracker/client.ts";
import { BoredClient } from "./src/bored/client.ts";

const config = loadConfig(); // real ~/.beckett/config.toml — still has a legacy [plane] section
console.log("1. config folds legacy [plane]:", JSON.stringify(config.tracker));
if ((config as Record<string, unknown>)["plane" as never]) throw new Error("config still has a plane key");

const client = createTrackerClient({ config });
console.log("2. fresh boot with no flags constructs:", client.constructor.name, "board:", client.board());
if (!(client instanceof BoredClient)) throw new Error("not bored!");

await client.ensureProvisioned();
console.log("3. bored /health ok");

const ticket = await client.createIssue({
  title: "OPS-191 cutover self-check (safe to ignore)",
  body: "Created by the OPS-191 worker to verify create/comment/state/journal against bored. Will be cancelled immediately.",
  criteria: ["tracker round-trip works"],
});
console.log("4. created:", ticket.identifier, "state:", ticket.state, "url:", ticket.url);

await client.setState(ticket.id, "in_progress");
const inProgress = await client.getIssue(ticket.id);
console.log("5. state -> in_progress:", inProgress?.state);

// bored only accepts nudges once a run exists — same order the dispatcher uses.
const comment = await client.addComment(ticket.id, "OPS-191 verification comment (nudge).");
console.log("6. comment added:", comment.id);

const journal = await (client as BoredClient).listJournal(ticket.id, 5);
console.log("7. journal tail:", JSON.stringify(journal.slice(-2)));

const comments = await client.listComments(ticket.id);
console.log("8. listComments sees nudge:", comments.some((c) => c.body.includes("OPS-191 verification")));

await client.setState(ticket.id, "cancelled");
const final = await client.getIssue(ticket.id);
console.log("9. cancelled:", final?.state);
if (final?.state !== "cancelled") throw new Error("cleanup failed — ticket not cancelled");
console.log("ALL CHECKS PASSED");
