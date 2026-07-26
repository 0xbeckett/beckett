/**
 * Beckett — the weekly dependency-update job (`src/ops/deps-update.ts`)
 * =======================================================================================
 * The body of the `deps-update` routine action (issue #85). ro's ask was "stop hand-bumping
 * deps forever" — SSH had noticed `betterwright` pinned at 1.1.3 locally while 1.3.1 was
 * published. So once a week, unattended: update what the semver ranges already allow, PROVE it
 * with typecheck + the test suite, and hand a human a PR. Nothing else.
 *
 * The four rules that matter more than the feature, and where each is enforced:
 *
 *   1. **Never mutate the live daemon checkout.** `sourceRepo` is only ever a `git clone` SOURCE
 *      ({@link cloneSource}); every mutating command runs with `cwd` inside the throwaway clone
 *      under `workRoot`, which is removed in a `finally`. An in-place `npm update` on the tree the
 *      daemon is running out of is the exact failure mode this job exists to avoid. This covers the
 *      SOURCE tree; see {@link runChecks} for the one thing it does not cover (the suite's own
 *      artifact dirs under `beckettDir`) and why sandboxing that made things worse.
 *   2. **Never push to the base branch, never deploy.** The only writes to GitHub are a push of a
 *      fresh `beckett/deps-*` branch and a PR opened against `base` — both through the `beckett gh`
 *      CLI ({@link DepsUpdateDeps.beckett}), never raw `gh` and never `git push`. There is no code
 *      path from here to `beckett deploy`; the routine's output is a proposal a human merges.
 *   3. **A red PR is worse than no PR.** If typecheck or the test suite fails after the update the
 *      run stops at {@link runChecks} and returns `checks-failed` — no push, no PR, and the summary
 *      says which check failed.
 *   4. **Only the package managers actually in use.** {@link detectPackageManagers} keys off
 *      lockfiles present in the repo, so bun/pnpm support is written but completely inert when
 *      their lockfiles are absent. (Beckett's own repo is bun-only today.)
 *
 * IN-RANGE ONLY. The update commands are the plain `update` verbs — never `--latest` — so
 * `package.json` ranges are respected. Anything the ranges do NOT allow (a major jump, or an exact
 * pin like `betterwright: "1.1.3"`) is REPORTED as held back, never applied: that is a human
 * decision. {@link findHeldBack} is what makes that report honest.
 *
 * Everything I/O-shaped is injected ({@link DepsUpdateDeps}) so the whole job is testable without
 * a network, a git repo, or a package manager — see `./deps-update.test.ts`.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../types.ts";

// =======================================================================================
// Package-manager detection
// =======================================================================================

export type PackageManagerId = "npm" | "bun" | "pnpm";

/** One supported package manager: how to recognize it, how to update it, how to run its scripts. */
export interface PackageManager {
  id: PackageManagerId;
  /** Lockfile names that mean "this manager is in use here". ANY match counts. */
  lockfiles: string[];
  /**
   * The in-range update command. Deliberately the bare `update` verb for all three — every one of
   * them means "newest version the package.json range allows". Adding `--latest` (bun) or
   * `--latest`/`-L` (pnpm) would jump majors, which this job is not allowed to decide.
   *
   * Note that bun's `update` saves by default, so it also RAISES the floors it wrote (`^0.5.15` →
   * `^0.5.17`). That is still in-range: the version installed satisfied the original range, and the
   * range was narrowed rather than widened. No major ever moves.
   */
  update: string[];
  /** How this manager runs a `package.json` script (`typecheck`, `test`). */
  runScript: (script: string) => string[];
}

/**
 * The supported managers, in the order a repo's PRIMARY manager is chosen (the first one whose
 * lockfile is present runs the checks). Declared as data so adding yarn is a table row.
 */
export const PACKAGE_MANAGERS: readonly PackageManager[] = [
  {
    id: "npm",
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    update: ["npm", "update"],
    runScript: (script) => ["npm", "run", script],
  },
  {
    id: "bun",
    // bun.lock (text, current) and bun.lockb (binary, older installs) — either means bun.
    lockfiles: ["bun.lock", "bun.lockb"],
    update: ["bun", "update"],
    runScript: (script) => ["bun", "run", script],
  },
  {
    id: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    update: ["pnpm", "update"],
    runScript: (script) => ["pnpm", "run", script],
  },
] as const;

