import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** A cached, git-history-derived view of the projects Beckett has locally. */
export interface CodeStatsDataset {
  schema_version: 1;
  generated_at: string;
  projects_root: string;
  headline: CodeStatsHeadline;
  projects: CodeStatsProject[];
  authors: CodeStatsAuthor[];
  velocity: CodeStatsVelocity[];
}

export interface CodeStatsHeadline {
  commits: number;
  files: number;
  projects: number;
  additions: number;
  deletions: number;
  net: number;
}

export interface CodeStatsProject {
  repo: string;
  path: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  net: number;
  first_commit: string | null;
  last_commit: string | null;
}

export interface CodeStatsAuthor {
  /** A stable display identity. Name alone is ambiguous when people change emails. */
  author: string;
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
  net: number;
}

export interface CodeStatsVelocity {
  /** UTC author-date calendar day (YYYY-MM-DD). */
  date: string;
  commits: number;
}

export interface CodeStatsHarvestOptions {
  output: string;
  projectsDir: string;
  note?: (message: string) => void;
}

type Commit = {
  hash: string;
  name: string;
  email: string;
  date: string;
  additions: number;
  deletions: number;
};

const number = (value: string): number => /^\d+$/.test(value) ? Number(value) : 0;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * Git's numstat has no reliable line delimiter for unusual path names. Separating commits
 * with ASCII record/unit separators keeps the metadata independent of those paths; we only
 * consume the first two tab-separated numeric fields on each numstat line.
 */
export function parseGitLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const [header = "", ...stats] = record.split("\n");
    const [hash, name, email, date] = header.split("\x1f");
    if (!hash || !name || !email || !date) continue;
    let additions = 0;
    let deletions = 0;
    for (const stat of stats) {
      const [added, deleted] = stat.split("\t", 3);
      // Binary changes are represented as "-\t-" and deliberately contribute zero LOC.
      additions += number(added ?? "");
      deletions += number(deleted ?? "");
    }
    commits.push({ hash, name, email, date, additions, deletions });
  }
  return commits;
}

async function projectNames(projectsDir: string, note: (message: string) => void): Promise<string[]> {
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    note(`projects root absent/unreadable: ${projectsDir} (${(error as Error).message})`);
    return [];
  }
}

async function harvestProject(path: string, repo: string): Promise<{ project: CodeStatsProject; commits: Commit[] } | null> {
  if (await git(path, ["rev-parse", "--is-inside-work-tree"]) !== "true\n") return null;
  const [log, files] = await Promise.all([
    git(path, ["log", "--numstat", "--format=%x1e%H%x1f%an%x1f%ae%x1f%aI", "HEAD"]),
    git(path, ["ls-files", "-z"]),
  ]);
  if (log === null || files === null) return null;
  const commits = parseGitLog(log);
  const additions = commits.reduce((sum, commit) => sum + commit.additions, 0);
  const deletions = commits.reduce((sum, commit) => sum + commit.deletions, 0);
  const dated = commits.map((commit) => commit.date).filter((date) => Number.isFinite(Date.parse(date))).sort();
  return {
    project: {
      repo,
      path,
      commits: commits.length,
      files: files ? files.split("\0").filter(Boolean).length : 0,
      additions,
      deletions,
      net: additions - deletions,
      first_commit: dated[0] ?? null,
      last_commit: dated.at(-1) ?? null,
    },
    commits,
  };
}

/**
 * Read local git history once and atomically cache the reusable aggregates. This never clones,
 * fetches, or contacts GitHub; dashboard builds consume the resulting JSON instead of git.
 */
export async function harvestCodeStats(options: CodeStatsHarvestOptions): Promise<CodeStatsDataset> {
  const note = options.note ?? ((message: string) => console.error(`[code-stats] ${message}`));
  const projects: CodeStatsProject[] = [];
  const authors = new Map<string, CodeStatsAuthor>();
  const velocity = new Map<string, number>();

  for (const repo of await projectNames(options.projectsDir, note)) {
    const path = join(options.projectsDir, repo);
    const result = await harvestProject(path, repo);
    if (!result) continue;
    projects.push(result.project);
    for (const commit of result.commits) {
      const author = `${commit.name} <${commit.email}>`;
      const current = authors.get(author) ?? {
        author, name: commit.name, email: commit.email, commits: 0, additions: 0, deletions: 0, net: 0,
      };
      current.commits += 1;
      current.additions += commit.additions;
      current.deletions += commit.deletions;
      current.net = current.additions - current.deletions;
      authors.set(author, current);
      const day = commit.date.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) velocity.set(day, (velocity.get(day) ?? 0) + 1);
    }
  }

  const headline = projects.reduce<CodeStatsHeadline>((total, project) => ({
    commits: total.commits + project.commits,
    files: total.files + project.files,
    projects: total.projects + 1,
    additions: total.additions + project.additions,
    deletions: total.deletions + project.deletions,
    net: total.net + project.net,
  }), { commits: 0, files: 0, projects: 0, additions: 0, deletions: 0, net: 0 });
  const dataset: CodeStatsDataset = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    projects_root: options.projectsDir,
    headline,
    projects: projects.sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo)),
    authors: [...authors.values()].sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author)),
    velocity: [...velocity.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, commits]) => ({ date, commits })),
  };

  await mkdir(dirname(options.output), { recursive: true });
  const temporaryOutput = `${options.output}.${process.pid}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(dataset, null, 2)}\n`);
  await rename(temporaryOutput, options.output);
  note(`wrote ${headline.commits} commits across ${headline.projects} projects to ${options.output}`);
  return dataset;
}

export function defaultCodeStatsOptions(cwd = process.cwd(), env = process.env): CodeStatsHarvestOptions {
  const home = env.HOME ?? ".";
  return {
    output: resolve(cwd, "data/code-stats.json"),
    projectsDir: env.BECKETT_PROJECTS_DIR ?? join(home, "Projects"),
  };
}
