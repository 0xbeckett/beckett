/** Aggregate local branch metrics for the Discord branch card, without touching the git index. */
import { parseNumstat } from "./diff.ts";

export interface LocalBranchStats {
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BranchStatsGitRunner = (args: string[], cwd: string) => Promise<GitResult>;

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function gitError(args: string[], cwd: string, result: GitResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`git ${args.join(" ")} failed (${result.code}) in ${cwd}${detail ? `: ${detail}` : ""}`);
}

/**
 * Count a branch's full contribution relative to `baseRef`: committed, staged, unstaged, and
 * untracked files. Unlike the existing review helper, this never uses `git add -N`, so asking for a
 * status card cannot alter a live worker's index.
 */
export async function readLocalBranchStats(
  workspace: string,
  baseRef: string,
  runner: BranchStatsGitRunner = runGit,
): Promise<LocalBranchStats> {
  if (!workspace.trim() || !baseRef.trim()) throw new Error("local branch stats need workspace and baseRef");

  const verifyArgs = ["rev-parse", "--verify", `${baseRef}^{commit}`];
  const verified = await runner(verifyArgs, workspace);
  if (verified.code !== 0) throw gitError(verifyArgs, workspace, verified);

  const acc = { added: 0, removed: 0, paths: new Set<string>() };
  const diffArgs = ["diff", "--numstat", baseRef, "--"];
  const diff = await runner(diffArgs, workspace);
  if (diff.code !== 0) throw gitError(diffArgs, workspace, diff);
  parseNumstat(diff.stdout, acc);

  const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
  const untracked = await runner(untrackedArgs, workspace);
  if (untracked.code !== 0) throw gitError(untrackedArgs, workspace, untracked);
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
  for (const path of untrackedPaths) {
    const args = ["diff", "--no-index", "--numstat", "--", "/dev/null", path];
    const stat = await runner(args, workspace);
    // `git diff --no-index` returns 1 when the files differ; that is its successful data path.
    if (stat.code !== 0 && stat.code !== 1) throw gitError(args, workspace, stat);
    parseNumstat(stat.stdout, acc);
  }

  const commitArgs = ["rev-list", "--count", `${baseRef}..HEAD`, "--"];
  const commitResult = await runner(commitArgs, workspace);
  if (commitResult.code !== 0) throw gitError(commitArgs, workspace, commitResult);
  const commits = Number(commitResult.stdout.trim());
  if (!Number.isInteger(commits) || commits < 0) {
    throw new Error(`git rev-list returned an invalid commit count in ${workspace}`);
  }

  return {
    additions: acc.added,
    deletions: acc.removed,
    changedFiles: acc.paths.size,
    commits,
  };
}
