/**
 * Beckett — git worktree allocation & integration (`src/worker/worktree.ts`)
 * =======================================================================================
 * Layer-1 of scope enforcement (Spec 02 §8.1): one isolated git worktree + branch per
 * worker, rooted under `<repoRoot>/.beckett/worktrees/<wk-id>`. This module is the only
 * place that shells `git worktree add/remove`, reads a worker's diff, commits its branch,
 * and merges it back (INTEGRATE = a real `git merge`, Spec 04 §… / Spec 01 §3 step 9).
 *
 * Everything here is mechanism: pure-ish async functions over a repo path. The WorkerManager
 * (`./manager.ts`) composes them; the orchestrator drives INTEGRATE/REVIEW on top.
 *
 * Design notes:
 *  - We keep per-worker *meta* files (the done-signal schema + the scope-guard settings) inside
 *    the worktree (so `claude` auto-loads `.claude/settings.json` from its cwd) but add them to
 *    the worktree's git exclude so they never pollute the worker's diff (Spec 02 §8.2 wiring).
 *  - Diff readouts intent-to-add untracked files (`git add -A -N`) so brand-new files show up in
 *    REVIEW/checkpoint diffs without staging their contents.
 */

import { mkdirSync, existsSync, appendFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../log.ts";

const logger = log.child("worktree");

/** Result of a raw git invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd`, capturing stdout/stderr. Never inherits a tty/stdin. */
async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Run git and throw a descriptive error on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}) in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

// =======================================================================================
// Types
// =======================================================================================

/** Inputs to allocate one worker's worktree (Spec 02 §8.1). */
export interface CreateWorktreeOpts {
  /** Absolute path to the project git repo root. */
  repoRoot: string;
  /** Absolute path the new worktree will live at (under `<repoRoot>/.beckett/worktrees/<id>`). */
  workspace: string;
  /** Branch to create/checkout, e.g. "beckett/<task>/<node>". */
  branch: string;
  /** Base ref to branch from (origin/main or the DAG integration branch). */
  baseRef: string;
  /** When resuming, reuse an existing worktree/branch instead of recreating (Spec 02 §4.5). */
  reuseIfExists?: boolean;
}

/** A handle to an allocated worktree. */
export interface WorktreeHandle {
  repoRoot: string;
  workspace: string;
  branch: string;
}

/** Aggregate diff size for a worktree (Spec 02 §7.4). */
export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/** Result of committing a worktree's working tree. */
export interface CommitResult {
  committed: boolean;
  sha: string | null;
}

/** Result of merging a worker branch back into an integration branch (Spec 04 INTEGRATE). */
export interface MergeResult {
  clean: boolean;
  conflicted: boolean;
  conflictFiles: string[];
  mergeSha: string | null;
  stdout: string;
  stderr: string;
}

/** Optional author identity for commits (Beckett's identity, Spec 07). */
export interface CommitAuthor {
  name: string;
  email: string;
}

// =======================================================================================
// Worktree lifecycle
// =======================================================================================

