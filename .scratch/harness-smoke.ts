import { buildSystemPrompt, loadTurnFixtures, renderFixtureTurn, DECISION_FAMILIES } from "../src/eval/turn-decisions.ts";

const fixtures = await loadTurnFixtures();
console.log("fixtures:", fixtures.length);
const byFam: Record<string, number> = {};
for (const f of fixtures) byFam[f.family] = (byFam[f.family] ?? 0) + 1;
console.log("byFamily:", JSON.stringify(byFam));
for (const fam of DECISION_FAMILIES) if (!byFam[fam]) console.log("MISSING FAMILY:", fam);

const sys = buildSystemPrompt();
console.log("system prompt length:", sys.length);
console.log("has doctrine tag:", sys.includes("<doctrine>"));
console.log("has persona tag:", sys.includes("<persona>"));
console.log("has denial doctrine line:", sys.includes("A denial is a lead"));
console.log("owner substituted (no template left):", !sys.includes("{{github_owner}}"));

console.log("\n--- sample rendered turn (owner-gated-federation-nonowner) ---");
const f = fixtures.find((x) => x.id === "owner-gated-federation-nonowner")!;
console.log(renderFixtureTurn(f));
