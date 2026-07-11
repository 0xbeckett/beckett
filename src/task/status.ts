/** Assemble user-facing task/branch status without exposing Plane ticket identifiers or patches. */
import { existsSync } from "node:fs";
import type { GitHubBranchCardReader, BranchCardCheckSummary, PrLifecycle } from "../github/types.ts";
import { readLocalBranchStats, type LocalBranchStats } from "../git/branch-stats.ts";
import { gitBranchForTicket } from "../git/branch-name.ts";
import type { TaskBranchStatus, TaskStore } from "./store.ts";

export interface BranchCardSnapshot {
  ref: string;
  title: string;
  taskNumber: number;
  taskTitle: string;
  status: TaskBranchStatus;
  source: "local" | "published" | "pull_request";
  gitRef?: string;
  repo?: string;
  changes?: { additions: number; deletions: number; files: number; commits: number };
  pullRequest?: { number: number; url: string; state: PrLifecycle; draft: boolean };
  publication?: { url: string; kind: "pushed" | "pr" };
  checks?: BranchCardCheckSummary;
  review?: { decision: string; count: number };
  discussion?: { comments: number };
  updatedAt: string;
}

export interface BranchStatusServiceOptions {
  store: TaskStore;
  github?: GitHubBranchCardReader;
  githubOwner?: string;
  localStats?: (workspace: string, baseRef: string) => Promise<LocalBranchStats>;
}

export class BranchStatusService {
  private readonly localStats: (workspace: string, baseRef: string) => Promise<LocalBranchStats>;

  constructor(private readonly opts: BranchStatusServiceOptions) {
    this.localStats = opts.localStats ?? readLocalBranchStats;
  }

  async read(ref: string): Promise<BranchCardSnapshot> {
    const found = this.opts.store.getBranch(ref);
    if (!found) throw new Error(`no such task branch: #${ref.replace(/^#/, "")}`);
    const { task, branch } = found;
    const gitRef = branch.git?.gitRef ?? (branch.ticket
      ? gitBranchForTicket({ identifier: branch.ticket.identifier, branchRef: branch.ref })
      : undefined);

    if (branch.pullRequest) {
      if (!this.opts.github) throw new Error(`GitHub status is unavailable for published branch #${branch.ref}`);
      const card = await this.opts.github.branchCard(branch.pullRequest.repo, branch.pullRequest.number);
      return {
        ref: branch.ref,
        title: branch.title,
        taskNumber: task.number,
        taskTitle: task.title,
        status: branch.status,
        source: "pull_request",
        gitRef: card.headRefName || gitRef,
        repo: card.repo,
        changes: {
          additions: card.additions,
          deletions: card.deletions,
          files: card.changedFiles,
          commits: card.commits,
        },
        pullRequest: { number: card.number, url: card.url, state: card.state, draft: card.isDraft },
        checks: card.checks,
        review: { decision: card.reviewDecision, count: card.reviewCount },
        discussion: { comments: card.commentCount },
        updatedAt: card.updatedAt || branch.updatedAt,
      };
    }

    let changes = branch.diff
      ? {
          additions: branch.diff.additions,
          deletions: branch.diff.deletions,
          files: branch.diff.files,
          commits: branch.diff.commits,
        }
      : undefined;
    // `branch.diff` is captured immediately before publication can rebase this checkout onto a
    // newer main. Once present it is authoritative; recomputing from the still-live, post-rebase
    // worktree would count parallel branches that landed first.
    if (!changes && branch.git?.workspace && branch.git.baseSha && existsSync(branch.git.workspace)) {
      const stats = await this.localStats(branch.git.workspace, branch.git.baseSha);
      changes = {
        additions: stats.additions,
        deletions: stats.deletions,
        files: stats.changedFiles,
        commits: stats.commits,
      };
    }
    const project = branch.git?.project ?? task.project;
    return {
      ref: branch.ref,
      title: branch.title,
      taskNumber: task.number,
      taskTitle: task.title,
      status: branch.status,
      source: branch.publication ? "published" : "local",
      ...(gitRef ? { gitRef } : {}),
      ...(branch.publication
        ? { repo: branch.publication.repo, publication: { url: branch.publication.url, kind: branch.publication.kind } }
        : project && this.opts.githubOwner
          ? { repo: `${this.opts.githubOwner}/${project}` }
          : {}),
      ...(changes ? { changes } : {}),
      updatedAt: branch.updatedAt,
    };
  }
}

export function createBranchStatusService(opts: BranchStatusServiceOptions): BranchStatusService {
  return new BranchStatusService(opts);
}
