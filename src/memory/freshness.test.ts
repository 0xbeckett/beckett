/**
 * Dated-observation memory tests (`src/memory/freshness.ts` + its wiring).
 * Pins: the freshness helpers; the recall-side shaping (a newer observation wins ties, an
 * older one is never dropped); dates riding every render path (MEMORY.md index flag, recall
 * CLI text + JSON); and maintain.ts's report-only aged-observation queue — old memories are
 * observations from their time, never deletion candidates.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, renderIndex, type MemoryStore } from "./index.ts";
import { planMaintenance } from "./maintain.ts";
import { recallCliOutput } from "./recall-cli.ts";
import {
  ageDays,
  freshnessAge,
  freshnessLabel,
  indexAgeFlag,
  INDEX_AGE_FLAG_DAYS,
  AGED_OBSERVATION_DAYS,
} from "./freshness.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-freshness-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

async function seed(store: MemoryStore, name: string, description: string): Promise<void> {
  await store.remember({
    op: "create",
    name,
    type: "project",
    description,
    source: "manual",
    reason: "test seed",
  });
}

/** Rewrite a node's `updated` metadata on disk so the graph sees it as `daysAgo` days old. */
function backdate(dir: string, store: MemoryStore, name: string, daysAgo: number): void {
  const node = store.buildGraph().nodes.get(name);
  if (!node) throw new Error(`seed node ${name} missing`);
  const updated = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const raw = readFileSync(node.path, "utf8");
  const next = raw.replace(/(^|\n)  updated: .*/, `$1  updated: ${updated}`);
  expect(next).not.toBe(raw);
  writeFileSync(node.path, next, "utf8");
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────

test("ageDays/freshnessAge/freshnessLabel/indexAgeFlag behave across the bands", () => {
  const now = Date.parse("2026-07-23T12:00:00Z");
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

  expect(ageDays(iso(10), now)).toBeCloseTo(10, 5);
  expect(ageDays("not-a-date", now)).toBeNull();
  expect(ageDays(undefined, now)).toBeNull();
  expect(ageDays(iso(-5), now)).toBe(0); // clock skew never goes negative

  expect(freshnessAge(0)).toBe("today");
  expect(freshnessAge(12)).toBe("12d ago");
  expect(freshnessAge(90)).toBe("3mo ago");
  expect(freshnessAge(800)).toBe("2y ago");

  expect(freshnessLabel(iso(10), now)).toBe("10d ago");
  expect(freshnessLabel(iso(AGED_OBSERVATION_DAYS), now)).toBe("6mo ago — an observation from then");
  expect(freshnessLabel("bogus", now)).toBe("no date on file");

  expect(indexAgeFlag(iso(INDEX_AGE_FLAG_DAYS - 1), now)).toBe("");
  expect(indexAgeFlag(iso(INDEX_AGE_FLAG_DAYS + 1), now)).toBe(` · upd ${iso(INDEX_AGE_FLAG_DAYS + 1).slice(0, 10)}`);
  expect(indexAgeFlag(undefined, now)).toBe("");
});

// ── recall-side decay ────────────────────────────────────────────────────────────────────

test("an aged observation sinks on a tie but is never dropped", async () => {
  const { store, dir } = tempStore();
  // The --type filter path scores purely by recency ("filter match"), which pins the decay
  // magnitudes without lexical confounders: fresh ×1.15, >2y ×0.85.
  await seed(store, "alpha-service", "Who owns the alpha service");
  await seed(store, "beta-service", "The beta service deployment shape");
  backdate(dir, store, "alpha-service", 800); // > 2 years untouched

  const r = await store.recall({ text: "", filter: { types: ["project"] }, audience: SELF_AUDIENCE });
  const names = r.hits.map((h) => h.node.name);
  expect(names).toContain("alpha-service"); // old facts still surface…
  expect(names).toContain("beta-service");
  expect(names.indexOf("beta-service")).toBeLessThan(names.indexOf("alpha-service")); // …they just don't win ties
  const oldHit = r.hits.find((h) => h.node.name === "alpha-service")!;
  const newHit = r.hits.find((h) => h.node.name === "beta-service")!;
  expect(oldHit.score).toBeCloseTo(0.85, 5); // the exact decay factor — gentle, not a cliff
  expect(newHit.score).toBeCloseTo(1.15, 5);
});

test("an ancient but relevant observation still surfaces on the lexical path (decay ≠ drop)", async () => {
  const { store, dir } = tempStore();
  await seed(store, "failover-runbook", "The quarterly failover runbook for the fleet");
  backdate(dir, store, "failover-runbook", 800);

  const r = await store.recall({ text: "failover runbook", audience: SELF_AUDIENCE });
  expect(r.hits.map((h) => h.node.name)).toContain("failover-runbook");
});

test("a recently re-confirmed fact keeps its freshness boost on the lexical path", async () => {
  const { store, dir } = tempStore();
  await seed(store, "vpn-endpoint", "The wireguard endpoint for the fleet");
  backdate(dir, store, "vpn-endpoint", 20); // recently re-confirmed
  const r = await store.recall({ text: "wireguard endpoint", audience: SELF_AUDIENCE });
  expect(r.hits[0]?.node.name).toBe("vpn-endpoint");
  expect(r.hits[0]!.score).toBeGreaterThan(1); // freshness boost applied, not decay
});

// ── render paths carry the date ──────────────────────────────────────────────────────────

test("MEMORY.md flags lines untouched for 90d+ with their last-updated date", async () => {
  const { store, dir } = tempStore();
  await seed(store, "ancient-fact", "An old-but-public fact");
  await seed(store, "fresh-fact", "A recently confirmed fact");
  backdate(dir, store, "ancient-fact", 120);

  const md = renderIndex(store.buildGraph());
  const ancient = md.split("\n").find((l) => l.includes("[[ancient-fact]]"))!;
  const fresh = md.split("\n").find((l) => l.includes("[[fresh-fact]]"))!;
  expect(ancient).toContain("· upd ");
  expect(ancient).toMatch(/· upd \d{4}-\d{2}-\d{2}$/);
  expect(fresh).not.toContain("· upd");
});

test("recall CLI text stamps every hit with its observation date and age", async () => {
  const { store, dir } = tempStore();
  await seed(store, "old-runbook", "The quarterly failover runbook");
  backdate(dir, store, "old-runbook", 200);

  const out = (await recallCliOutput(store, {
    text: "failover runbook",
    flags: {},
    audience: SELF_AUDIENCE,
  })) as string;
  expect(out).toMatch(/updated: \d{4}-\d{2}-\d{2} \(7mo ago — an observation from then\)/);
});

test("recall CLI JSON carries updated/age_days/dated_observation per hit", async () => {
  const { store, dir } = tempStore();
  await seed(store, "old-runbook", "The quarterly failover runbook");
  backdate(dir, store, "old-runbook", 200);

  const out = (await recallCliOutput(store, {
    text: "failover runbook",
    flags: { json: true },
    audience: SELF_AUDIENCE,
  })) as { hits: Array<{ name: string; updated: string; age_days: number; dated_observation: boolean }> };
  const hit = out.hits.find((h) => h.name === "old-runbook")!;
  expect(hit.dated_observation).toBe(true);
  expect(hit.age_days).toBeGreaterThanOrEqual(199);
  expect(hit.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

// ── maintain: the report-only re-observation queue ───────────────────────────────────────

test("maintain queues no-ttl observations aged 180d+ for re-observation — and nothing else", async () => {
  const { store, dir } = tempStore();
  await seed(store, "aged-observation", "An observation nobody has re-made since");
  await seed(store, "fresh-fact", "Recently touched");
  await seed(store, "ttl-fact", "Has its own lifecycle");
  backdate(dir, store, "aged-observation", 250);
  backdate(dir, store, "ttl-fact", 250);
  // Give the third node a ttl (its lifecycle is detector 1's business, not the queue's).
  const ttlNode = store.buildGraph().nodes.get("ttl-fact")!;
  const raw = readFileSync(ttlNode.path, "utf8");
  writeFileSync(ttlNode.path, raw.replace(/(^|\n)metadata:\n/, `$1metadata:\n  ttl: 2099-01-01T00:00:00.000Z\n`), "utf8");

  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.agedObservations.map((s) => s.name)).toEqual(["aged-observation"]);
  const aged = plan.agedObservations[0]!;
  expect(aged.ageDays).toBeGreaterThanOrEqual(249);
  expect(aged.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // Report-only: no archive action is ever derived from age alone — old observations are kept.
  expect(plan.archives.find((a) => a.name === "aged-observation")).toBeUndefined();
});

test("aged observations sort oldest-first and skip nodes already being archived", async () => {
  const { store, dir } = tempStore();
  await seed(store, "older", "Ancient A");
  await seed(store, "old", "Ancient B");
  backdate(dir, store, "older", 400);
  backdate(dir, store, "old", 200);
  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.agedObservations.map((s) => s.name)).toEqual(["older", "old"]);
});
