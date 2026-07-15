/**
 * Beckett v5 — the GitHub capability module (`src/capability/modules/github.ts`)
 * =======================================================================================
 * The `beckett gh …` surface (stateless `gh`/`git` subprocesses, token from env — Spec 07
 * §3.2), normalized onto the common factory shape (V5 Phase 2). The handler body is the
 * former `cli/beckett.ts::runGh` moved verbatim; the CLI characterization suite pins its
 * observable behavior byte-for-byte.
 *
 * The declared action-class stays FREE at this layer, exactly as the CLI has always behaved:
 * the fine-grained per-action classification (pr.merge → HANDSHAKE_GATED, push to a shared
 * branch → ALWAYS_ASK, …) lives in `classifyAction` (`agency/index.ts`) and gates the
 * concierge's agency path, not the CLI subprocess.
 */

import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { GitHubCli, loadIdentity } from "../../agency/index.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { Logger, MergeStrategy, ReviewParams } from "../../types.ts";

export function createGithubCapability({ config }: CapabilityDeps): Capability {
  // The token rides GH_TOKEN/the git credential helper per-invocation, so the parent NEVER
  // needs `gh auth login`/`gh auth status` — it just calls `beckett gh ...`. (Spec 07 §3.2)
  async function runGh(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const identity = loadIdentity(config);
    if (!identity.github.pat) fail("no GITHUB_PAT in ~/.beckett/.env — GitHub is unavailable");
    const { _, flags } = parse(rest);
    const dir = flags.dir ? String(flags.dir) : process.cwd();
    const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
    const gh = new GitHubCli({
      pat: identity.github.pat,
      account: identity.github.account,
      owner: identity.github.owner,
      apiBase: identity.github.apiBase,
      resolveRepoDir: () => dir,
      logger: quiet,
    });

    if (sub === "repo" && _[0] === "create") {
      const name = _[1];
      if (!name) fail("usage: beckett gh repo create <name> [--public] [--desc <d>] [--source <dir>] [--push]");
      out(await gh.createRepo({
        name,
        private: !flags.public,
        description: flags.desc ? String(flags.desc) : undefined,
        sourceDir: flags.source ? String(flags.source) : undefined,
        push: Boolean(flags.push),
      }));
    }

    if (sub === "repo" && (_[0] === "star" || _[0] === "unstar")) {
      const repo = _[1];
      if (!repo) fail(`usage: beckett gh repo ${_[0]} <owner/name>`);
      const starred = _[0] === "star";
      await gh.setRepoStar(repo, starred);
      out({ starred, repo });
    }

    if (sub === "pr") {
      const action = _[0];
      const repo = flags.repo ? String(flags.repo) : "";
      const n = Number(_[1]);
      if (action === "create") {
        for (const k of ["repo", "base", "head", "title", "body"]) if (!flags[k]) fail(`gh pr create needs --${k}`);
        out(await gh.openPR({
          repo, base: String(flags.base), head: String(flags.head),
          title: String(flags.title), body: String(flags.body), draft: Boolean(flags.draft),
        }));
      }
      if (action === "merge") {
        if (!repo || !n) fail("usage: beckett gh pr merge <num> --repo <owner/name> [--strategy squash|merge|rebase]");
        const strategy = (flags.strategy ? String(flags.strategy) : "squash") as MergeStrategy;
        await gh.mergePR(repo, n, strategy);
        out({ merged: true, repo, number: n, strategy });
      }
      if (action === "close") {
        if (!n) fail("usage: beckett gh pr close <num> [--repo <owner/name>]");
        out(await gh.closePR(repo, n));
      }
      if (action === "status") {
        if (!repo || !n) fail("usage: beckett gh pr status <num> --repo <owner/name>");
        out({ repo, number: n, green: await gh.isGreen(repo, n) });
      }
      if (action === "review") {
        if (!repo || !n) fail("usage: beckett gh pr review <num> --repo <r> --event APPROVE|REQUEST_CHANGES|COMMENT --body <b>");
        await gh.reviewPR(repo, n, { event: String(flags.event ?? "COMMENT") as ReviewParams["event"], body: String(flags.body ?? "") });
        out({ reviewed: true, repo, number: n });
      }
      fail("usage: beckett gh pr create|merge|close|status|review <num> --repo <owner/name> ...");
    }

    if (sub === "push") {
      if (!flags.repo || !flags.branch) fail("usage: beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref <localRef>] [--dir <d>]");
      await gh.pushBranch(String(flags.repo), flags.ref ? String(flags.ref) : "HEAD", String(flags.branch));
      out({ pushed: true, repo: String(flags.repo), branch: String(flags.branch) });
    }

    fail("usage: beckett gh repo create|star|unstar | pr create|merge|close|status|review | push");
  }

  return {
    id: "github",
    summary: "stateless gh/git subprocesses, token from env (Spec 07 §3.2)",
    actionClass: ActionClass.FREE,
    cliHelp: "gh repo|pr|push",
    cliVerbs: [
      {
        name: "gh",
        summary: "repo create/star, PR create/merge/close/status/review, branch push",
        usage: "beckett gh repo create|star|unstar | pr create|merge|close|status|review | push",
        run: runGh,
      },
    ],
    busCommands: [],
    skillDoc: ".claude/skills/github/SKILL.md",
  };
}
