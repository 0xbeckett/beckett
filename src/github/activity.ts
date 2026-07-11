/**
 * External activity relay for one GitHub repository.
 *
 * Polls the repository's main-branch commits and merged pull requests, persists a compact
 * watermark, and emits already-terse Discord log lines. The poller deliberately has no Discord
 * dependency: callers own delivery, while this class owns read/diff/persist semantics.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";

export interface GitHubActivityCommit {
  sha: string;
  author: string;
  message: string;
}

export interface GitHubMergedPullRequest {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
}

/** Read boundary implemented by GitHubCli; the poller never shells out itself. */
export interface GitHubActivityReader {
  mainCommits(repo: string, branch: string): Promise<GitHubActivityCommit[]>;
  mergedPullRequests(repo: string): Promise<GitHubMergedPullRequest[]>;
}

export type GitHubActivityEvent =
  | { kind: "push"; author: string; commits: GitHubActivityCommit[]; branch: string; line: string }
  | { kind: "merged"; pr: GitHubMergedPullRequest; line: string };

interface ActivityState {
  lastCommitSha?: string;
  /** Retained for simple inspection/backward compatibility with the original watermark. */
  lastMergedPrNumber?: number;
  /**
   * PR numbers are allocated when a PR opens, not when it merges. A high-numbered PR can merge
   * before an older one, so `lastMergedPrNumber` alone would silently miss that later merge.
   * Keep the observed merged ids too: this repository-sized cursor is what makes every PR number
   * exactly-once across restarts.
   */
  seenMergedPrNumbers?: number[];
}

export interface GitHubActivityPollerDeps {
  reader: GitHubActivityReader;
  repo: string;
  branch?: string;
  ignoredAuthors?: string[];
  pollSecs?: number;
  statePath?: string;
  logger?: Logger;
}

export type GitHubActivitySink = (events: GitHubActivityEvent[]) => void | Promise<void>;

/** A short dev-feed line for one contributor's contiguous push batch. */
export function formatPushLine(author: string, commits: GitHubActivityCommit[], branch = "main"): string {
  const count = commits.length;
  const sha = commits.at(-1)?.sha.slice(0, 7) || "unknown";
  return `${author || "someone"} pushed ${count} ${count === 1 ? "commit" : "commits"} to ${branch} (${sha})`;
}

/** A short dev-feed line for a merged pull request. */
export function formatMergedPrLine(pr: GitHubMergedPullRequest): string {
  return `PR #${pr.number} merged: ${pr.title || "(untitled)"} by ${pr.author || "someone"}`;
}

/**
 * Restart-safe, non-overlapping activity loop. First successful read only establishes the
 * watermarks: old repository history must never be replayed into Discord on daemon boot.
 */
export class GitHubActivityPoller {
  private readonly reader: GitHubActivityReader;
  private readonly repo: string;
  private readonly branch: string;
  private readonly ignoredAuthors: Set<string>;
  private readonly pollSecs: number;
  private readonly statePath?: string;
  private readonly logger: Logger;
  private state: ActivityState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private sink: GitHubActivitySink | null = null;

  constructor(deps: GitHubActivityPollerDeps) {
    this.reader = deps.reader;
    this.repo = deps.repo;
    this.branch = deps.branch ?? "main";
    this.ignoredAuthors = new Set((deps.ignoredAuthors ?? []).map((author) => author.toLowerCase()));
    this.pollSecs = deps.pollSecs ?? 60;
    this.statePath = deps.statePath;
    this.logger = deps.logger ?? log.child("github.activity");
    this.state = this.load();
  }

