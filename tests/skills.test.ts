/**
 * Beckett — skills loader unit tests (`tests/skills.test.ts`)
 * =======================================================================================
 * Locks in the additive invariant and session scoping of src/skills/index.ts. The e2e
 * fake-harness tests don't assert on prompt/skills content, so these guard the core promise:
 *
 *   OFF == BASELINE — with no active list and no operator opt-in, nothing loads.
 *
 * Hermetic: points the loader at a throwaway ~/.beckett/skills via $HOME, and toggles the
 * BECKETT_SKILLS / BECKETT_SKILLS_ALL env opt-ins explicitly. bun runs each test file in its
 * own process, so the env/HOME mutation here can't leak into other suites.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadActiveSkills,
  loadAllSkills,
  loadAndFormatSkills,
  resolveActiveSkillNames,
  globalSkillSelection,
} from "../src/skills/index.ts";

const ROOT = join(process.env.BECKETT_TEST_SCRATCH || join(tmpdir(), "beckett-test-scratch"), "skills-unit");
const HOME = join(ROOT, "home");
const SKILLS = join(HOME, ".beckett", "skills");

const ENV_KEYS = ["HOME", "BECKETT_SKILLS", "BECKETT_SKILLS_ALL"] as const;
const saved: Record<string, string | undefined> = {};

/** Clear both env opt-ins so each test starts from the true OFF default. */
function clearOptIns() {
  delete process.env.BECKETT_SKILLS;
  delete process.env.BECKETT_SKILLS_ALL;
}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(SKILLS, { recursive: true });
  writeFileSync(join(SKILLS, "alpha.md"), "ALPHA");
  writeFileSync(join(SKILLS, "beta.md"), "BETA");
  // A per-session overlay: alpha overridden, gamma added — visible ONLY for scope "sess1".
  const scoped = join(SKILLS, "scoped", "sess1");
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(scoped, "alpha.md"), "ALPHA-SCOPED");
  writeFileSync(join(scoped, "gamma.md"), "GAMMA");
  // Make the loader resolve OUR hermetic dir (~/.beckett/skills wins over ./skills).
  process.env.HOME = HOME;
  clearOptIns();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(ROOT, { recursive: true, force: true });
});

// ── OFF == baseline ──────────────────────────────────────────────────────────────────

test("OFF: no active list + no opt-in → nothing loads", () => {
  clearOptIns();
  expect(loadActiveSkills()).toEqual([]);
  expect(loadAndFormatSkills()).toBe("");
  expect(loadActiveSkills([])).toEqual([]);
});

test("OFF: a skills dir existing does NOT auto-load (the old fallback is gone)", () => {
  clearOptIns();
  // The dir clearly has skills...
  expect(loadAllSkills().length).toBeGreaterThan(0);
  // ...but the default selection still loads nothing.
  expect(loadActiveSkills(undefined)).toEqual([]);
});

// ── explicit per-call selection ────────────────────────────────────────────────────────

test("explicit list loads only the named skills", () => {
  clearOptIns();
  const loaded = loadActiveSkills(["alpha"]);
  expect(loaded.map((s) => s.name)).toEqual(["alpha"]);
  expect(loaded[0]!.content).toBe("ALPHA");
  expect(loaded[0]!.origin).toBe("base");
  expect(loadAndFormatSkills(["alpha"])).toBe("--- SKILL: alpha ---\nALPHA");
});

test("unknown skill names resolve to nothing", () => {
  clearOptIns();
  expect(loadActiveSkills(["does-not-exist"])).toEqual([]);
});

// ── resolveActiveSkillNames precedence ──────────────────────────────────────────────────

test("resolveActiveSkillNames: explicit > global; empty → []", () => {
  expect(resolveActiveSkillNames(["x"], {})).toEqual(["x"]);
  expect(resolveActiveSkillNames([], {})).toEqual([]);
  expect(resolveActiveSkillNames(undefined, {})).toEqual([]);
  expect(resolveActiveSkillNames([], { BECKETT_SKILLS_ALL: "1" } as any)).toBe("all");
  expect(resolveActiveSkillNames([], { BECKETT_SKILLS: "a, b ,c" } as any)).toEqual(["a", "b", "c"]);
  // An explicit per-call list is honored verbatim even when the operator opted in globally.
  expect(resolveActiveSkillNames(["x"], { BECKETT_SKILLS_ALL: "1" } as any)).toEqual(["x"]);
});

test("globalSkillSelection: falsey values stay OFF", () => {
  expect(globalSkillSelection({} as any)).toBeNull();
  expect(globalSkillSelection({ BECKETT_SKILLS_ALL: "0" } as any)).toBeNull();
  expect(globalSkillSelection({ BECKETT_SKILLS_ALL: "false" } as any)).toBeNull();
  expect(globalSkillSelection({ BECKETT_SKILLS_ALL: "1" } as any)).toBe("all");
});

// ── operator global opt-in (env) ────────────────────────────────────────────────────────

test("BECKETT_SKILLS_ALL loads the whole library", () => {
  clearOptIns();
  process.env.BECKETT_SKILLS_ALL = "1";
  expect(loadActiveSkills().map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  clearOptIns();
});

test("BECKETT_SKILLS loads a named subset", () => {
  clearOptIns();
  process.env.BECKETT_SKILLS = "beta";
  expect(loadActiveSkills().map((s) => s.name)).toEqual(["beta"]);
  clearOptIns();
});

// ── session/server scoping (the cross-session-bleed fix) ────────────────────────────────

test("scoped overlay is invisible without its scope id", () => {
  clearOptIns();
  // gamma exists ONLY in scoped/sess1 — not loadable globally.
  expect(loadActiveSkills(["gamma"])).toEqual([]);
  expect(loadAllSkills().map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
});

test("scoped overlay loads + overrides only for its own scope", () => {
  clearOptIns();
  const sess = loadActiveSkills(["alpha", "gamma"], "sess1");
  const byName = Object.fromEntries(sess.map((s) => [s.name, s]));
  expect(Object.keys(byName).sort()).toEqual(["alpha", "gamma"]);
  expect(byName["alpha"]!.content).toBe("ALPHA-SCOPED"); // overlay wins over base
  expect(byName["alpha"]!.origin).toBe("scoped");
  expect(byName["gamma"]!.content).toBe("GAMMA");
  // A different scope sees neither the override nor gamma.
  expect(loadActiveSkills(["alpha"], "other").map((s) => s.content)).toEqual(["ALPHA"]);
});
