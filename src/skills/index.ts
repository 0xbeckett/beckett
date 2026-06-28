/**
 * Beckett — Skills (additive, non-breaking layer)
 * =======================================================================================
 * Inspired by Kew's lightweight markdown skills (skills/*.md, selective injection).
 *
 * This module is **purely additive**. 
 * - If no skills directory exists or no skills are active, all functions return empty results.
 * - Existing prompt builders and context assembly continue to produce identical output.
 *
 * Design goals for consolidation:
 * - Declarative .md skills (easy to add, review via PRs, version in repo or ~/.beckett/skills).
 * - Selective activation (per node from PLAN, or global).
 * - Can be injected into BrainContext and worker prompts.
 * - Future: skills can declare hooks they want to contribute.
 *
 * Current baseline behavior is preserved exactly when this module returns "" or [].
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";

export interface LoadedSkill {
  name: string;
  content: string;
}

/**
 * Resolve the skills directory.
 * For now: prefer ~/.beckett/skills, fall back to ./skills (for dev).
 * Returns null if nothing found → callers treat as "no skills".
 */
export function resolveSkillsDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(home, ".beckett", "skills"),
    join(process.cwd(), "skills"),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Load all .md files from the skills dir as raw content.
 * Returns [] if no dir or no files. Never throws for missing dir.
 */
export function loadAllSkills(): LoadedSkill[] {
  const dir = resolveSkillsDir();
  if (!dir) return [];

  const skills: LoadedSkill[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (extname(file).toLowerCase() === ".md") {
        const name = basename(file, ".md");
        const content = readFileSync(join(dir, file), "utf8").trim();
        if (content) {
          skills.push({ name, content });
        }
      }
    }
  } catch {
    // Defensive: any FS error → treat as no skills (fail open for this additive feature)
    return [];
  }
  return skills;
}

/**
 * Load only specific active skills by name (additive).
 * If activeNames is empty or undefined, falls back to loadAllSkills (for now).
 * This enables per-node/task skills selection (e.g. from PLAN) without changing defaults.
 *
 * sessionId / taskId can be passed for future session-scoped loading
 * (different sessions/servers must never mix context — this was the fatal flaw
 *  reported by ro: the agent "literally just didnt know anything" because it
 *  could not determine what context belonged to what session).
 */
export function loadActiveSkills(activeNames?: string[], sessionOrTaskId?: string): LoadedSkill[] {
  if (!activeNames || activeNames.length === 0) {
    return loadAllSkills();
  }
  const all = loadAllSkills();
  const nameSet = new Set(activeNames);
  return all.filter(s => nameSet.has(s.name));
  // TODO (session scoping): when we have per-session skill storage or filtering,
  // use sessionOrTaskId to ensure we never leak context across sessions.
  // This was the exact failure mode reported: the agent "literally just didnt know anything"
  // because it couldn't tell what context belonged to what session.
}

/**
 * Format skills for prompt/context injection (Kew-style headers).
 * If no skills or empty list, returns "".
 *
 * Example output:
 * --- SKILL: research ---
 * <content>
 *
 * --- SKILL: verify ---
 * <content>
 */
export function formatSkillsBlock(skills: LoadedSkill[]): string {
  if (!skills.length) return "";

  return skills
    .map((s) => `--- SKILL: ${s.name} ---\n${s.content}`)
    .join("\n\n");
}

/**
 * Convenience: load + format in one call.
 * This is the main entry point other modules should use.
 *
 * Returns "" when there are no skills → completely safe to append unconditionally
 * in existing builders.
 */
export function loadAndFormatSkills(activeNames?: string[], sessionOrTaskId?: string): string {
  const skills = loadActiveSkills(activeNames, sessionOrTaskId);
  return formatSkillsBlock(skills);
}

/**
 * Future hook point (stub for now).
 * A skill could return metadata declaring "I want these hooks".
 * For now always returns [] so no behavior change.
 */
export function getSkillsRequestedHooks(): string[] {
  // Placeholder. Real impl could parse frontmatter from skill files.
  return [];
}

/**
 * Basic compaction helper (additive, for use by a "compaction" skill or hook).
 * Given accumulated context, produce a lean summary.
 * This is a stub — real version would use a model call (Opus/Haiku) or heuristics.
 */
export function compactContext(fullContext: string, maxChars: number = 2000): string {
  if (fullContext.length <= maxChars) return fullContext;
  
  // Naive compaction: keep first + last parts + note
  const head = fullContext.slice(0, maxChars / 2);
  const tail = fullContext.slice(-maxChars / 3);
  return `${head}\n\n[... compacted ${fullContext.length - maxChars} chars of prior turns/feedback ...]\n\n${tail}`;
}