/**
 * Which managers this repo actually uses, detected from lockfiles PRESENT on disk — never assumed.
 * A manager with no lockfile is skipped entirely: its update command is never run, so bun/pnpm
 * support costs nothing in an npm-only repo (and vice versa). Returns table order, so element 0 is
 * the primary manager.
 */
export function detectPackageManagers(
  repoDir: string,
  exists: (path: string) => boolean = existsSync,
): PackageManager[] {
  return PACKAGE_MANAGERS.filter((pm) => pm.lockfiles.some((lock) => exists(join(repoDir, lock))));
}

// =======================================================================================
// Held-back dependencies — "available, not applied"
// =======================================================================================

/** A published version the repo's own range refuses. Reported in the summary, never applied. */
export interface HeldBackDependency {
  name: string;
  /** The range as written in package.json (e.g. "^3.24.1", "1.1.3"). */
  range: string;
  /** The newest published version. */
  latest: string;
  /** `major` — a major-version jump; `out-of-range` — e.g. an exact pin the range has outgrown. */
  reason: "major" | "out-of-range";
}

/** The leading `MAJOR.MINOR.PATCH` of a version string, or null if it isn't one. */
function versionParts(version: string): [number, number, number] | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two `MAJOR.MINOR.PATCH` triples. */
function compareParts(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`? Covers the forms that appear in real `package.json` files —
 * `^x.y.z`, `~x.y.z`, an exact `x.y.z`, and `>=x.y.z` — and returns `null` for anything else
 * (`*`, `workspace:*`, a git/file URL, a compound range). `null` means "I can't tell", and every
 * caller treats that as "say nothing" rather than guessing: a wrong held-back line in an
 * unattended weekly report is worse than a missing one.
 */
export function satisfiesRange(range: string, version: string): boolean | null {
  const v = versionParts(version);
  if (!v) return null;
  const raw = range.trim();
  const m = raw.match(/^(\^|~|>=|=)?\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!m) return null;
  const floor = versionParts(m[2]!);
  if (!floor) return null;
  if (compareParts(v, floor) < 0) return false;
  switch (m[1]) {
    case "^":
      // ^0.2.3 pins the MINOR (npm's 0.x rule); ^1.2.3 pins the major.
      return floor[0] === 0 ? v[0] === 0 && v[1] === floor[1] : v[0] === floor[0];
    case "~":
      return v[0] === floor[0] && v[1] === floor[1];
    case ">=":
      return true;
    default:
      // An exact pin: only that version satisfies it.
      return compareParts(v, floor) === 0;
  }
}

/** Every `name → range` entry across the dependency blocks a manager's update verb touches. */
export function dependencyRanges(packageJson: unknown): Record<string, string> {
  const pkg = (packageJson ?? {}) as Record<string, unknown>;
  const ranges: Record<string, string> = {};
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const entries = pkg[block];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, range] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof range === "string") ranges[name] = range;
    }
  }
  return ranges;
}

/**
 * The "available, not applied" list: dependencies whose newest published version the repo's own
 * range will not take. `latestOf` returns null for anything unresolvable (private package, network
 * hiccup) and that dependency is simply omitted — this report is advisory, so a lookup failure
 * must never fail the run.
 */
export async function findHeldBack(
  ranges: Record<string, string>,
  latestOf: (name: string) => Promise<string | null>,
): Promise<HeldBackDependency[]> {
  const held: HeldBackDependency[] = [];
  for (const [name, range] of Object.entries(ranges)) {
    const latest = await latestOf(name).catch(() => null);
    if (!latest) continue;
    if (satisfiesRange(range, latest) !== false) continue;
    const floor = versionParts(range.replace(/^[\^~>=]+\s*/, ""));
    const newest = versionParts(latest);
    const major = Boolean(floor && newest && newest[0] > floor[0]);
    held.push({ name, range, latest, reason: major ? "major" : "out-of-range" });
  }
  return held.sort((a, b) => a.name.localeCompare(b.name));
}

// =======================================================================================
// The run
// =======================================================================================

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the job touches outside itself, injected so the whole run is testable. */
export interface DepsUpdateDeps {
  /**
   * Run a command in `cwd`, with `env` layered over the ambient environment. Never inherits stdin;
   * must not throw on a non-zero exit (a non-zero exit is data here, not an exception).
   */
  exec(cmd: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  /**
   * Run `beckett <args>` — the ONLY GitHub path (`beckett gh push` / `beckett gh pr create`), so
   * the PAT injection stays where it belongs and no raw `gh` or `git push` is ever issued.
   */
  beckett(args: string[]): Promise<ExecResult>;
  /** Newest published version of a package, or null when it can't be resolved. */
  latestVersion(name: string): Promise<string | null>;
  exists(path: string): boolean;
  readText(path: string): string;
  /** Remove the throwaway clone. Must be forgiving — it runs in a `finally`. */
  removeDir(path: string): void;
  logger: Logger;
}

export interface DepsUpdateRequest {
  /** `owner/name` the PR opens on. */
  repo: string;
  /** The branch the PR TARGETS. Never pushed to, never merged. */
  base: string;
  /** The checkout cloned FROM — read-only, never mutated. */
  sourceRepo: string;
  /** Parent directory the throwaway clone is created under. Must already exist. */
  workRoot: string;
  /** Head branch for the update. Caller-stamped so a run is reproducible from its logs. */
  branch: string;
  /** Commit authorship for the update commit (Beckett's git identity). */
  author: { name: string; email: string };
}

export type DepsUpdateStatus = "opened" | "no-changes" | "no-managers" | "checks-failed" | "error";

export interface DepsUpdateResult {
  status: DepsUpdateStatus;
  /** The ONE terse line posted to Discord. Guaranteed single-line. */
  summary: string;
  prUrl: string | null;
  /** Managers actually detected and run. */
  managers: PackageManagerId[];
  /** Repo-relative files the update changed (lockfiles, and package.json when a manager saves). */
  changedFiles: string[];
  heldBack: HeldBackDependency[];
  /** The check that failed, when `status === "checks-failed"`. */
  failedCheck: string | null;
}

/** Update commands can pull the network; tests can take a while. Generous, never unbounded. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 20 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;

/** The scripts run to prove the update, in order. Both must pass or nothing is published. */
const CHECK_SCRIPTS = ["typecheck", "test"] as const;

/** Collapse to one line — the routine reports unattended every week and must not be chatty. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  return oneLine(text).slice(0, 240);
}

/** Lines a test runner or compiler uses to name a failure, rather than to narrate progress. */
const FAILURE_LINE = /^\s*(\(fail\)|error[: ]|FAIL\b|✗|✘)|\berror TS\d+|\b\d+ fail\b/i;

/**
 * The part of a failed check's output worth putting in a one-line report. Taking the FIRST 240
 * characters is wrong for a test runner: `bun test` opens with pages of application log noise, so
 * the report ends up quoting a routine "spawning worker" line and saying nothing about the failure.
 * Prefer the lines that actually name failures; fall back to the TAIL, where every runner puts its
 * summary. Only ever one line, and always something a person can act on.
 */
export function checkFailureDetail(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const named = lines.filter((l) => FAILURE_LINE.test(l));
  const chosen = named.length > 0 ? named.slice(0, 3) : lines.slice(-3);
  return firstLine(chosen.join(" · ")) || "(the check failed but printed nothing)";
}

/** "zod ^3.24.1→4.1.0" — how a held-back dependency reads in the summary. */
function heldBackClause(held: HeldBackDependency[]): string {
  if (held.length === 0) return "";
  const shown = held.slice(0, 4).map((h) => `${h.name} ${h.range}→${h.latest}`);
  const more = held.length > shown.length ? `, +${held.length - shown.length} more` : "";
  return ` Held back for a human: ${shown.join(", ")}${more}.`;
}

/**
 * Clone `sourceRepo` into a fresh directory under `workRoot` and check out `base` there. The clone
 * is where every mutation happens; `sourceRepo` is read and nothing else. `--no-hardlinks` keeps
 * the clone's object store independent of the live repo's, so nothing the job does — not even a
 * `gc` — can reach back into the tree the daemon is running from.
 */
async function cloneSource(req: DepsUpdateRequest, deps: DepsUpdateDeps): Promise<string> {
  const workDir = join(req.workRoot, req.branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  deps.removeDir(workDir);
  const clone = await deps.exec(["git", "clone", "--no-hardlinks", "--quiet", req.sourceRepo, workDir], {
    cwd: req.workRoot,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (clone.code !== 0) throw new Error(`git clone of ${req.sourceRepo} failed: ${firstLine(clone.stderr)}`);

  // Base off the source's `base` branch. `git clone` maps the source's LOCAL branches onto the
  // clone's `origin/*`, so `origin/main` here IS the source checkout's own main — which for the
  // daemon's tree is the deployed commit, exactly the right base for a PR. The bare `base` fallback
  // covers a source whose default branch was checked out under that name. Resolved INSIDE the clone:
  // no fetch, no network, and no command that could touch the source repo.
  let baseRef = "";
  for (const candidate of [`origin/${req.base}`, req.base]) {
    const r = await deps.exec(["git", "rev-parse", "--verify", "--quiet", candidate], { cwd: workDir });
    if (r.code === 0) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) throw new Error(`the clone has no ${req.base} branch to base the update on`);

  const checkout = await deps.exec(["git", "checkout", "-B", req.branch, baseRef], { cwd: workDir });
  if (checkout.code !== 0) throw new Error(`git checkout of ${baseRef} failed: ${firstLine(checkout.stderr)}`);
  return workDir;
}

/**
 * Run typecheck then the test suite through the primary manager. Returns the FIRST failure.
 *
 * Deliberately runs with the AMBIENT environment. The obvious hardening — point `BECKETT_DIR` at a
 * scratch dir so the suite can't write live state — was tried and reverted: `BECKETT_DIR` is the
 * highest-precedence path override ({@link ../paths.ts}), so it also overrides the `paths.beckett_dir`
 * that 34 browser/config tests set for themselves, and every one of them fails. A guard that makes
 * this routine abort every single week is worse than what it prevents.
 *
 * What that leaves: the suite writes its own per-run artifact dirs (`browser-agent/`, `quick/`, …)
 * under the resolved beckettDir, exactly as it does when a human runs `bun test`. That is state-dir
 * residue, not a mutation of the SOURCE checkout — which is the thing this job must never touch, and
 * which the clone guarantees. Nothing here writes routines.json, the DB, or config.
 */
async function runChecks(
  workDir: string,
  primary: PackageManager,
  deps: DepsUpdateDeps,
): Promise<{ failed: string; detail: string } | null> {
  for (const script of CHECK_SCRIPTS) {
    const cmd = primary.runScript(script);
    const r = await deps.exec(cmd, { cwd: workDir, timeoutMs: CHECK_TIMEOUT_MS });
    if (r.code !== 0) {
      return { failed: cmd.join(" "), detail: checkFailureDetail(r.stdout, r.stderr) };
    }
  }
  return null;
}

/**
 * Installed dependency trees. A repo that tracks these instead of ignoring them would otherwise turn
 * a two-line lockfile bump into a PR with thousands of vendored files in it — observed for real
 * against a fixture repo with no `.gitignore`. The manifest and the lockfile ARE the change; the tree
 * is a build product that any `install` regenerates, so it is never staged.
 */
const VENDOR_DIRS = ["node_modules/", ".pnpm-store/", ".yarn/"];

/** True for a path inside an installed dependency tree, at the repo root or nested. */
function isVendored(path: string): boolean {
  return VENDOR_DIRS.some((dir) => path === dir.slice(0, -1) || path.startsWith(dir) || path.includes(`/${dir}`));
}

/**
 * Repo-relative paths out of `git status --porcelain`, minus installed dependency trees. A rename
 * entry (`R  old -> new`) yields the NEW path, and a quoted path is unquoted. Used to stage EXACTLY
 * what the update changed — see {@link runDepsUpdate}, where `git add -A` would also sweep up
 * anything the test suite left behind.
 */
export function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const path = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim().replace(/^"(.*)"$/, "$1");
    if (path && !isVendored(path)) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

/** "bun.lock, package.json" — the changed-file list, capped so the one-line report stays terse. */
function fileList(paths: string[], max = 4): string {
  const shown = paths.slice(0, max);
  return paths.length > shown.length
    ? `${shown.join(", ")}, +${paths.length - shown.length} more`
    : shown.join(", ");
}

/** The PR body — enough for a human to merge (or not) without re-deriving the run. */
function prBody(req: DepsUpdateRequest, params: {
  managers: PackageManagerId[];
  changedFiles: string[];
  diffstat: string;
  heldBack: HeldBackDependency[];
}): string {
  const held = params.heldBack.length
    ? params.heldBack.map((h) => `- \`${h.name}\` ${h.range} → **${h.latest}** (${h.reason})`).join("\n")
    : "- none";
  return [
    "Weekly dependency update — in-range only.",
    "",
    `- Managers detected from lockfiles: ${params.managers.join(", ")}`,
    `- Changed: ${params.changedFiles.slice(0, 20).map((f) => `\`${f}\``).join(", ")}` +
      (params.changedFiles.length > 20 ? ` (+${params.changedFiles.length - 20} more)` : ""),
    `- Checks run in the clone: \`${CHECK_SCRIPTS.join("\`, \`")}\` — both green`,
    "",
    "```",
    params.diffstat.trim() || "(no diffstat)",
    "```",
    "",
    "**Available, not applied** (outside the `package.json` ranges — a human decision):",
    held,
    "",
    `Opened against \`${req.base}\` by the \`weekly-deps-update\` routine. It ran in a throwaway`,
    "clone, never touched the live checkout, and did not deploy anything. Merging is yours.",
  ].join("\n");
}

