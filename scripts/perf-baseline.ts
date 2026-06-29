#!/usr/bin/env node
/**
 * Performance Baseline Script (run on explore/skills-and-hooks branch)
 *
 * Captures metrics for the baseline + the additive skills/hooks layer. Focus areas:
 *  - Context/prompt assembly cost (skills add bloat ONLY when active)
 *  - The additive invariant: OFF == baseline (skills off → context size unchanged)
 *  - Three skill modes: OFF (none), SCOPED (named subset), ALL (operator opt-in)
 *  - Memory recall / graph build time
 *  - Scope guard / hook evaluation time (hot path for every tool)
 *
 * Run with: node scripts/perf-baseline.ts   (node-only; no bun required)
 *
 * CONSOLIDATION: the skills loader + assembleSystem are imported from the REAL src modules
 * (node 23.6+ strips types and resolves .ts imports), not re-copied — so this script measures
 * exactly what production does. (Previously a hand-copied loader drifted: it reported 1299
 * while the real always-on code did 7442.) Only `renderMemory` stays local — the real one
 * needs a full RecallResult; here a fixed-size stand-in is fine for relative deltas.
 */

import { performance } from "node:perf_hooks";

// REAL production code (single source of truth — no re-implementation):
import {
  loadAndFormatSkills,
  loadAllSkills,
} from "../src/skills/index.ts";
import { assembleSystem } from "../src/brain/prompts.ts";

// --- Local fixtures / stand-ins (not production paths) ---

/** Stand-in for prompts.ts renderMemory (the real one needs a full RecallResult). */
function renderMemory(memory?: any): string {
  if (!memory || !memory.hits?.length) return "";
  const parts = memory.hits.slice(0, 6).map((h: any) => {
    const desc = (h.node?.description || "").slice(0, 200);
    return `[[${h.node?.name}]]: ${desc}`;
  });
  return "MEMORY (use these facts when planning/judging):\n\n" + parts.join("\n\n");
}

function ctxMemory(ctx?: any): string {
  return renderMemory(ctx?.memory);
}

/** Skills layer (mirrors prompts.ts ctxSkills) using the REAL loader. */
function ctxSkills(activeNames?: string[], sessionOrTaskId?: string): string {
  const loaded = loadAndFormatSkills(activeNames, sessionOrTaskId);
  return loaded ? `SKILLS (specialized instructions):\n\n${loaded}` : "";
}

// Simplified scope guard eval (from src/hooks/scope-guard.ts) — call-overhead timing only
function evaluateScopeGuard(input: any, _cfg: any) {
  const tool = input.tool_name || "";
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"].includes(tool)) return {};
  const targets: string[] = [];
  if (tool !== "Bash") {
    const fp = input.tool_input?.file_path;
    if (fp) targets.push(fp);
  }
  return targets.length === 0 ? {} : { hookSpecificOutput: { permissionDecision: "allow" } };
}

// --- Benchmark helpers ---

function timeIt<T>(label: string, fn: () => T, iterations = 1000): { avgMs: number; result: T } {
  const start = performance.now();
  let result: T;
  for (let i = 0; i < iterations; i++) result = fn();
  const elapsed = performance.now() - start;
  const avg = elapsed / iterations;
  console.log(`${label} (x${iterations}): ${avg.toFixed(4)} ms avg`);
  return { avgMs: avg, result: result! };
}

function roughTokens(chars: number): number {
  return Math.round(chars / 4);
}

// --- Fixtures shared across measurements ---

const basePersona = "You are Beckett, a chill, quippy coworker... (typical thin/full persona ~800 chars)";
const sampleMemory = {
  hits: Array.from({ length: 5 }, (_, i) => ({
    node: { name: `proj-${i}`, description: "Long project description with facts, links, and history. ".repeat(10) },
  })),
};
const sampleTask = "Implement the new feature with proper tests and docs.";
const sampleFields = "Additional context: {...}";

function assembledSize(activeNames?: string[], sessionOrTaskId?: string): number {
  const skills = ctxSkills(activeNames, sessionOrTaskId);
  const mem = ctxMemory({ memory: sampleMemory });
  return assembleSystem(basePersona, mem, skills, sampleFields, sampleTask).length;
}

// =======================================================================================

