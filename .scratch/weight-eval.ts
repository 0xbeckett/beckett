/** Evaluate semanticWeight + field-emphasis variants over the real corpus queries. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMemory } from "../src/memory/index.ts";
import { openLocalMoss } from "../src/moss-local/index.ts";
import type { Logger, MemoryNode } from "../src/types.ts";

const quietLog: Logger = (() => { const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q }; return q as unknown as Logger; })();
const SOURCES = [join(homedir(), ".claude", "projects", "-home-beckett-beckett", "memory"), join(homedir(), ".beckett", "memory")];
const QUERIES: [string, string][] = [
  ["who is the primary user and owner", "jason"],
  ["what host and OS do I run on", "loom-desk"],
  ["why can't I deploy to the website apex", "website-deploy-apex-blocked"],
  ["what design style does jason want, no ai slop", "jason-design-taste"],
  ["should commits carry a claude co-author trailer", "commits-no-claude-trailer"],
  ["how does the invite-only beta access gate work", "beta-access-gate"],
  ["what github account do I push and PR from", "github-identity"],
  ["how should I use my memory and write durable facts", "how-to-use-memory"],
  ["is zoom cleared to request fable", "zoom-can-use-fable"],
  ["how do I attach a file in discord", "discord-file-attach"],
  ["workers dying at a wall clock timeout and wedging tickets", "worker-timeout-silent-wedge"],
  ["discord reply timed out, should I retry the post", "discord-reply-timeout-no-retry"],
  ["how long should video renders be", "video-pipeline-shorts"],
  ["plane rate limit when filing big plans", "plan-filing-rate-limit"],
  ["how to cast claude models per stage sonnet opus", "claude-model-casting"],
  ["is restarting the daemon the same as deploying", "restart-is-not-deploy"],
];

const dir = mkdtempSync(join(tmpdir(), "weight-eval-"));
let i = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) continue;
  for (const rel of readdirSync(src, { recursive: true }) as string[]) {
    if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
    if (rel.split(/[\\/]/).some(s => s === ".git" || s === "archive" || s === ".moss")) continue;
    const t = join(dir, `s${i++}`, rel); mkdirSync(join(t, ".."), { recursive: true }); cpSync(join(src, rel), t);
  }
}
const store = createMemory({ memoryDir: dir, logger: quietLog, git: false });
const g = store.buildGraph();
const nodes = [...g.nodes.values()].filter(n => !n.phantom);

function fields(n: MemoryNode) {
  const alias = Array.isArray(n.metadata.aliases) ? (n.metadata.aliases as unknown[]).map(String).join(" ") : "";
  const meta = Object.entries(n.metadata).filter(([k]) => !["aliases","created","updated"].includes(k)).flatMap(([,v]) => Array.isArray(v) ? (v as unknown[]).map(String) : [String(v)]).join(" ");
  return { name: n.name, alias, desc: `${n.description} ${n.type}`, meta, body: n.body };
}

const variants: Record<string, (n: MemoryNode) => string> = {
  flat: (n) => { const f = fields(n); return [f.name, f.alias, f.desc, f.meta, f.body].filter(Boolean).join("\n"); },
  weighted: (n) => { const f = fields(n); return [f.name, f.name, f.name, f.alias, f.alias, f.desc, f.desc, f.meta, f.body].filter(Boolean).join("\n"); },
  weighted2: (n) => { const f = fields(n); return [f.name, f.name, f.name, f.name, f.alias, f.alias, f.alias, f.desc, f.desc, f.desc, f.meta, f.body].filter(Boolean).join("\n"); },
};

for (const [vname, textOf] of Object.entries(variants)) {
  for (const alpha of [0.75, 0.6, 0.5, 0.35]) {
    const mdir = mkdtempSync(join(tmpdir(), "weight-idx-"));
    const moss = await openLocalMoss({ dataDir: mdir });
    await moss.upsert(nodes.map(n => ({ id: n.name, text: textOf(n) })));
    let top1 = 0, top3 = 0; const misses: string[] = [];
    for (const [q, want] of QUERIES) {
      const matched = new Set(moss.query(q, undefined, { topK: moss.docCount, semanticWeight: 0 }).docs.map(d => d.id));
      const ranked = moss.query(q, undefined, { topK: moss.docCount, semanticWeight: alpha }).docs.filter(d => matched.has(d.id));
      const r = ranked.findIndex(d => d.id === want) + 1;
      if (r === 1) top1++; if (r >= 1 && r <= 3) top3++;
      if (r !== 1) misses.push(`${want}@${r || "miss"}`);
    }
    console.log(vname.padEnd(10), `alpha=${alpha}`, `top1=${top1}/16 top3=${top3}/16`, misses.join(" "));
    rmSync(mdir, { recursive: true, force: true });
  }
}
rmSync(dir, { recursive: true, force: true });
