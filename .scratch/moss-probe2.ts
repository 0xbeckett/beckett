import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalMoss } from "../src/moss-local/index.ts";

const dir = mkdtempSync(join(tmpdir(), "moss-probe2-"));
const moss = await openLocalMoss({ dataDir: dir });
const docs = [
  { id: "jason", text: "jason\nperson\nPrimary user and owner talks casual lowercase\nGitHub frgmt0. Works from loom-desk." },
  { id: "loom-desk", text: "loom desk\nenv\nUbuntu host where beckett runs\nThe cloudflared tunnel token lives in ~/.cloudflared/config.yml." },
  { id: "docs-site", text: "docs site\nproject\nDeploy the docs site to Cloudflare Pages" },
  { id: "zoom", text: "zoom\nperson\nMaintainer, Fable-cleared, requested the moss transplant" },
  { id: "mail", text: "mail poller\nenv\nAgentMail incoming email poller for the daemon" },
  { id: "metrics", text: "metrics dashboard\nproject\nGrafana style dashboard for worker telemetry" },
  { id: "jingle", text: "jingle vault\nenv\nCredential vault storing passwords and TOTP seeds" },
  { id: "site", text: "landing site\nproject\nBeckett public website at 0xbeckett.me served from Cloudflare edge" },
];
await moss.upsert(docs);

for (const [label, alpha] of [["hybrid.75", 0.75], ["dense1.0", 1.0], ["keyword0.0", 0.0]] as const) {
  for (const q of ["cloudflared tunnel token", "login credentials", "zzz qqqq xxxx", "grafana telemetry"]) {
    const r = moss.query(q, undefined, { topK: 8, semanticWeight: alpha });
    console.log(label.padEnd(10), JSON.stringify({ q, hits: r.docs.map(d => [d.id, +d.score.toFixed(3)]) }));
  }
}
