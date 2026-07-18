import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalMoss } from "../src/moss-local/index.ts";

const dir = mkdtempSync(join(tmpdir(), "moss-probe3-"));
const moss = await openLocalMoss({ dataDir: dir });
await moss.upsert([
  { id: "jason", text: "jason\nperson\nPrimary user and owner talks casual lowercase\nGitHub frgmt0. Works from loom-desk." },
  { id: "loom-desk", text: "loom desk\nenv\nUbuntu host where beckett runs\nThe cloudflared tunnel token lives in ~/.cloudflared/config.yml." },
  { id: "docs-site", text: "docs site\nproject\nDeploy the docs site to Cloudflare Pages" },
  { id: "marketing", text: "marketing team\nperson\nThe marketing team at Acme handles all campaign work" },
]);

for (const q of [
  "how are we deploying the documentation site?",
  "deploys preference",
  "where is the cloudflared tunnel token",
  "campaigns",
  "acme marketing",
  "completely unrelated words",
]) {
  const kw = moss.query(q, undefined, { topK: 4, semanticWeight: 0 });
  const hy = moss.query(q, undefined, { topK: 4, semanticWeight: 0.75 });
  console.log(JSON.stringify({ q, kw: kw.docs.map(d => [d.id, +d.score.toFixed(3)]), hy: hy.docs.map(d => [d.id, +d.score.toFixed(3)]) }));
}
