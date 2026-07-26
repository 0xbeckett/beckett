/**
 * Beckett — the CLI entry's static-import-graph guard (`src/cli/entry-graph.test.ts`, #91)
 * =======================================================================================
 * Enforces the cold-start contract BY INSPECTION, not convention: walk the EVAL-TIME import
 * graph reachable from `src/cli/beckett.ts` — following only static `import … from` /
 * `export … from` / side-effect `import "x"`, and deliberately NOT dynamic `import()` (the lazy
 * boundary the router hides heavy verbs behind) — and assert the browser runtime (playwright)
 * and the Discord gateway (discord.js) never appear. If a future edit re-adds a top-level import
 * that transitively drags either into every `beckett` invocation, this test fails instead of a
 * silent ~550ms regression slipping back onto every shell-out.
 *
 * Note: `bun build src/cli/beckett.ts` is NOT a substitute — the bundler follows dynamic
 * import() too, so it "sees" playwright through the lazy boundary. This walker models the actual
 * module-evaluation graph, which is what cold-start pays for.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "beckett.ts");
const HEAVY = ["playwright", "playwright-core", "discord.js"];

/** Resolve a relative specifier to a concrete file on disk (the repo uses explicit `.ts`). */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * The static (eval-time) specifiers a source file pulls in: every `… from "x"` (covers `import`
 * and `export … from`) plus bare side-effect `import "x"`. A dynamic `import("x")` has no `from`
 * and is not a bare import statement, so it is excluded — exactly the lazy boundary we rely on.
 */
function staticSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]!);
  return specs;
}

/** Walk the static graph from `entry`, returning the visited files and every bare specifier reached. */
function staticGraph(entry: string): { visited: Set<string>; bare: Set<string> } {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const src = readFileSync(file, "utf8");
    for (const spec of staticSpecifiers(src)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolveRelative(file, spec);
        if (target) stack.push(target);
      } else {
        // Normalize scoped/deep specifiers to their package root ("playwright/foo" → "playwright").
        bare.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      }
    }
  }
  return { visited, bare };
}

test("the CLI entry's static import graph never reaches playwright or discord.js", () => {
  const { bare } = staticGraph(ENTRY);
  for (const heavy of HEAVY) {
    expect(bare.has(heavy), `"${heavy}" is statically reachable from src/cli/beckett.ts — it must stay behind a lazy import()`).toBe(false);
  }
});

test("the walker actually follows imports and would catch a heavy dep (no vacuous pass)", () => {
  // Sanity: the entry walk really followed its relative imports (spine + io), so the clean result
  // above is a real traversal, not a walker that silently found nothing.
  const { visited } = staticGraph(ENTRY);
  expect([...visited].some((f) => f.endsWith("/cli/spine.ts"))).toBe(true);
  expect([...visited].some((f) => f.endsWith("/cli/io.ts"))).toBe(true);
  // Positive control: the walker DOES surface a heavy dep when a module statically imports one —
  // the mail capability statically reaches agentmail. So the entry's clean result is a real
  // absence, and this test would fail loudly if a top-level import re-introduced one.
  const mailModule = resolve(import.meta.dir, "..", "capability", "modules", "mail.ts");
  expect(staticGraph(mailModule).bare.has("agentmail")).toBe(true);
});
