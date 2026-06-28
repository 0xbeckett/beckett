#!/usr/bin/env node
/**
 * Performance Baseline Script (run on explore/skills-and-hooks branch)
 *
 * Captures metrics for the baseline before heavy skills + hooks experimentation.
 * Focus areas relevant to skills/hooks consolidation:
 *  - Context/prompt assembly cost (skills will increase this)
 *  - Memory recall / graph build time (frequent in baseline)
 *  - Scope guard / hook evaluation time (hot path for every tool)
 *  - Rough token/character bloat estimates
 *
 * Run with: node scripts/perf-baseline.ts
 * (Uses only node, no bun required for baseline measurement)
 *
 * Results should be captured and added to BASELINE_SKILLS_HOOKS.md or a dedicated perf log.
 */

import { performance } from "node:perf_hooks";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// --- Simulate key baseline functions from current code (as of the branch) ---

function assembleSystem(...layers: (string | undefined | null)[]): string {
  return layers.filter((l): l is string => Boolean(l && l.trim())).join("\n\n---\n\n");
}

function renderMemory(memory?: any): string {
  if (!memory || !memory.hits?.length) return "";
  // Simplified from src/brain/prompts.ts baseline
  const parts = memory.hits.slice(0, 6).map((h: any) => {
    const desc = (h.node?.description || "").slice(0, 200);
    return `[[${h.node?.name}]]: ${desc}`;
  });
  return "MEMORY (use these facts when planning/judging):\n\n" + parts.join("\n\n");
}

function ctxMemory(ctx?: any): string {
  return renderMemory(ctx?.memory);
}

function ctxSkills(ctx?: any): string {
  const fromCtx = ctx?.skills?.trim();
  if (fromCtx) return `SKILLS (specialized instructions):\n\n${fromCtx}`;

  // Fallback: global loader (still additive; empty when no skills present)
  const loaded = loadAndFormatSkills();
  return loaded ? `SKILLS (specialized instructions):\n\n${loaded}` : "";
}

// Simplified scope guard eval (from src/hooks/scope-guard.ts)
function evaluateScopeGuard(input: any, cfg: any) {
  const tool = input.tool_name || "";
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"].includes(tool)) {
    return {};
  }
  // Minimal logic for timing
  const targets: string[] = [];
  if (tool !== "Bash") {
    const fp = input.tool_input?.file_path;
    if (fp) targets.push(fp);
  }
  // ... (real logic elided for baseline timing; this captures call overhead)
  return targets.length === 0 ? {} : { hookSpecificOutput: { permissionDecision: "allow" } };
}

// --- NEW: Real skills loader for measurement (copied from src/skills for standalone run) ---
function resolveSkillsDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(home, ".beckett", "skills"),
    join(process.cwd(), "skills"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function loadAllSkills(): any[] {
  const dir = resolveSkillsDir();
  if (!dir) return [];
  const skills: any[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const name = file.replace(".md", "");
        const content = readFileSync(join(dir, file), "utf8").trim();
        if (content) skills.push({ name, content });
      }
    }
  } catch {}
  return skills;
}

function loadAndFormatSkills(): string {
  const skills = loadAllSkills();
  if (!skills.length) return "";
  return skills.map((s: any) => `--- SKILL: ${s.name} ---\n${s.content}`).join("\n\n");
}

// --- Benchmark helpers ---

function timeIt<T>(label: string, fn: () => T, iterations = 1000): { avgMs: number; result: T } {
  const start = performance.now();
  let result: T;
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }
  const elapsed = performance.now() - start;
  const avg = elapsed / iterations;
  console.log(`${label} (x${iterations}): ${avg.toFixed(4)} ms avg`);
  return { avgMs: avg, result: result! };
}

function roughTokens(chars: number): number {
  return Math.round(chars / 4); // rough estimate
}

// --- Baseline Measurements ---

console.log("=== Beckett Performance Baseline (pre-skills/hooks experiment) ===");
console.log("Branch:", "explore/skills-and-hooks");
console.log("Baseline commit:", "13be23f");
console.log("Node:", process.version);
console.log("");

