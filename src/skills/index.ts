/**
 * Beckett — Skills (additive, non-breaking, session-scoped layer)
 * =======================================================================================
 * Inspired by Kew's lightweight markdown skills (skills/*.md, selective injection).
 *
 * This module is **purely additive**. The cardinal invariant:
 *
 *   OFF == BASELINE. With no active skills selected and no operator opt-in, every entry
 *   point returns "" / [] and existing prompt/context builders produce byte-for-byte the
 *   same output as the pre-skills baseline (commit 13be23f).
 *
 * Two ways a skill becomes active (otherwise nothing loads):
 *   1. Explicit per-call list — `activeNames` (e.g. a node's `activeSkills` from PLAN).
 *      A scoped list is honored verbatim: a node that asks for skill X gets X, nothing else.
 *   2. Operator global opt-in via env (default OFF):
 *        - BECKETT_SKILLS_ALL=1        → load the whole shared library
 *        - BECKETT_SKILLS=research,verify → load just those by name
 *      The global opt-in only applies when NO explicit per-call list is given.
 *
 * Session/server scoping (the "couldn't tell what context belonged to what session" fix):
 *   - A {@link SkillScope} (sessionOrTaskId) is threaded through every load.
 *   - Skills can live in a per-scope overlay dir (`<skillsDir>/scoped/<id>/*.md`) that is
 *     ONLY visible when that id is the active scope, and overrides a same-named base skill.
 *     This keeps one session/server's specialized skills out of another's context.
 *
 * NOTE: the prior version fell back to `loadAllSkills()` whenever no active list was given,
 * which made skills silently always-on the moment the `skills/` dir existed (breaking the
 * additive invariant). That fallback is removed — empty selection now means empty output.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { listMarkdownFiles } from "../util/markdown.ts";

export interface LoadedSkill {
  name: string;
  content: string;
  /** Where it came from: the shared library ("base") or a session/server overlay ("scoped"). */
  origin: "base" | "scoped";
}

/**
 * The explicit context boundary a skill load belongs to. Threaded everywhere so a skill
 * activated for one session/task/server can never bleed into another's context.
 */
export interface SkillScope {
  /** Session / task / server id this context belongs to. */
  sessionOrTaskId?: string;
  /** Target harness (claude|codex) — reserved for per-harness selection (additive). */
  harness?: string;
}

/**
 * Resolve the shared (base) skills directory.
 * Prefers ~/.beckett/skills, falls back to ./skills (dev). Null → no skills at all.
 */
export function resolveSkillsDir(): string | null {
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

/** Filesystem-safe form of a scope id (ids may be arbitrary task/channel/server strings). */
function sanitizeScopeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Resolve a per-scope overlay directory (`<skillsDir>/scoped/<id>`), or null if there is no
 * id, no base dir, or no such overlay. Additive: when absent, loading behaves exactly as if
 * only the base library existed.
 */
export function resolveScopedSkillsDir(sessionOrTaskId?: string): string | null {
  if (!sessionOrTaskId) return null;
  const base = resolveSkillsDir();
  if (!base) return null;
  const dir = join(base, "scoped", sanitizeScopeId(sessionOrTaskId));
  return existsSync(dir) ? dir : null;
}

/** Read all `.md` skills from one directory (non-recursive). Never throws (FS errors → []). */
function readSkillsFromDir(dir: string, origin: LoadedSkill["origin"]): LoadedSkill[] {
  const skills: LoadedSkill[] = [];
  try {
    for (const path of listMarkdownFiles(dir, { recursive: false })) {
      const content = readFileSync(path, "utf8").trim();
      if (content) skills.push({ name: basename(path, ".md"), content, origin });
    }
  } catch {
    // Defensive: any FS error → treat as no skills (fail open for this additive feature).
    return [];
  }
  return skills;
}

/**
 * Load every skill in the shared library, plus the session/server overlay when scoped.
 * Overlay skills override base skills of the same name (session-specific wins). Returns []
 * when there is no skills dir. This is a primitive — most callers want {@link loadActiveSkills}.
 */
export function loadAllSkills(sessionOrTaskId?: string): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  const base = resolveSkillsDir();
  if (base) for (const s of readSkillsFromDir(base, "base")) byName.set(s.name, s);
  const scoped = resolveScopedSkillsDir(sessionOrTaskId);
  if (scoped) for (const s of readSkillsFromDir(scoped, "scoped")) byName.set(s.name, s);
  return [...byName.values()];
}

