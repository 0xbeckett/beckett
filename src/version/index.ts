/**
 * Beckett — version source-of-truth + deploy-time bump orchestration (`src/version/index.ts`)
 * =======================================================================================
 * `package.json`'s `version` is the ONE canonical home for Beckett's own semver (OPS-188). This
 * module is the only place that reads/writes it, plus the git glue that (a) finds the last
 * DEPLOYED version (the newest `vX.Y.Z` tag — deploy tags after a successful restart) and (b) lists
 * the commit subjects merged since then. On top of that sits {@link computeBumpSuggestion}: base +
 * commits → a MINOR/PATCH suggestion (see {@link classifyBump}) that the deploy step surfaces for
 * confirm/override before it's written and committed. MAJOR is owner-only and never auto-suggested.
 *
 * Everything here is best-effort around git (a missing tag / non-repo degrades, never throws) but
 * strict around the version string itself (a malformed `package.json` version is a real error).
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBump, classifyBump, formatSemver, parseSemver, type BumpLevel, type BumpSuggestion } from "./semver.ts";

export * from "./semver.ts";

/** The repo root (two levels up from `src/version/`). The default source-of-truth location. */
export function defaultRepoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

function packageJsonPath(repoRoot: string): string {
  return join(repoRoot, "package.json");
}

/**
 * Read Beckett's current version from the source of truth (`package.json`). Throws if the file is
 * missing or its `version` isn't a MAJOR.MINOR.PATCH string — the version is load-bearing, so a
 * silent "" would be worse than a loud failure.
 */
