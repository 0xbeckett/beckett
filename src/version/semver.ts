/**
 * Beckett — semver core + deploy-time bump classifier (`src/version/semver.ts`)
 * =======================================================================================
 * Pure, side-effect-free helpers behind OPS-188's "smart bump". Beckett versions its OWN
 * daemon as MAJOR.MINOR.PATCH; `package.json` is the single source of truth (read/write lives
 * in `./index.ts`). This file only knows how to (a) parse/format/increment a semver and
 * (b) look at the commit subjects merged since the last deployed version and SUGGEST whether
 * the deploy is a MINOR (new capability) or a PATCH (fix / internal / behavior-preserving) —
 * with a human-readable reason for WHY. MAJOR is never suggested here: the big left-most number
 * is owner-only, so auto-classification tops out at minor by design.
 */

/** A parsed MAJOR.MINOR.PATCH triple. Pre-release / build metadata is intentionally out of scope. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Which part of the version a bump moves. `major` is owner-only (never auto-suggested). */
export type BumpLevel = "major" | "minor" | "patch";

/** Parse "4.1.2" (a leading "v" is tolerated) into a {@link Semver}, or throw on garbage. */
export function parseSemver(input: string): Semver {
  const cleaned = input.trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!m) throw new Error(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(input)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** "{4,1,2}" → "4.1.2". */
export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Apply a bump to a version string and return the new one. Higher parts zero the lower parts
 * (a minor resets patch; a major resets minor + patch) — the standard semver carry.
 */
export function applyBump(base: string, level: BumpLevel): string {
  const v = parseSemver(base);
  switch (level) {
    case "major":
      return formatSemver({ major: v.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0 });
    case "patch":
      return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

/**
 * Words in a commit subject that read as a NEW capability/feature → the deploy is at least a MINOR.
 * Matched as whole words (so "address" never trips "add"). Kept deliberately small and explainable.
 */
const MINOR_WORDS = [
  "feat",
  "feature",
  "add",
  "adds",
  "added",
  "adding",
  "new",
  "introduce",
  "introduces",
  "implement",
  "implements",
  "support",
  "supports",
  "capability",
  "enable",
  "enables",
  "launch",
  "ship",
  "expose",
] as const;

/**
 * Words that mark a subject as behavior-preserving (fix / internal / chore / docs). These do NOT
 * force a patch on their own — a subject is only "patch-y" when it has one of these AND no minor
 * word — but they let the reason string explain a patch classification instead of a bare count.
 */
const PATCH_WORDS = [
  "fix",
  "fixes",
  "fixed",
  "bug",
  "bugfix",
  "hotfix",
  "refactor",
  "refactors",
  "chore",
  "docs",
  "doc",
  "test",
  "tests",
  "perf",
  "cleanup",
  "tidy",
  "revert",
  "typo",
  "lint",
  "format",
  "rename",
  "internal",
  "tweak",
  "adjust",
  "polish",
  "bump",
  "checkpoint",
] as const;

function hasWord(haystackLower: string, words: readonly string[]): boolean {
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(haystackLower));
}

/** A single commit's classification, kept so the suggestion can point at WHICH commits drove it. */
export interface CommitVerdict {
  subject: string;
  /** `true` when the subject reads as a new capability (a minor signal). */
  minor: boolean;
  /** `true` when the subject reads as a fix/internal/chore (a patch signal). */
  patch: boolean;
}

/** The output of {@link classifyBump}: the suggested level (never major) + the "why". */
export interface BumpSuggestion {
  /** Auto-classification tops out at MINOR — MAJOR is owner-only and never returned here. */
  level: "minor" | "patch";
  /** Human-readable one-liners explaining the choice (safe to print at deploy time). */
  reasons: string[];
  /** The subjects that read as new capabilities (empty for a patch). */
  minorCommits: string[];
}

/**
 * Classify a deploy as MINOR vs PATCH from the commit subjects merged since the last deployed
 * version. The rule is simple and explainable: if ANY commit reads as a new capability/feature
 * it's a MINOR; otherwise (all fixes / refactors / chores / docs, or nothing recognizable) it's a
 * PATCH. MAJOR is never returned — the owner dictates majors by hand. The reasons name the commits
 * (or the fallback) so the deploy step can say exactly why it chose what it chose.
 */
export function classifyBump(commits: string[]): BumpSuggestion {
  const verdicts: CommitVerdict[] = commits
    .map((s) => s.trim())
    .filter(Boolean)
    .map((subject) => {
      const lower = subject.toLowerCase();
      return { subject, minor: hasWord(lower, MINOR_WORDS), patch: hasWord(lower, PATCH_WORDS) };
    });

  const minorCommits = verdicts.filter((v) => v.minor).map((v) => v.subject);

  if (minorCommits.length > 0) {
    const shown = minorCommits.slice(0, 5);
    const reasons = [
      `MINOR: ${minorCommits.length} commit${minorCommits.length === 1 ? "" : "s"} add new capability`,
      ...shown.map((s) => `  • ${s}`),
    ];
    if (minorCommits.length > shown.length) reasons.push(`  • …and ${minorCommits.length - shown.length} more`);
    return { level: "minor", reasons, minorCommits };
  }

  const count = verdicts.length;
  const reasons =
    count === 0
      ? ["PATCH: no recognizable feature commits since the last deploy"]
      : [`PATCH: all ${count} commit${count === 1 ? "" : "s"} are fixes / internal / behavior-preserving`];
  return { level: "patch", reasons, minorCommits: [] };
}
