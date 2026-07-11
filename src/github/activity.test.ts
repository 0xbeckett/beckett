import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatMergedPrLine,
  formatPushLine,
  GitHubActivityPoller,
  type GitHubActivityCommit,
  type GitHubMergedPullRequest,
} from "./activity.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as const;
const commit = (sha: string, author = "zoom"): GitHubActivityCommit => ({ sha, author, message: "work" });
const pr = (number: number, author = "zoom"): GitHubMergedPullRequest => ({
  number,
  author,
  title: `Ship ${number}`,
  mergedAt: "2026-07-11T00:00:00Z",
});

class Reader {
  commits: GitHubActivityCommit[][] = [];
  prs: GitHubMergedPullRequest[][] = [];
  async mainCommits(): Promise<GitHubActivityCommit[]> {
    return this.commits.length > 1 ? this.commits.shift()! : this.commits[0] ?? [];
  }
  async mergedPullRequests(): Promise<GitHubMergedPullRequest[]> {
    return this.prs.length > 1 ? this.prs.shift()! : this.prs[0] ?? [];
  }
}

function poller(reader: Reader, statePath?: string) {
  return new GitHubActivityPoller({
    reader,
    repo: "0xbeckett/beckett",
    branch: "main",
    ignoredAuthors: ["0xbeckett", "github-actions[bot]"],
    statePath,
    logger: quiet as never,
  });
}

describe("GitHubActivityPoller", () => {
  test("formats terse contributor push and merge lines", () => {
    expect(formatPushLine("zoom", [commit("abcdef123"), commit("123456789"), commit("fedcba987")])).toBe(
      "zoom pushed 3 commits to main (fedcba9)",
    );
    expect(formatMergedPrLine(pr(100))).toBe("PR #100 merged: Ship 100 by zoom");
  });

  test("baselines existing history, then groups external pushes and ignores deploy automation", async () => {
    const reader = new Reader();
    reader.commits = [[commit("a1", "zoom")], [commit("c3", "zoom"), commit("b2", "zoom"), commit("a1", "zoom")]];
    reader.prs = [[pr(10, "zoom")], [pr(11, "github-actions[bot]"), pr(10, "zoom")]];
    const p = poller(reader);

    expect(await p.poll()).toEqual([]); // startup baseline never replays repository history
    const events = await p.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "push",
      author: "zoom",
      line: "zoom pushed 2 commits to main (c3)",
    });
  });

  test("durable commit and PR watermarks prevent re-announcement after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-activity-"));
    const statePath = join(dir, "activity.json");
    try {
      const first = new Reader();
      first.commits = [[commit("a1")], [commit("b2"), commit("a1")]];
      first.prs = [[pr(10)], [pr(11), pr(10)]];
      const p1 = poller(first, statePath);
      await p1.poll();
      const emitted = await p1.poll();
      expect(emitted.map((event) => event.line)).toEqual([
        "zoom pushed 1 commit to main (b2)",
        "PR #11 merged: Ship 11 by zoom",
      ]);
      expect(existsSync(statePath)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ lastCommitSha: "b2", lastMergedPrNumber: 11 });

      const restarted = new Reader();
      restarted.commits = [[commit("b2"), commit("a1")]];
      restarted.prs = [[pr(11), pr(10)]];
      expect(await poller(restarted, statePath).poll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