export function readVersion(repoRoot: string = defaultRepoRoot()): string {
  const raw = readFileSync(packageJsonPath(repoRoot), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("package.json has no string version field");
  parseSemver(parsed.version); // validate shape (throws on garbage)
  return parsed.version;
}

/**
 * Write a new version into `package.json`, preserving the file's exact formatting by replacing only
 * the `"version": "…"` token (never a full re-serialize, which would reorder/reflow the file). The
 * new value is validated first. Returns the version written.
 */
export function writeVersion(newVersion: string, repoRoot: string = defaultRepoRoot()): string {
  const next = formatSemver(parseSemver(newVersion)); // normalize + validate
  const path = packageJsonPath(repoRoot);
  const raw = readFileSync(path, "utf8");
  const replaced = raw.replace(/("version"\s*:\s*")(\d+\.\d+\.\d+)(")/, `$1${next}$3`);
  if (replaced === raw) throw new Error("could not locate a version field to update in package.json");
  writeFileSync(path, replaced);
  return next;
}

/** Run git in `repoRoot`, returning trimmed stdout ("" on any failure). Best-effort, never throws. */
async function runGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["git", "-C", repoRoot, ...args], stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

/**
 * The last DEPLOYED version: the newest `vX.Y.Z` tag (deploy tags after a successful restart), as a
 * bare semver string (no "v"). `null` when there are no version tags yet (a fresh repo / first
 * deploy), so callers can fall back to the source-of-truth version as the base.
 */
export async function lastDeployedVersion(repoRoot: string = defaultRepoRoot()): Promise<string | null> {
  const out = await runGit(repoRoot, ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
  const newest = out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
  if (!newest) return null;
  try {
    return formatSemver(parseSemver(newest));
  } catch {
    return null;
  }
}

/**
 * Commit subjects merged on HEAD since version `base` (its `vX.Y.Z` tag), newest first, capped at
 * `max`. With a `base` tag, an EMPTY result is meaningful — it means nothing new since the last
 * deploy — so it's returned as-is (the caller no-ops rather than re-bumping). Only when there's no
 * base tag at all (a first-ever deploy) does this degrade to the recent history so the classifier
 * has something to look at instead of going blank.
 */
export async function commitsSinceVersion(
  repoRoot: string,
  base: string | null,
  max = 50,
): Promise<string[]> {
  const toList = (out: string): string[] => out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (base) {
    return toList(await runGit(repoRoot, ["log", `v${base}..HEAD`, "--pretty=%s", "-n", String(max)]));
  }
  // No tag (first deploy): everything on HEAD is "new" — take the most recent history.
  return toList(await runGit(repoRoot, ["log", "--pretty=%s", "-n", String(max)]));
}

/**
 * The top-level `src/<area>` directories touched since `base`, deduped and sorted. Not used to pick
 * the level — the subject classifier does that — but handy colour for the "why" the deploy prints.
 */
export async function areasChangedSince(repoRoot: string, base: string | null): Promise<string[]> {
  if (!base) return [];
  const out = await runGit(repoRoot, ["diff", "--name-only", `v${base}..HEAD`]);
  const areas = new Set<string>();
  for (const line of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const m = /^src\/([^/]+)\//.exec(line);
    if (m) areas.add(m[1]!);
    else if (!line.includes("/")) areas.add(line); // a touched root file (e.g. package.json)
  }
  return [...areas].sort();
}

/** A fully-resolved bump suggestion the deploy step can print, confirm, or override. */
export interface DeployBumpSuggestion {
  /** The last deployed version we diffed against (source-of-truth version when no tag exists). */
  base: string;
  /** Whether `base` came from a git tag (`true`) or fell back to package.json (`false`). */
  fromTag: boolean;
  /** The commit subjects since `base` that were classified. */
  commits: string[];
  /** Top-level source areas touched since `base` (colour for the reason, not the decision). */
  areas: string[];
  /** The auto-classification (MINOR/PATCH only) and its explainable reasons. */
  suggestion: BumpSuggestion;
  /** The version the suggested level would produce. */
  suggested: string;
}

/**
 * Compute the deploy-time bump suggestion: diff since the last deployed version, classify MINOR vs
 * PATCH, and project the resulting version. Pure data — it neither writes nor commits. `base`
 * defaults to the newest version tag, falling back to the source-of-truth version.
 */
export async function computeBumpSuggestion(
  repoRoot: string = defaultRepoRoot(),
  max = 50,
): Promise<DeployBumpSuggestion> {
  const tagBase = await lastDeployedVersion(repoRoot);
  const base = tagBase ?? readVersion(repoRoot);
  const commits = await commitsSinceVersion(repoRoot, tagBase, max);
  const areas = await areasChangedSince(repoRoot, tagBase);
  const suggestion = classifyBump(commits);
  return {
    base,
    fromTag: tagBase !== null,
    commits,
    areas,
    suggestion,
    suggested: applyBump(base, suggestion.level),
  };
}

/**
 * Resolve the FINAL version to ship from a suggestion + an owner choice. `override` may be a level
 * (`major`/`minor`/`patch`) or an explicit `X.Y.Z`; when omitted the suggested (auto) level wins.
 * MAJOR only ever happens through an explicit `major` override or an explicit version — never from
 * the auto classifier — which is exactly how "the owner dictates majors" is enforced.
 */
export function resolveVersion(
  base: string,
  suggestion: BumpSuggestion,
  override?: BumpLevel | string,
): { version: string; level: BumpLevel } {
  if (!override) return { version: applyBump(base, suggestion.level), level: suggestion.level };
  if (override === "major" || override === "minor" || override === "patch") {
    return { version: applyBump(base, override), level: override };
  }
  // An explicit target version — derive which part it moved (for reporting) relative to the base.
  const target = formatSemver(parseSemver(override));
  const b = parseSemver(base);
  const t = parseSemver(target);
  const level: BumpLevel = t.major !== b.major ? "major" : t.minor !== b.minor ? "minor" : "patch";
  return { version: target, level };
}

/**
 * Stage `package.json` and commit the version write on `repoRoot`. Best-effort return of the commit
 * message on success; throws only if the commit itself fails (so the deploy can surface it). The
 * caller owns pushing — this just records the bump locally.
 */
export async function commitVersion(repoRoot: string, version: string): Promise<string> {
  const message = `beckett: release v${version}`;
  await runGit(repoRoot, ["add", "package.json"]);
  const proc = Bun.spawn({
    cmd: ["git", "-C", repoRoot, "commit", "-m", message, "package.json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`git commit failed for v${version}${err ? `: ${err}` : ""}`);
  }
  return message;
}