/**
 * Allocate a worktree + branch for a worker (Spec 02 §8.1):
 *   git worktree add -b <branch> <workspace> <baseRef>
 * Creates the parent `.beckett/worktrees/` dir first. When `reuseIfExists` is set and the
 * worktree path already exists (resume), it is returned as-is.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeHandle> {
  const { repoRoot, workspace, branch, baseRef } = opts;
  const handle: WorktreeHandle = { repoRoot, workspace, branch };

  if (opts.reuseIfExists && existsSync(workspace)) {
    logger.info("reusing existing worktree", { workspace, branch });
    return handle;
  }

  mkdirSync(dirname(workspace), { recursive: true });

  // Proactive: a fresh/empty project has nothing to branch from. Creating a repo is reversible
  // (Spec 00 — proceed on reversible), so we init it + make an initial commit rather than
  // escalating "there are no commits". No-op when a commit already exists.
  await ensureBaseRepo(repoRoot);

  // If the branch already exists (e.g. a prior failed attempt), check it out instead of -b.
  const branchExists = (await runGit(["rev-parse", "--verify", "--quiet", branch], repoRoot)).code === 0;
  // The requested baseRef may not exist on a just-initialized repo (e.g. origin/main) — fall back to HEAD.
  const baseOk = (await runGit(["rev-parse", "--verify", "--quiet", baseRef], repoRoot)).code === 0;
  const effectiveBase = baseOk ? baseRef : "HEAD";
  const args = branchExists
    ? ["worktree", "add", workspace, branch]
    : ["worktree", "add", "-b", branch, workspace, effectiveBase];

  await git(args, repoRoot);
  logger.info("worktree created", { workspace, branch, baseRef: effectiveBase });
  return handle;
}

/**
 * Ensure `repoRoot` is a git repo with ≥1 commit so `git worktree add` has a base to branch from.
 * Proactive self-setup: a brand-new project (or an empty ~/projects) is initialized rather than
 * failing the dispatch. Idempotent — does nothing once a commit exists. Relies on the global git
 * identity (set at provisioning to Beckett's signed identity).
 */
async function ensureBaseRepo(repoRoot: string): Promise<void> {
  mkdirSync(repoRoot, { recursive: true });
  const isRepo = (await runGit(["rev-parse", "--is-inside-work-tree"], repoRoot)).code === 0;
  if (!isRepo) {
    await git(["init"], repoRoot);
    await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repoRoot);
    logger.info("git init (fresh project repo)", { repoRoot });
  }
  const hasCommit = (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot)).code === 0;
  if (!hasCommit) {
    await git(["commit", "--allow-empty", "-m", "init: beckett project"], repoRoot);
    logger.info("created initial commit", { repoRoot });
  }
}

/** Canonicalize a path for comparison (resolves symlinks like macOS /var → /private/var). */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True if `workspace` is a registered worktree of `repoRoot` (symlink-tolerant comparison). */
export async function worktreeExists(repoRoot: string, workspace: string): Promise<boolean> {
  const r = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return false;
  const target = canon(workspace);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ") && canon(line.slice("worktree ".length)) === target) return true;
  }
  return false;
}

/**
 * Tear down a worker's worktree after its diff has been captured/merged (Spec 02 §8.1):
 *   git worktree remove <workspace> --force ; git worktree prune
 * Idempotent — a missing worktree is not an error. Attempts the git removal unconditionally
 * (git path canonicalization makes a pre-check unreliable) and falls back to an fs removal +
 * prune so the directory and registration are always cleared.
 */
export async function removeWorktree(repoRoot: string, workspace: string): Promise<void> {
  const r = await runGit(["worktree", "remove", workspace, "--force"], repoRoot);
  if (r.code !== 0 && existsSync(workspace)) {
    logger.warn("git worktree remove failed; removing directory directly", {
      workspace,
      stderr: r.stderr.trim(),
    });
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (err) {
      logger.warn("fs worktree removal failed", { workspace, error: (err as Error).message });
    }
  }
  await runGit(["worktree", "prune"], repoRoot);
  logger.info("worktree removed", { workspace });
}

/**
 * Append ignore patterns to a worktree's git exclude file (`info/exclude`) so per-worker meta
 * files (the scope-guard settings + done schema) never appear in the worker's diff.
 */
export async function excludeFromGit(workspace: string, patterns: string[]): Promise<void> {
  const excludePathRaw = (await git(["rev-parse", "--git-path", "info/exclude"], workspace)).trim();
  // git may return a path relative to the worktree cwd; resolve via the worktree.
  const excludePath = excludePathRaw.startsWith("/") ? excludePathRaw : `${workspace}/${excludePathRaw}`;
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    /* file may not exist yet; create dir below */
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = patterns.filter((p) => !have.has(p));
  if (toAdd.length > 0) {
    appendFileSync(excludePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + toAdd.join("\n") + "\n");
  }
}

// =======================================================================================
// Diff readout (Spec 02 §7.4) — used by REVIEW, checkpoint, abort capture
// =======================================================================================

