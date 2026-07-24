/**
 * Beckett v6 — the GitHub extension (`src/capability/modules/github.ts`)
 * =======================================================================================
 * The `beckett gh …` surface (stateless `gh`/`git` subprocesses, token from env — Spec 07
 * §3.2) on the v6 extension contract (Phase 4, docs/v6-architecture.md §6). Two entrypoints
 * share ONE client-construction core ({@link buildGh}: identity load + PAT preflight):
 *   - the CLI verb keeps its historical flag parse + `out`/`fail` contract byte-for-byte (the
 *     CLI characterization suite pins it; thrown core errors reach stderr via
 *     `main().catch(fail)`), and
 *   - the `github.*` capabilities are the v6 dispatch surface: zod-validated structured args
 *     in, an {@link ExtensionResult} out — never `out`/`fail` (those exit the process), so the
 *     daemon can dispatch them in-process through `ext.invoke`.
 *
 * WORKING DIR (the in-daemon hazard): the CLI defaults `dir` to `process.cwd()`; an in-daemon
 * invoke has no meaningful cwd, so {@link buildGh}'s `resolveRepoDir` THROWS unless `dir` is
 * supplied — repo-local operations (`push`, `repo-create --source/--push`) require it, while the
 * API-only operations (pr merge/status/review/close, repo star) never touch it.
 *
 * The declared manifest action-class stays FREE (exactly as the CLI has always behaved, and so
 * the {@link asCapability} projection the v5 spine registers is byte-identical). The real
 * postures live PER-CAPABILITY as forward catalog metadata (pr-merge → HANDSHAKE_GATED, push →
 * ALWAYS_ASK, …): they gate `ext.invoke` upstream, never the CLI subprocess (which carries no
 * agency gate). `createGithubCapability` remains the {@link asCapability} projection for the v5
 * factory table.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { GitHubCli, loadIdentity } from "../../agency/index.ts";
import { fail, out, parse } from "../../cli/io.ts";
import { buildGitHubPublishingGuidance } from "../../dispatch/publishing-guidance.ts";
import type { Config, Logger, MergeStrategy, ReviewParams } from "../../types.ts";

const CLI_USAGE = "beckett gh repo create|star|unstar | pr create|merge|close|status|review | push";

function quietLogger(): Logger {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return quiet;
}

/**
 * The one client-construction core both surfaces share: load the identity, PREFLIGHT the PAT
 * (throws the exact message the CLI has always printed), and build a {@link GitHubCli} whose
 * `resolveRepoDir` throws when a repo-local op needs a working dir the caller did not pass.
 * The token rides GH_TOKEN/the git credential helper per-invocation, so the parent never needs
 * `gh auth login`/`gh auth status`. (Spec 07 §3.2)
 */
function buildGh(config: Config, dir: string | undefined): GitHubCli {
  const identity = loadIdentity(config);
  if (!identity.github.pat) throw new Error("no GITHUB_PAT in ~/.beckett/.env — GitHub is unavailable");
  return new GitHubCli({
    pat: identity.github.pat,
    account: identity.github.account,
    owner: identity.github.owner,
    apiBase: identity.github.apiBase,
    resolveRepoDir: () => {
      if (!dir) throw new Error("github: this operation needs a working dir (pass `dir`)");
      return dir;
    },
    logger: quietLogger(),
  });
}

// ── v6 invocation schemas (one per gh operation, for routing prose + per-op posture) ─────────

const RepoCreateArgs = z.object({
  name: z.string().trim().min(1, "github.repo-create needs a repo name"),
  /** Private by default; pass true to create a public repo. */
  public: z.boolean().optional(),
  description: z.string().optional(),
  /** Local dir to initialize/push from (required if `push`). */
  dir: z.string().optional(),
  /** Push the local dir up after creating. */
  push: z.boolean().optional(),
});

const RepoStarArgs = z.object({
  repo: z.string().trim().min(1, "github.repo-star needs an owner/name repo"),
  /** true to star, false to unstar. */
  starred: z.boolean(),
});

const PrOpenArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-open needs a repo"),
  base: z.string().trim().min(1, "github.pr-open needs a base branch"),
  head: z.string().trim().min(1, "github.pr-open needs a head branch"),
  title: z.string().trim().min(1, "github.pr-open needs a title"),
  body: z.string(),
  draft: z.boolean().optional(),
});

const PrMergeArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-merge needs a repo"),
  number: z.number().int().positive("github.pr-merge needs a PR number"),
  strategy: z.enum(["squash", "merge", "rebase"]).optional(),
});

const PrCloseArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-close needs a repo"),
  number: z.number().int().positive("github.pr-close needs a PR number"),
});

const PrStatusArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-status needs a repo"),
  number: z.number().int().positive("github.pr-status needs a PR number"),
});

const PrReviewArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-review needs a repo"),
  number: z.number().int().positive("github.pr-review needs a PR number"),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
  body: z.string().optional(),
});

const PushArgs = z.object({
  repo: z.string().trim().min(1, "github.push needs an owner/name repo"),
  branch: z.string().trim().min(1, "github.push needs a remote branch"),
  /** Local ref to push (default HEAD). */
  ref: z.string().optional(),
  /** The worktree/checkout to push FROM — required in-daemon (no meaningful cwd). */
  dir: z.string().trim().min(1, "github.push needs a working dir (`dir`)"),
});

export const createGithubExtension: ExtensionFactory = ({ config }): Extension => {
  // The former `cli/beckett.ts::runGh`, observable behavior unchanged: flag parsing and every
  // usage failure stay here; client construction + the PAT preflight come from the shared
  // {@link buildGh} core, whose throws surface via main().catch(fail) with the same message.
  async function runGh(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const { _, flags } = parse(rest);
    // The CLI's historical default: repo-local ops run against the caller's cwd unless --dir.
    const gh = buildGh(config, flags.dir ? String(flags.dir) : process.cwd());

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

    fail(`usage: ${CLI_USAGE}`);
  }

  return {
    manifest: {
      id: "github",
      version: "1.0.0",
      summary: "stateless gh/git subprocesses, token from env (Spec 07 §3.2)",
      // FREE at the manifest layer so the asCapability projection stays byte-identical; the
      // real postures ride per-capability (below) as ext.invoke catalog metadata.
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch (per-op capabilities → precise routing + per-op posture) ---
    capabilities: [
      {
        id: "github.repo-create",
        description:
          "Create a new GitHub repository under Beckett's account (private by default). Optionally " +
          "initialize and push a local directory up in the same call. Reach for it when someone " +
          "asks to publish a project or start a new repo.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: RepoCreateArgs,
        examples: ["create a private repo called my-tool and push this folder"],
      },
      {
        id: "github.repo-star",
        description:
          "Star (or unstar) a GitHub repository as Beckett — a small, reversible endorsement. " +
          "Use for \"star anthropics/claude-code\" / \"unstar that repo\".",
        input: RepoStarArgs,
        examples: ["star anthropics/claude-code"],
      },
      {
        id: "github.pr-open",
        description:
          "Open a pull request from a head branch into a base branch on a repo. Use when work on " +
          "a branch is ready for review and someone asks to open/raise a PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrOpenArgs,
        examples: ["open a PR from feature/x into main on 0xbeckett/beckett"],
      },
      {
        id: "github.pr-merge",
        description:
          "Merge an open pull request (squash by default; merge/rebase available). This lands code " +
          "on the base branch — reach for it only when explicitly asked to merge a specific PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrMergeArgs,
        examples: ["merge PR 42 on 0xbeckett/beckett with squash"],
      },
      {
        id: "github.pr-close",
        description:
          "Close a pull request WITHOUT merging it. Use for \"close PR 42\" / \"drop that PR\".",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrCloseArgs,
        examples: ["close PR 42 on 0xbeckett/beckett"],
      },
      {
        id: "github.pr-status",
        description:
          "Read whether a pull request's checks are green. A pure read — use to answer \"is PR 42 " +
          "passing?\" before deciding to merge.",
        input: PrStatusArgs,
        examples: ["is PR 42 green on 0xbeckett/beckett?"],
      },
      {
        id: "github.pr-review",
        description:
          "Post a review on a pull request — APPROVE, REQUEST_CHANGES, or COMMENT with a body. " +
          "Use when asked to approve, request changes on, or comment-review a specific PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrReviewArgs,
        examples: ["approve PR 42 with a note that it looks good"],
      },
      {
        id: "github.push",
        description:
          "Push a local worktree's ref up to a remote branch on a repo. The most consequential gh " +
          "action — it must name the working directory to push FROM (`dir`). Use when a checkout " +
          "has commits that need to reach a branch on GitHub.",
        actionClass: ActionClass.ALWAYS_ASK,
        input: PushArgs,
        examples: ["push this worktree's HEAD to the branch feature/x on 0xbeckett/beckett"],
      },
    ],
    invoke: async (call) => {
      try {
        switch (call.capabilityId) {
          case "github.repo-create": {
            if (!call.origin?.userId) return { ok: false, error: "github: creating a repo needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof RepoCreateArgs>;
            const gh = buildGh(config, a.dir);
            const data = await gh.createRepo({
              name: a.name,
              private: !a.public,
              description: a.description,
              sourceDir: a.dir,
              push: Boolean(a.push),
            });
            return { ok: true, data };
          }
          case "github.repo-star": {
            const a = call.args as z.infer<typeof RepoStarArgs>;
            await buildGh(config, undefined).setRepoStar(a.repo, a.starred);
            return { ok: true, data: { starred: a.starred, repo: a.repo } };
          }
          case "github.pr-open": {
            if (!call.origin?.userId) return { ok: false, error: "github: opening a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrOpenArgs>;
            const data = await buildGh(config, undefined).openPR({
              repo: a.repo, base: a.base, head: a.head, title: a.title, body: a.body, draft: Boolean(a.draft),
            });
            return { ok: true, data };
          }
          case "github.pr-merge": {
            if (!call.origin?.userId) return { ok: false, error: "github: merging a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrMergeArgs>;
            const strategy = (a.strategy ?? "squash") as MergeStrategy;
            await buildGh(config, undefined).mergePR(a.repo, a.number, strategy);
            return { ok: true, data: { merged: true, repo: a.repo, number: a.number, strategy } };
          }
          case "github.pr-close": {
            if (!call.origin?.userId) return { ok: false, error: "github: closing a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrCloseArgs>;
            const data = await buildGh(config, undefined).closePR(a.repo, a.number);
            return { ok: true, data };
          }
          case "github.pr-status": {
            const a = call.args as z.infer<typeof PrStatusArgs>;
            const green = await buildGh(config, undefined).isGreen(a.repo, a.number);
            return { ok: true, data: { repo: a.repo, number: a.number, green } };
          }
          case "github.pr-review": {
            if (!call.origin?.userId) return { ok: false, error: "github: reviewing a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrReviewArgs>;
            await buildGh(config, undefined).reviewPR(a.repo, a.number, {
              event: (a.event ?? "COMMENT") as ReviewParams["event"],
              body: a.body ?? "",
            });
            return { ok: true, data: { reviewed: true, repo: a.repo, number: a.number } };
          }
          case "github.push": {
            if (!call.origin?.userId) return { ok: false, error: "github: pushing needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PushArgs>;
            await buildGh(config, a.dir).pushBranch(a.repo, a.ref ?? "HEAD", a.branch);
            return { ok: true, data: { pushed: true, repo: a.repo, branch: a.branch } };
          }
          default:
            return { ok: false, error: `github: unknown capability "${call.capabilityId}"` };
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "gh repo|pr|push",
    skillDoc: ".claude/skills/github/SKILL.md",
    cliVerbs: [
      {
        name: "gh",
        summary: "repo create/star, PR create/merge/close/status/review, branch push",
        usage: CLI_USAGE,
        run: runGh,
      },
    ],
    busCommands: [],
    // The GitHub ownership contract in every worker persona (composed into the system append by
    // `stages.ts::workerSystemAppend`). Priority 10 keeps the historical persona order:
    // guidance → stage extras (20) → the deploy recipe (30). asCapability projects it, so the
    // factory-table wrapper keeps the worker-append composition intact.
    promptBlock: {
      id: "github",
      priority: 10,
      render: ({ config: liveConfig, slug, env }) =>
        slug ? buildGitHubPublishingGuidance(slug, liveConfig, env ?? process.env) : "",
    },
  };
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createGithubCapability(deps: CapabilityDeps): Capability {
  return asCapability(createGithubExtension(deps));
}
