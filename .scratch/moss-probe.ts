import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalMoss } from "../src/moss-local/index.ts";

const dir = mkdtempSync(join(tmpdir(), "moss-probe-"));
const moss = await openLocalMoss({ dataDir: dir });
await moss.upsert([
  { id: "jason", text: "jason\nperson\nPrimary user and owner — talks casual lowercase\nGitHub frgmt0. Works from loom-desk." },
  { id: "loom-desk", text: "loom desk\nenv\nUbuntu host where beckett runs\nProjects live under ~/Projects. The cloudflared tunnel token lives in ~/.cloudflared/config.yml." },
  { id: "docs-site", text: "docs site\nproject\nDeploy the docs site to Cloudflare Pages" },
]);

for (const q of [
  "how are we deploying the documentation site?",
  "where is the cloudflared tunnel token",
  "completely unrelated words",
  "who is the owner jason",
  "kubernetes cluster",
  "zzz qqqq xxxx",
]) {
  const r = moss.query(q, undefined, { topK: 3, semanticWeight: 0.75 });
  console.log(JSON.stringify({ q, hits: r.docs.map(d => [d.id, +d.score.toFixed(4)]) }));
}