  /** One safe poll. Successful source watermarks persist before events are handed to Discord. */
  async poll(): Promise<GitHubActivityEvent[]> {
    const [commitsResult, prsResult] = await Promise.allSettled([
      this.reader.mainCommits(this.repo, this.branch),
      this.reader.mergedPullRequests(this.repo),
    ]);
    const events: GitHubActivityEvent[] = [];
    let changed = false;

    if (commitsResult.status === "fulfilled") {
      const commits = commitsResult.value.filter((commit) => Boolean(commit.sha)); // newest first from GitHub
      const previous = this.state.lastCommitSha;
      if (commits.length === 0 && previous === undefined) {
        // Persist an empty baseline too: a repository created after daemon boot must announce its
        // first commit rather than mistaking it for old history.
        this.state.lastCommitSha = "";
        changed = true;
      } else if (commits.length > 0) {
        if (previous === undefined) {
          // First observation is a baseline, not an announcement.
          this.state.lastCommitSha = commits[0]!.sha;
          changed = true;
        } else {
          const watermarkIndex = commits.findIndex((commit) => commit.sha === previous);
          // If a force-push or a >100-commit burst displaced our SHA, use the returned range. It
          // may omit deleted history, but each observed SHA still advances the durable watermark.
          const unseen = (watermarkIndex >= 0 ? commits.slice(0, watermarkIndex) : commits).reverse();
          events.push(...this.pushEvents(unseen));
          this.state.lastCommitSha = commits[0]!.sha;
          changed = true;
        }
      }
    } else {
      this.logger.warn("main commit read failed — skipping this source", { error: String(commitsResult.reason) });
    }

    if (prsResult.status === "fulfilled") {
      const prs = prsResult.value.filter((pr) => Number.isInteger(pr.number) && pr.number > 0);
      const maxNumber = prs.reduce((max, pr) => Math.max(max, pr.number), 0);
      const known = this.state.seenMergedPrNumbers;
      if (known === undefined) {
        // First observation (and old state files written before the id cursor existed) is a
        // baseline, never a replay. Store every observed id: PR numbers reflect creation order,
        // so a lower-numbered PR can merge after a higher-numbered one.
        this.state.seenMergedPrNumbers = prs.map((pr) => pr.number);
        this.state.lastMergedPrNumber = maxNumber;
        changed = true;
      } else {
        const seen = new Set(known);
        for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
          if (seen.has(pr.number)) continue;
          seen.add(pr.number);
          if (!this.isIgnored(pr.author)) {
            events.push({ kind: "merged", pr, line: formatMergedPrLine(pr) });
          }
        }
        // Persist suppression decisions as seen too: changing config/restarting must never turn a
        // bot/deploy merge into an old "new" event. The list remains tiny for this one repository.
        this.state.seenMergedPrNumbers = [...seen].sort((a, b) => a - b);
        this.state.lastMergedPrNumber = Math.max(this.state.lastMergedPrNumber ?? 0, maxNumber);
        changed = true;
      }
    } else {
      this.logger.warn("merged PR read failed — skipping this source", { error: String(prsResult.reason) });
    }

    // Persist before delivery: a crash or Discord timeout cannot make an event re-fire after a
    // restart. This intentionally prefers a rare lost notification over duplicate dev-feed spam.
    if (changed) this.persist();
    return events;
  }

  async start(onEvents: GitHubActivitySink): Promise<void> {
    if (this.timer) return;
    this.sink = onEvents;
    this.logger.info("github activity relay started", { repo: this.repo, branch: this.branch, pollSecs: this.pollSecs });
    void this.tickOnce();
    this.timer = setInterval(() => void this.tickOnce(), this.pollSecs * 1000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.sink = null;
    this.logger.info("github activity relay stopped");
  }

  private pushEvents(commits: GitHubActivityCommit[]): GitHubActivityEvent[] {
    const events: GitHubActivityEvent[] = [];
    let group: GitHubActivityCommit[] = [];
    let author = "";
    const flush = () => {
      if (group.length > 0 && !this.isIgnored(author)) {
        events.push({ kind: "push", author, commits: group, branch: this.branch, line: formatPushLine(author, group, this.branch) });
      }
      group = [];
    };
    // A batch can contain several people. Preserve chronological runs so the line honestly names
    // the contributor who made those commits, while a normal multi-commit push remains one line.
    for (const commit of commits) {
      const nextAuthor = commit.author || "someone";
      if (group.length > 0 && nextAuthor.toLowerCase() !== author.toLowerCase()) flush();
      if (group.length === 0) author = nextAuthor;
      group.push(commit);
    }
    flush();
    return events;
  }

  private isIgnored(author: string): boolean {
    return this.ignoredAuthors.has(author.trim().toLowerCase());
  }

  private async tickOnce(): Promise<void> {
    if (this.ticking || !this.sink) return;
    this.ticking = true;
    try {
      const events = await this.poll();
      if (events.length > 0) await this.sink(events);
    } catch (err) {
      this.logger.error("github activity relay tick failed", { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private load(): ActivityState {
    if (!this.statePath || !existsSync(this.statePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as ActivityState;
      return {
        ...(typeof raw.lastCommitSha === "string" ? { lastCommitSha: raw.lastCommitSha } : {}),
        ...(typeof raw.lastMergedPrNumber === "number" && raw.lastMergedPrNumber >= 0
          ? { lastMergedPrNumber: raw.lastMergedPrNumber }
          : {}),
        ...(Array.isArray(raw.seenMergedPrNumbers) && raw.seenMergedPrNumbers.every((n) => Number.isInteger(n) && n > 0)
          ? { seenMergedPrNumbers: [...new Set(raw.seenMergedPrNumbers)] }
          : {}),
      };
    } catch (err) {
      this.logger.warn("github activity state unreadable; baselining on next poll", { path: this.statePath, error: String(err) });
      return {};
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      renameSync(temporary, this.statePath);
    } catch (err) {
      this.logger.warn("github activity state persist failed", { path: this.statePath, error: String(err) });
    }
  }
}

export function createGitHubActivityPoller(deps: GitHubActivityPollerDeps): GitHubActivityPoller {
  return new GitHubActivityPoller(deps);
}