/**
 * Operator-level global opt-in, read from the environment. Default OFF → returns null.
 *   - BECKETT_SKILLS_ALL truthy (not 0/false/off) → "all"
 *   - BECKETT_SKILLS="a,b,c" → ["a","b","c"]
 */
export function globalSkillSelection(env: NodeJS.ProcessEnv = process.env): "all" | string[] | null {
  const all = env.BECKETT_SKILLS_ALL;
  if (all && !/^(0|false|off)$/i.test(all.trim())) return "all";
  const list = env.BECKETT_SKILLS;
  if (list && list.trim()) {
    const names = list.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length) return names;
  }
  return null;
}

/**
 * Resolve which skill NAMES are active for a load. Precedence:
 *   1. A non-empty explicit per-call list wins verbatim (scoped, deterministic).
 *   2. Else the operator global opt-in (env) decides ("all" | named list).
 *   3. Else nothing → [] (OFF == baseline).
 */
export function resolveActiveSkillNames(
  activeNames?: string[],
  env: NodeJS.ProcessEnv = process.env,
): "all" | string[] {
  if (activeNames && activeNames.length > 0) return [...new Set(activeNames)];
  const global = globalSkillSelection(env);
  if (global === "all") return "all";
  if (global) return global;
  return [];
}

/**
 * Load the active skills for a scope. Returns [] when nothing is active (the safe default
 * that preserves baseline behavior). `sessionOrTaskId` scopes the overlay so sessions/servers
 * never share context implicitly.
 */
export function loadActiveSkills(activeNames?: string[], sessionOrTaskId?: string): LoadedSkill[] {
  const resolved = resolveActiveSkillNames(activeNames);
  if (resolved !== "all" && resolved.length === 0) return []; // OFF → baseline
  const all = loadAllSkills(sessionOrTaskId);
  if (resolved === "all") return all;
  const want = new Set(resolved);
  return all.filter((s) => want.has(s.name));
}

/**
 * Format skills for prompt/context injection (Kew-style headers). Returns "" for an empty
 * list, so it is always safe to append unconditionally in existing builders.
 *
 * Example:
 *   --- SKILL: research ---
 *   <content>
 *
 *   --- SKILL: verify ---
 *   <content>
 */
export function formatSkillsBlock(skills: LoadedSkill[]): string {
  if (!skills.length) return "";
  return skills.map((s) => `--- SKILL: ${s.name} ---\n${s.content}`).join("\n\n");
}

/**
 * Convenience: resolve → load → format in one call. The main entry point other modules use.
 * Returns "" when no skills are active → byte-for-byte baseline when the feature is off.
 */
export function loadAndFormatSkills(activeNames?: string[], sessionOrTaskId?: string): string {
  return formatSkillsBlock(loadActiveSkills(activeNames, sessionOrTaskId));
}

/**
 * Future hook point (stub). A skill could declare hooks it wants registered. Always [] for
 * now → no behavior change.
 */
export function getSkillsRequestedHooks(): string[] {
  return [];
}

/**
 * Basic compaction helper (additive; for a future compaction skill/hook). Given accumulated
 * context, produce a lean summary. Stub heuristic — a real version uses a model call.
 */
export function compactContext(fullContext: string, maxChars: number = 2000): string {
  if (fullContext.length <= maxChars) return fullContext;
  const head = fullContext.slice(0, maxChars / 2);
  const tail = fullContext.slice(-maxChars / 3);
  return `${head}\n\n[... compacted ${fullContext.length - maxChars} chars of prior turns/feedback ...]\n\n${tail}`;
}