/**
 * Read the full diff of a worktree. Intent-to-adds untracked files first so new files are
 * visible. Diffs against `baseRef` when given (worker's net contribution vs the integration
 * base), else against HEAD (uncommitted working-tree changes).
 */
export async function readDiff(workspace: string, baseRef?: string): Promise<string> {
  await runGit(["add", "-A", "-N"], workspace); // intent-to-add untracked (no content staged)
  const r = await runGit(["diff", baseRef ?? "HEAD"], workspace);
  return r.stdout;
}

/** Diff size for a worktree via `git diff --numstat` (Spec 02 §7.4). Binary files counted as 1 file, 0/0. */
export async function readDiffStat(workspace: string, baseRef?: string): Promise<DiffStat> {
  await runGit(["add", "-A", "-N"], workspace);
  const r = await runGit(["diff", "--numstat", baseRef ?? "HEAD"], workspace);
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    files++;
    const [a, d] = line.split("\t");
    if (a && a !== "-") added += Number(a) || 0;
    if (d && d !== "-") removed += Number(d) || 0;
  }
  return { files, added, removed };
}

// =======================================================================================
// Commit + merge (INTEGRATE; Spec 04 / Spec 01 §3 step 9)
// =======================================================================================

/**
 * Commit all changes in a worktree onto its branch. Returns `{committed:false, sha:null}` when
 * the tree is already clean (nothing to do). v0 single-node still needs a commit so INTEGRATE
 * can merge the branch.
 */
export async function commitWorktree(
  workspace: string,
  message: string,
  author?: CommitAuthor,
): Promise<CommitResult> {
  await git(["add", "-A"], workspace);
  const status = (await runGit(["status", "--porcelain"], workspace)).stdout.trim();
  if (status === "") return { committed: false, sha: null };

  const env: Record<string, string> = author
    ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
    : {};
  const proc = Bun.spawn(["git", "commit", "-m", message], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stderr = await new Response(proc.stderr).text();
  await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git commit failed in ${workspace}: ${stderr.trim()}`);
  }
  const sha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  logger.info("worktree committed", { workspace, sha });
  return { committed: true, sha };
}

/**
 * Merge a worker branch into an integration branch (INTEGRATE = real `git merge`, Spec 04).
 * Runs in the main repo working dir. On conflict, leaves the merge in progress is undesirable
 * for a daemon, so we `--no-commit`-detect by attempting a normal merge and aborting on conflict,
 * returning the conflicted file list for an integration worker to resolve (Spec 01 §3 step 9).
 */
export async function mergeBranch(
  repoRoot: string,
  branch: string,
  into: string,
  author?: CommitAuthor,
): Promise<MergeResult> {
  // Ensure the integration branch exists and is checked out in the main repo dir.
  const intoExists = (await runGit(["rev-parse", "--verify", "--quiet", into], repoRoot)).code === 0;
  if (intoExists) {
    await git(["checkout", into], repoRoot);
  } else {
    await git(["checkout", "-b", into], repoRoot);
  }

  const env: Record<string, string> = author
    ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
    : {};
  const proc = Bun.spawn(["git", "merge", "--no-ff", "-m", `integrate ${branch}`, branch], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code === 0) {
    const mergeSha = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
    logger.info("merge clean", { branch, into, mergeSha });
    return { clean: true, conflicted: false, conflictFiles: [], mergeSha, stdout, stderr };
  }

  // Conflict (or other failure). Collect conflicted files, then abort so the repo is left clean.
  const conflictFiles = (await runGit(["diff", "--name-only", "--diff-filter=U"], repoRoot)).stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  await runGit(["merge", "--abort"], repoRoot);
  logger.warn("merge conflict", { branch, into, conflictFiles });
  return { clean: false, conflicted: conflictFiles.length > 0, conflictFiles, mergeSha: null, stdout, stderr };
}

/** Convenience: does this repo path have any commits yet (a valid HEAD)? */
export async function hasHead(repoRoot: string): Promise<boolean> {
  return (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot)).code === 0;
}