console.log("=== Beckett Performance Baseline (skills/hooks additive layer) ===");
console.log("Branch:", "explore/skills-and-hooks");
console.log("Baseline commit:", "13be23f");
console.log("Node:", process.version);
console.log("env BECKETT_SKILLS_ALL:", process.env.BECKETT_SKILLS_ALL ?? "(unset)");
console.log("env BECKETT_SKILLS:", process.env.BECKETT_SKILLS ?? "(unset)");
console.log("");

// 1. Context assembly — OFF (baseline) timing
console.log("--- Context Assembly (skills OFF == baseline) ---");
const { avgMs: assemblyAvg } = timeIt("assembleSystem (persona + memory + NO skills)", () => {
  return assembledSize(); // no active list, no env opt-in → skills = ""
}, 5000);

const offSize = assembledSize();
console.log(`Baseline (skills OFF) context size: ~${offSize} chars (~${roughTokens(offSize)} tokens)`);

// 2. The additive invariant: OFF must equal the no-skills assembly exactly.
const noSkillsControl = assembleSystem(basePersona, ctxMemory({ memory: sampleMemory }), "", sampleFields, sampleTask).length;
const additive = offSize === noSkillsControl;
console.log(`ADDITIVITY CHECK — OFF == no-skills control: ${additive ? "PASS" : "FAIL"} (off=${offSize}, control=${noSkillsControl})`);

// 3. Skill modes (only loaded when explicitly active)
console.log("\n--- Skill Modes (delta vs OFF) ---");
const allSkills = loadAllSkills();
if (!allSkills.length) {
  console.log("(no skills dir found — nothing to load; OFF is the only mode)");
} else {
  const scopedNames = allSkills.slice(0, 2).map((s) => s.name); // a scoped subset (e.g. 2 skills)
  const scopedSize = assembledSize(scopedNames);

  // ALL mode = operator opt-in (BECKETT_SKILLS_ALL); measure without leaking env to later code.
  const prevAll = process.env.BECKETT_SKILLS_ALL;
  process.env.BECKETT_SKILLS_ALL = "1";
  const allModeSize = assembledSize();
  if (prevAll === undefined) delete process.env.BECKETT_SKILLS_ALL;
  else process.env.BECKETT_SKILLS_ALL = prevAll;

  const fullBlockLen = allSkills.map((s) => `--- SKILL: ${s.name} ---\n${s.content}`).join("\n\n").length;
  console.log(`SCOPED [${scopedNames.join(", ")}]: ~${scopedSize} chars (~${roughTokens(scopedSize)} tok)  Δ +${scopedSize - offSize}`);
  console.log(`ALL (operator opt-in, ${allSkills.length} skills): ~${allModeSize} chars (~${roughTokens(allModeSize)} tok)  Δ +${allModeSize - offSize}`);
  console.log(`Full library size: ${fullBlockLen} chars (~${roughTokens(fullBlockLen)} tokens)`);

  timeIt("assembleSystem WITH 2 scoped skills", () => assembledSize(scopedNames), 5000);
}

// 4. Memory recall / graph build simulation
console.log("\n--- Memory Operations ---");
const fakeMemoryFiles = Array.from({ length: 50 }, (_, i) => `node-${i}.md`);
function simulateRecallBuild() {
  const graph: any = { nodes: new Map(), out: new Map() };
  fakeMemoryFiles.forEach((name) => graph.nodes.set(name, { name, description: "x".repeat(300), type: "project" }));
  return graph;
}
timeIt("Memory graph build + recall (50 nodes)", simulateRecallBuild, 2000);

// 5. Hook evaluation (scope-guard hot path)
console.log("\n--- Hook / Scope Enforcement ---");
const sampleHookInput = { tool_name: "Edit", tool_input: { file_path: "src/foo.ts" }, cwd: "/tmp/worktree" };
timeIt("evaluateScopeGuard (per-tool call overhead)", () => evaluateScopeGuard(sampleHookInput, {}), 100000);

// 6. Summary
console.log("\n=== METRICS SUMMARY ===");
console.log(`Assembly time (per call, OFF): ${assemblyAvg.toFixed(4)} ms`);
console.log(`Context size OFF (baseline): ~${offSize} chars (~${roughTokens(offSize)} tok)`);
console.log(`Additive invariant (OFF == baseline): ${additive ? "PASS" : "FAIL"}`);
console.log("Hook eval time: sub-ms (high call volume)");
console.log("Re-run after each iteration to track deltas. Skills cost is paid ONLY when active.");

process.exit(0);