/**
 * Run one dependency update end to end. Returns a {@link DepsUpdateResult} for EVERY outcome
 * (including failures) rather than throwing, because the caller's job is to post exactly one line
 * either way — an unattended weekly routine that dies silently is the same as one that never ran.
 */
export async function runDepsUpdate(
  req: DepsUpdateRequest,
  deps: DepsUpdateDeps,
): Promise<DepsUpdateResult> {
  const base: Omit<DepsUpdateResult, "status" | "summary"> = {
    prUrl: null,
    managers: [],
    changedFiles: [],
    heldBack: [],
    failedCheck: null,
  };
  let workDir: string | null = null;
  try {
    workDir = await cloneSource(req, deps);
    deps.logger.info("deps-update working in an isolated clone", {
      workDir,
      source: req.sourceRepo,
      branch: req.branch,
    });

    const managers = detectPackageManagers(workDir, deps.exists);
    if (managers.length === 0) {
      return {
        ...base,
        status: "no-managers",
        summary: oneLine(`deps: no npm/bun/pnpm lockfile in ${req.repo} — nothing to update.`),
      };
    }
    base.managers = managers.map((m) => m.id);

    // Held-back lookups read the PRE-update ranges: that is what a human is being asked about.
    const ranges = dependencyRanges(JSON.parse(deps.readText(join(workDir, "package.json"))));
    base.heldBack = await findHeldBack(ranges, deps.latestVersion);

    for (const pm of managers) {
      const r = await deps.exec(pm.update, { cwd: workDir, timeoutMs: UPDATE_TIMEOUT_MS });
      if (r.code !== 0) {
        return {
          ...base,
          status: "error",
          summary: oneLine(`deps: \`${pm.update.join(" ")}\` failed — ${firstLine(r.stderr || r.stdout)}. No PR.`),
        };
      }
    }

    const changed = await deps.exec(["git", "status", "--porcelain"], { cwd: workDir });
    base.changedFiles = parsePorcelainPaths(changed.stdout);
    if (base.changedFiles.length === 0) {
      return {
        ...base,
        status: "no-changes",
        summary: oneLine(`deps: nothing in range to update.${heldBackClause(base.heldBack)}`),
      };
    }

    // Prove it BEFORE publishing anything. A red PR is worse than no PR.
    const failure = await runChecks(workDir, managers[0]!, deps);
    if (failure) {
      return {
        ...base,
        status: "checks-failed",
        failedCheck: failure.failed,
        summary: oneLine(
          `deps: \`${failure.failed}\` failed after the update — no PR. ${failure.detail}`,
        ),
      };
    }

    // Stage EXACTLY the paths the update changed, captured before the checks ran. `git add -A` here
    // would also commit whatever the test suite happened to drop in the tree — a coverage file, a
    // stray artifact — turning a two-line lockfile PR into junk.
    const add = await deps.exec(["git", "add", "--", ...base.changedFiles], { cwd: workDir });
    if (add.code !== 0) throw new Error(`git add failed: ${firstLine(add.stderr)}`);

    // Commit in the clone. `-c user.*` keeps the identity per-invocation: no global git config is
    // written, and the live checkout's config is never read or touched.
    const message =
      `chore(deps): weekly in-range update (${base.managers.join(", ")})\n\n` +
      `Updated: ${fileList(base.changedFiles, 12)}. typecheck + tests green in an isolated clone.`;
    const commit = await deps.exec(
      ["git", "-c", `user.name=${req.author.name}`, "-c", `user.email=${req.author.email}`,
        "commit", "-m", message],
      { cwd: workDir },
    );
    if (commit.code !== 0) throw new Error(`git commit failed: ${firstLine(commit.stderr || commit.stdout)}`);

    const diffstat = await deps.exec(["git", "diff", "--stat", "HEAD~1..HEAD"], { cwd: workDir });

    // Publish: a NEW branch plus a PR against `base`. Both via `beckett gh`, which injects the PAT.
    // Nothing here can write to `base` — `gh push` names the head branch explicitly.
    const push = await deps.beckett([
      "gh", "push", "--repo", req.repo, "--branch", req.branch, "--ref", "HEAD", "--dir", workDir,
    ]);
    if (push.code !== 0) {
      return {
        ...base,
        status: "error",
        summary: oneLine(`deps: update is green but the push failed — ${firstLine(push.stderr || push.stdout)}. No PR.`),
      };
    }

    const pr = await deps.beckett([
      "gh", "pr", "create",
      "--repo", req.repo,
      "--base", req.base,
      "--head", req.branch,
      "--title", `chore(deps): weekly in-range update (${base.managers.join(", ")})`,
      "--body", prBody(req, {
        managers: base.managers,
        changedFiles: base.changedFiles,
        heldBack: base.heldBack,
        diffstat: diffstat.stdout,
      }),
      "--dir", workDir,
    ]);
    if (pr.code !== 0) {
      return {
        ...base,
        status: "error",
        summary: oneLine(`deps: pushed ${req.branch} but opening the PR failed — ${firstLine(pr.stderr || pr.stdout)}.`),
      };
    }
    base.prUrl = parsePrUrl(pr.stdout);

    return {
      ...base,
      status: "opened",
      summary: oneLine(
        `deps: in-range updates via ${base.managers.join(" + ")} (${fileList(base.changedFiles)}), ` +
          `typecheck + tests green — ${base.prUrl ?? `PR opened on ${req.repo}`}.` +
          heldBackClause(base.heldBack),
      ),
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      summary: oneLine(`deps: update run failed — ${firstLine((err as Error).message)}. No PR.`),
    };
  } finally {
    // The clone is disposable by design; leaving it behind would accumulate a full checkout a week.
    if (workDir) {
      try {
        deps.removeDir(workDir);
      } catch (err) {
        deps.logger.warn("deps-update could not remove its clone", { workDir, error: String(err) });
      }
    }
  }
}