let totalContextChars = 0;

// 1. Prompt / Context Assembly Baseline
console.log("--- Context Assembly ---");
const basePersona = "You are Beckett, a chill, quippy coworker... (typical thin/full persona ~800 chars)";
const sampleMemory = {
  hits: Array.from({ length: 5 }, (_, i) => ({
    node: { name: `proj-${i}`, description: "Long project description with facts, links, and history. ".repeat(10) }
  }))
};
const sampleTask = "Implement the new feature with proper tests and docs.";

const { avgMs: assemblyAvg } = timeIt("assembleSystem (persona + memory + skills + fields)", () => {
  const skills = ctxSkills({}); // empty = baseline
  const mem = ctxMemory({ memory: sampleMemory });
  const fields = "Additional context: {...}";
  const full = assembleSystem(basePersona, mem, skills, fields, sampleTask);
  totalContextChars += full.length;
  return full;
}, 5000);

console.log(`Typical assembled context size (baseline): ~${Math.round(totalContextChars / 5000)} chars (~${roughTokens(totalContextChars / 5000)} tokens)`);

// Re-measure with actual loaded skills (for delta)
const skillsBlock = loadAndFormatSkills();
if (skillsBlock) {
  const { avgMs: withSkillsAvg } = timeIt("assembleSystem WITH skills", () => {
    const mem = ctxMemory({ memory: sampleMemory });
    const fields = "Additional context: {...}";
    return assembleSystem(basePersona, mem, skillsBlock, fields, sampleTask);
  }, 5000);
  const skillsChars = skillsBlock.length;
  console.log(`Skills content size: ${skillsChars} chars (~${roughTokens(skillsChars)} tokens)`);
}

// 2. Memory Recall / Graph Simulation
console.log("\n--- Memory Operations ---");
// Simulate the frequent rebuild noted in src/memory/index.ts
const fakeMemoryFiles = Array.from({ length: 50 }, (_, i) => `node-${i}.md`);
function simulateRecallBuild() {
  const graph: any = { nodes: new Map(), out: new Map() };
  fakeMemoryFiles.forEach(name => {
    graph.nodes.set(name, { name, description: "x".repeat(300), type: "project" });
  });
  return graph;
}
timeIt("Memory graph build + recall (50 nodes, as in baseline)", simulateRecallBuild, 2000);

// 3. Hook Evaluation (scope-guard hot path)
console.log("\n--- Hook / Scope Enforcement ---");
const sampleHookInput = { tool_name: "Edit", tool_input: { file_path: "src/foo.ts" }, cwd: "/tmp/worktree" };
const sampleCfg = { root: "/tmp/worktree", owned: ["src/**"] };
timeIt("evaluateScopeGuard (per-tool call overhead)", () => {
  return evaluateScopeGuard(sampleHookInput, sampleCfg);
}, 100000);

// 4. Overall estimates from specs/code
console.log("\n--- Other Baseline Characteristics (from specs + code) ---");
console.log("Worker envelope defaults (typical): turnCap ~20-50, wallClockS ~300-900");
console.log("Concurrency cap (baseline in config): usually small (4-8) due to harness cost");
console.log("Memory recall: rebuilt from disk on EVERY read/write (see MemoryStore)");
console.log("Prompt layers stable for caching (persona → role → memory → state)");
console.log("Hook calls: every write tool (Edit/Write/Bash) in Claude workers");

// Summary for capture
console.log("\n=== BASELINE METRICS SUMMARY (capture these) ===");
console.log(`Assembly time (per call): ${assemblyAvg.toFixed(4)} ms`);
console.log(`Simulated context size: ~${Math.round(totalContextChars / 5000)} chars`);
console.log(`Hook eval time: sub-ms (high call volume)`);
console.log(`Memory build (50 nodes): measured above`);
console.log("Recommendation: Re-run this script after each iteration of skills/hooks to compare deltas.");
console.log("Next: Add real skill loading and measure bloat + time increase.");

process.exit(0);