/** Pull the PR URL out of `beckett gh pr create`'s JSON (or a bare URL, defensively). */
export function parsePrUrl(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url) return parsed.url;
  } catch {
    // not JSON — fall through to the regex
  }
  return stdout.match(/https?:\/\/\S+?\/pull\/\d+/)?.[0] ?? null;
}

// =======================================================================================
// Default (real) dependencies
// =======================================================================================

/** Run a command, capturing output, with a hard timeout so no update can hang a weekly routine. */
async function spawnCapture(
  cmd: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Never block on a credential/passphrase prompt, and keep npm/bun non-interactive. The caller's
    // `env` layers on top — that is how runChecks relocates BECKETT_DIR away from the live state.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "1", ...opts.env },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The npm registry's `latest` dist-tag. Best-effort: any failure resolves to null. */
async function registryLatest(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * The real {@link DepsUpdateDeps}. `beckettCli` is the argv prefix that runs Beckett's own CLI
 * (`[<bun>, <…/src/cli/beckett.ts>]`) — the caller passes it so this module never guesses where
 * the CLI lives, and so a test can substitute a fake without touching GitHub.
 */
export function defaultDepsUpdateDeps(opts: { beckettCli: string[]; logger: Logger }): DepsUpdateDeps {
  return {
    exec: spawnCapture,
    beckett: (args) => spawnCapture([...opts.beckettCli, ...args], { cwd: process.cwd() }),
    latestVersion: registryLatest,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    logger: opts.logger,
  };
}
