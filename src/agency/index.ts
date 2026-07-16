/**
 * Beckett — Identity & Agency: the action-class gate + GitHub agency (`src/agency/index.ts`)
 * =======================================================================================
 * Implements the {@link Agency} contract (Spec 07): the single choke point through which
 * every outward action funnels, classified as one of three classes —
 *
 *   - **FREE** — reversible/internal (branch, commit, PR-open/update, comment/review,
 *     email read/label/draft): just do it, log it. The default and the bulk of activity.
 *   - **HANDSHAKE_GATED** — outbound but expected (merge-to-main, email-send): do all the
 *     work up to the irreversible click, stage a {@link PendingAction}, surface the
 *     **delivery handshake** ("PR's up — review or merge?"), and execute only on a `go`.
 *   - **ALWAYS_ASK** — dangerous/irreversible-at-scale (force-push shared, repo/account
 *     admin, permanent delete, deploy/publish/money): refused on the unattended path.
 *
 * `classify()` is **pure and total** — an unknown action type defaults to ALWAYS_ASK
 * (fail-closed, Spec 07 §2.3). This is the security invariant: if it isn't classified FREE
 * or HANDSHAKE_GATED, it cannot happen on the autonomous path.
 *
 * GitHub agency (Spec 07 §3) rides a single fine-grained PAT (env `GITHUB_PAT`) for both git
 * transport (`git push` via a credential helper that reads the PAT from the *environment*,
 * never argv) and the API (`gh` CLI with `GH_TOKEN`). If `GITHUB_PAT` is absent, GitHub work
 * **degrades gracefully**: branch + diff stay local, and delivery reports
 * {@link PR_PENDING_CREDS_NOTE} — that is correct v0 behavior, not a stub.
 *
 * Gmail is OUT of v0 scope (Spec 12 §3): the taxonomy stays *aware* of `gmail.*` (classify
 * still routes draft→FREE, send→HANDSHAKE_GATED), and the send handshake string exists, but
 * no mail client is implemented here.
 */

import { join } from "node:path";
import type {
  ActionType,
  ActionContext,
  GateActionResult,
  HandshakeSpec,
  PendingAction,
  PendingActionClass,
  GitHubClient,
  OpenPRParams,
  UpdatePRParams,
  ReviewParams,
  MergeStrategy,
  Identity,
  GmailAuth,
  Config,
  Paths,
  Logger,
} from "../types.ts";
import { ActionClass } from "../types.ts";
import type {
  BranchCardCheckSummary,
  GitHubBranchCard,
  GitHubBranchCardReader,
  GitHubPrReader,
  PrSignals,
} from "../github/types.ts";
import type { GitHubActivityCommit, GitHubActivityReader, GitHubMergedPullRequest } from "../github/activity.ts";
import { pendingActionId } from "../ids.ts";
import { log as rootLog } from "../log.ts";
import { childEnv } from "../env.ts";
import { SCAFFOLDING_DIR } from "../worker/worktree.ts";
import { resolveGitHubTarget } from "../github/owner.ts";

// =======================================================================================
// Errors
// =======================================================================================

/**
 * Thrown by {@link BeckettAgency.perform} for an ALWAYS_ASK action on the unattended path
 * (Spec 07 §2.4). There is no `refused` member of {@link GateActionResult} by design — the
 * gate refuses by throwing, fail-closed.
 */
export class GateRefused extends Error {
  constructor(
    readonly actionType: ActionType,
    readonly context: ActionContext,
  ) {
    super(
      `agency: action "${actionType}" is ALWAYS_ASK and cannot be performed unattended ` +
        `(Spec 07 §2.3) — it requires an explicit, specific jawrooo instruction`,
    );
    this.name = "GateRefused";
  }
}

/**
 * Thrown by the GitHub client when no `GITHUB_PAT` is configured. Callers (DELIVER) catch
 * this and degrade to a local branch + {@link PR_PENDING_CREDS_NOTE} (Spec 07 §3; v0 brief).
 */
export class GitHubUnavailableError extends Error {
  constructor(op: string) {
    super(`agency.github: cannot ${op} — GITHUB_PAT is not configured (work stays local)`);
    this.name = "GitHubUnavailableError";
  }
}

// =======================================================================================
// Handshake prompt strings (Spec 07 §3.4 / §4.4; Spec 00 §3 DELIVER)
// =======================================================================================

/** The canonical short merge handshake from Spec 00 §3 DELIVER. */
export const MERGE_HANDSHAKE_SHORT = "PR's up — review or merge?";

/** The canonical send handshake (Gmail is out of v0 scope; kept for taxonomy awareness). */
export const SEND_EMAIL_HANDSHAKE = "drafted it — send as me, or you handle it?";

/**
 * The DELIVER note when GitHub creds are absent: the work is real and on a local branch,
 * the PR just can't be opened yet (Spec 07 §3; v0 brief — this is correct, not a failure).
 */
export const PR_PENDING_CREDS_NOTE =
  "PR pending GitHub creds — the work is committed on a local branch; " +
  "add GITHUB_PAT to ~/.beckett/.env and I'll push it and open the PR.";

/** The full, voiced merge handshake line (Spec 07 §3.4). */
export function mergeHandshakePrompt(opts: {
  prNumber: number;
  taskTitle?: string;
  base?: string;
}): string {
  const what = opts.taskTitle ? `I finished ${opts.taskTitle}. ` : "";
  const base = opts.base ?? "main";
  return `${what}PR #${opts.prNumber} is up and green — want to review it yourself, or should I merge to ${base}?`;
}

/**
 * Build the {@link HandshakeSpec} for a merge-to-main delivery handshake. The payload carries
 * everything needed to rehydrate the merge after a restart (Spec 07 §5.3 — no closure state
 * beyond `ctx`/payload).
 */
export function mergeHandshakeSpec(opts: {
  repo: string;
  prNumber: number;
  prUrl?: string;
  strategy?: MergeStrategy;
  taskTitle?: string;
  base?: string;
  expiresAt?: number;
}): HandshakeSpec {
  return {
    actionClass: "merge_pr",
    promptText: mergeHandshakePrompt(opts),
    payload: {
      repo: opts.repo,
      number: opts.prNumber,
      url: opts.prUrl,
      strategy: opts.strategy ?? "squash",
    },
    expiresAt: opts.expiresAt,
  };
}

/** Default handshake window: 24h (Spec 07 §5.4; no dedicated config key in v0 — see report). */
const DEFAULT_HANDSHAKE_MS = 24 * 60 * 60 * 1000;

// =======================================================================================
// classify — the full Spec 07 §2.3 table, pure & total, fail-closed
// =======================================================================================

/** Shared/protected branches force-push is never allowed to rewrite (Spec 07 §3.5). */
const SHARED_BRANCH = [/^main$/, /^master$/, /^release\//, /^develop$/];

/** A ref is "shared" if it matches a protected pattern or is outside Beckett's namespace. */
export function isSharedBranch(ref: string): boolean {
  if (!ref) return true; // unknown ref → treat as shared (fail-closed)
  return SHARED_BRANCH.some((re) => re.test(ref)) || !ref.startsWith("beckett/");
}

/**
 * Classify an action into its {@link ActionClass} (Spec 07 §2.3). Pure and total: every
 * input returns exactly one class, and any unrecognized type defaults to ALWAYS_ASK
 * (fail-closed). Accepts both the frozen-contract action names (`gh.branch.push`, …) and the
 * Spec 07 prose names (`git.branch.push`, `git.commit`, `git.force_push`, `gh.pr.comment`,
 * …) so callers can use either vocabulary.
 */
export function classifyAction(type: ActionType, ctx: ActionContext = {}): ActionClass {
  switch (type) {
    // ── FREE: reversible / internal (the default & the bulk) ──
    case "gh.branch.push":
    case "git.branch.push":
    case "git.commit":
    case "gh.pr.open":
    case "gh.pr.update":
    case "gh.pr.comment":
    case "gh.pr.review":
    case "gmail.read":
    case "gmail.label":
    case "gmail.draft":
    case "fs.write": // in-scope writes (the worker's owned globs)
    case "memory.write":
    case "task.spawn":
    case "model.call":
      return ActionClass.FREE;

    // ── HANDSHAKE_GATED: outbound but the expected finish line ──
    case "gh.pr.merge":
      return ActionClass.HANDSHAKE_GATED;
    case "gmail.send":
      return ActionClass.HANDSHAKE_GATED; // internal OR external (Spec 07 §4.4)

    // ── conditional: depends on the ref / merged-state (Spec 07 §2.3) ──
    case "git.force_push":
    case "gh.force_push":
      // Rewriting shared history is never unattended; own beckett/* branch is gated.
      return isSharedBranch(String(ctx.ref ?? "")) ? ActionClass.ALWAYS_ASK : ActionClass.HANDSHAKE_GATED;
    case "gh.branch.delete":
      // Deleting a merged branch is tidy-up (FREE); unmerged work needs a confirm.
      return ctx.merged === true ? ActionClass.FREE : ActionClass.HANDSHAKE_GATED;

    // ── ALWAYS_ASK: dangerous / out of remit / irreversible at scale ──
    case "gh.repo.admin":
    case "gh.branch_protection.edit":
    case "gmail.delete":
    case "gmail.account.settings":
    case "fs.write_outside_scope":
    case "deploy":
    case "publish":
    case "money":
      return ActionClass.ALWAYS_ASK;

    // ── fail-closed: unknown action types are never run unattended ──
    default:
      return ActionClass.ALWAYS_ASK;
  }
}

/** Map an action type to the persisted {@link PendingActionClass} (Spec 09 §2.11 CHECK set). */
function pendingClassFor(type: ActionType): PendingActionClass {
  switch (type) {
    case "gh.pr.merge":
      return "merge_pr";
    case "gmail.send":
      return "send_email";
    case "git.force_push":
    case "gh.force_push":
      return "force_push";
    default:
      return "other";
  }
}

// =======================================================================================
// subprocess helper — stdin always closed; forbidden API keys always stripped
// =======================================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** GitHub creates a fork asynchronously — poll this many times before pushing to it. */
const FORK_READY_TRIES = 10;
/** Delay between fork-readiness polls. */
const FORK_READY_DELAY_MS = 1500;

/** Sleep helper for fork-readiness polling (real timers; publish runs off the hot path). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `owner/repo` out of a git remote URL — https (`https://github.com/o/r.git`), ssh
 * (`git@github.com:o/r.git`), or a bare `o/r`. Returns null if it doesn't look like a GitHub repo.
 */
export function parseRepoNwo(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const m =
    cleaned.match(/[:/]([^/:]+\/[^/:]+)$/) ?? // https or ssh: capture the trailing owner/repo
    cleaned.match(/^([^/:]+\/[^/:]+)$/); // already a bare owner/repo
  const nwo = m?.[1];
  if (!nwo) return null;
  return /^[^/]+\/[^/]+$/.test(nwo) ? nwo : null;
}

/** A copy of `process.env` with API-auth/endpoint overrides removed (src/env.ts). */
function sanitizedEnv(): Record<string, string | undefined> {
  return childEnv();
}

/** Run a subprocess to completion with stdin closed. Captures stdout/stderr (Spec 07 §3.6). */
async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: (opts.env ?? sanitizedEnv()) as Record<string, string>,
    stdin: "ignore", // never let git/gh block on a prompt
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

// =======================================================================================
// GitHubClient — gh CLI for PR/review ops, plain git for transport (Spec 07 §3.2/§3.6)
// =======================================================================================

export interface GitHubClientOptions {
  /** The PAT (env GITHUB_PAT). Empty string = unavailable → methods throw gracefully. */
  pat: string;
  /** GitHub login the commits/PRs are attributed to (Identity.github.account). */
  account: string;
  /** Account or organization that owns managed project repos. Defaults to `account`. */
  owner?: string;
  /** API base (https://api.github.com or a GHE base). */
  apiBase: string;
  /** Resolve a repo "org/name" to its local working dir (for `git push`). */
  resolveRepoDir: (repo: string) => string;
  logger: Logger;
  /** Subprocess runner — injectable so the publish decision tree is unit-testable (defaults to the
   *  real {@link run}). Tests pass a fake that matches on argv and returns canned `gh`/`git` output. */
  run?: (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<RunResult>;
  /** Injectable authenticated REST transport (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

/** The outcome of {@link GitHubCli.ensurePublished} — carries HOW the work shipped so callers can
 *  word "done" honestly: `pushed` = landed on the repo's default branch; `pr` = a PR is open and
 *  still needs a human merge (a cloned upstream, or an existing shared repo). */
export interface PublishResult {
  nameWithOwner: string;
  url: string;
  /** `pushed` → merged to the default branch; `pr` → PR opened, awaiting a human merge. */
  kind: "pushed" | "pr";
  /** The PR's web URL when `kind === "pr"` (the thing a human reviews/merges). */
  prUrl?: string;
}

/**
 * Beckett's GitHub agency surface (Spec 07 §3). All PR/issue/review ops shell out to the
 * `gh` CLI with `GH_TOKEN` set per-invocation (stateless, single credential — Spec 07 §3.2);
 * `git push` uses plain git with a credential helper that reads the PAT from the *environment*
 * (`$GITHUB_PAT`) so the token never appears in argv. Most ops are FREE; the caller GATES
 * `mergePR` behind {@link Agency.perform}.
 */
export class GitHubCli implements GitHubClient, GitHubPrReader, GitHubBranchCardReader, GitHubActivityReader {
  private readonly runner: (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<RunResult>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubClientOptions) {
    this.runner = opts.run ?? run;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Whether GitHub agency is usable (a PAT is configured). */
  get available(): boolean {
    return this.opts.pat.length > 0;
  }

  private requireCreds(op: string): void {
    if (!this.available) throw new GitHubUnavailableError(op);
  }

  /** Managed project-repository destination; authentication still uses `account`. */
  private publishingOwner(): string {
    return this.opts.owner?.trim() || this.opts.account;
  }

  /** The git host derived from the API base (github.com for the public API). */
  private gitHost(): string {
    return this.opts.apiBase.includes("api.github.com")
      ? "https://github.com"
      : this.opts.apiBase.replace(/\/api\/v3\/?$/, "").replace(/\/$/, "");
  }

  /** Env for `gh`: GH_TOKEN/GITHUB_TOKEN carry the PAT; forbidden keys stripped. */
  private ghEnv(): Record<string, string | undefined> {
    return { ...sanitizedEnv(), GH_TOKEN: this.opts.pat, GITHUB_TOKEN: this.opts.pat };
  }

  /**
   * Env for `git`: an inline credential helper that echoes the username + `$GITHUB_PAT`.
   * Configured via GIT_CONFIG_* so the PAT stays in the environment, never in argv or
   * `~/.git-credentials` (Spec 07 §3.2). The first (empty) helper clears any inherited one.
   */
  private gitEnv(): Record<string, string | undefined> {
    return {
      ...sanitizedEnv(),
      GITHUB_PAT: this.opts.pat,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: `!f() { echo username=${this.opts.account}; echo "password=$GITHUB_PAT"; }; f`,
    };
  }

  /**
   * Belt-and-suspenders before any push (OPS-61): Beckett's internal scaffolding (`.beckett/` — the
   * done-signal schema, scope-guard settings, worker state) must never reach a remote or a PR diff.
   * It is excluded + hook-stripped at the commit boundary, but if a prior code path somehow committed
   * it we strip it here with a cleanup commit so the pushed branch is clean. Almost always a no-op.
   * Uses `this.runner` so an injected fake keeps unit tests off real git.
   */
  private async stripTrackedScaffolding(cwd: string): Promise<void> {
    const tracked = await this.runner(["git", "ls-files", "--", SCAFFOLDING_DIR], { cwd, env: this.gitEnv() });
    if (tracked.code !== 0 || tracked.stdout.trim() === "") return; // nothing tracked → clean already
    this.opts.logger.warn("scaffolding was tracked in the branch — stripping before push", { cwd });
    const rm = await this.runner(["git", "rm", "-r", "--cached", "--quiet", "--", SCAFFOLDING_DIR], { cwd, env: this.gitEnv() });
    if (rm.code !== 0) {
      throw new Error(`refusing to push: could not strip ${SCAFFOLDING_DIR} (${rm.code}): ${rm.stderr.trim()}`);
    }
    const commit = await this.runner(
      ["git", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "beckett: strip internal scaffolding"],
      { cwd, env: this.gitEnv() },
    );
    if (commit.code !== 0) {
      throw new Error(`refusing to push: could not commit ${SCAFFOLDING_DIR} strip (${commit.code}): ${commit.stderr.trim()}`);
    }
  }

  /**
   * Authenticated `git push <repo-url> <localRef>:refs/heads/<remoteBranch>` from an explicit working
   * dir. The publish flow pushes the SAME checkout to different remotes (a fork for a cross-fork PR),
   * so the cwd is passed in rather than derived from `resolveRepoDir` (which would guess the wrong dir
   * for a fork). Low-level: callers gate FREE-ness. Strips any accidentally-tracked internal
   * scaffolding first (OPS-61), so neither a direct branch push nor a cross-fork PR push can leak
   * `.beckett/` — a checked-out `HEAD`/branch ref can be cleaned; a bare sha can't, so it's skipped.
   */
  private async gitPush(cwd: string, repo: string, localRef: string, remoteBranch: string): Promise<void> {
    if (localRef === "HEAD" || !/^[0-9a-f]{7,40}$/i.test(localRef)) await this.stripTrackedScaffolding(cwd);
    const url = `${this.gitHost()}/${repo}.git`;
    const r = await this.runner(["git", "push", url, `${localRef}:refs/heads/${remoteBranch}`], {
      cwd,
      env: this.gitEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`git push failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("branch pushed", { repo, remoteBranch });
  }

  /** Push a local ref to a remote branch over authenticated HTTPS (Spec 07 §3.3). FREE caller. */
  async pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void> {
    this.requireCreds("push branch");
    await this.gitPush(this.opts.resolveRepoDir(repo), repo, localRef, remoteBranch);
  }

  /**
   * Create a repo under Beckett's account (Spec 07 §3.3). New repos are reversible (deletable)
   * and within remit, so this is a FREE op — Beckett spins up project repos on its own. With
   * `sourceDir` (+ `push`) it wires the local dir as `origin` and pushes the initial commits in
   * one shot. Token rides `GH_TOKEN` per-invocation, so `gh` never needs `gh auth login/status`.
   */
  async createRepo(p: {
    name: string; // "name" (under the account) or "owner/name"
    private?: boolean; // default true
    description?: string;
    sourceDir?: string; // an existing git repo to wire as origin
    push?: boolean; // push sourceDir's commits after creating
  }): Promise<{ nameWithOwner: string; url: string }> {
    this.requireCreds("create repo");
    const args = ["gh", "repo", "create", p.name, p.private === false ? "--public" : "--private"];
    if (p.description) args.push("--description", p.description);
    if (p.sourceDir) {
      args.push("--source", p.sourceDir, "--remote", "origin");
      if (p.push) args.push("--push");
    }
    const r = await this.runner(args, { cwd: p.sourceDir, env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh repo create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const url = (r.stdout.match(/https?:\/\/\S+/) ?? [
      `${this.gitHost()}/${p.name.includes("/") ? p.name : `${this.opts.account}/${p.name}`}`,
    ])[0].trim();
    // Trust the URL gh printed for the real owner/name (the token's account may differ from config).
    const owned = url.match(/[^/]+\/[^/]+$/);
    const nameWithOwner = owned ? owned[0].replace(/\.git$/, "") : p.name;
    this.opts.logger.info("repo created", { repo: nameWithOwner, url });
    return { nameWithOwner, url };
  }

  /**
   * Star or unstar an explicitly named GitHub repository through the authenticated REST API.
   * This intentionally uses the same PAT as the rest of this client, rather than depending on
   * a separately logged-in `gh` installation.
   */
  async setRepoStar(repo: string, starred: boolean): Promise<void> {
    this.requireCreds(starred ? "star repo" : "unstar repo");
    const match = repo.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
    if (!match) throw new Error("repo must be in owner/name form");
    const owner = match[1]!;
    const name = match[2]!;
    const apiBase = this.opts.apiBase.replace(/\/$/, "");
    const url = `${apiBase}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const response = await this.fetchImpl(url, {
      method: starred ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bearer ${this.opts.pat}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status !== 204) {
      const detail = (await response.text()).trim();
      throw new Error(`GitHub ${starred ? "star" : "unstar"} repo failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    this.opts.logger.info(starred ? "repo starred" : "repo unstarred", { repo });
  }

  /** Whether `owner/name` (or `name` under the account) already exists on GitHub. FREE: a read. */
  async repoExists(nameWithOwner: string): Promise<boolean> {
    if (!this.available) return false;
    const repo = nameWithOwner.includes("/") ? nameWithOwner : `${this.opts.account}/${nameWithOwner}`;
    const r = await this.runner(["gh", "repo", "view", repo, "--json", "name"], { env: this.ghEnv() });
    return r.code === 0;
  }

  /**
   * Make a repo publicly visible (idempotent — a no-op if it's already public). Project repos are
   * public so the links Beckett hands out resolve; this self-heals repos an older code path left
   * private (the cause of the `0xbeckett/<slug>` 404s). Uses the REST `private=false` field, which
   * is stable across `gh` versions (the `repo edit --visibility` flag is not). FREE: a metadata edit.
   */
  async setPublic(nameWithOwner: string): Promise<void> {
    this.requireCreds("set repo visibility");
    const repo = nameWithOwner.includes("/") ? nameWithOwner : `${this.opts.account}/${nameWithOwner}`;
    const r = await this.runner(["gh", "api", "--method", "PATCH", `repos/${repo}`, "-F", "private=false"], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh api set-public failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * Idempotently publish a done ticket's checkout to GitHub, returning HOW it shipped (a
   * {@link PublishResult}). Three cases, each detect-and-continue so a re-run never throws on
   * "already exists" (the original bug: `gh repo create` blew up because the cloned checkout already
   * had an `origin`, and the ticket had already been marked done, so the work silently never shipped):
   *
   *   1. **Cloned third-party upstream** (`origin` points outside our account and managed owner) →
   *      fork it under the authenticated account, push a ticket branch to the fork, and open a PR.
   *      We can't push to someone else's repo and merging is a human call → `kind: "pr"`.
   *   2. **A repo we already own** (a continuing/shared project, e.g. the beckett self-repo) → push a
   *      ticket branch and open a PR against its default branch. NEVER `HEAD→main` (that's the
   *      non-fast-forward "fetch first" reject that stranded shared-repo tickets) → `kind: "pr"`.
   *   3. **Brand-new project we own** → create it from `sourceDir` and push `HEAD→main` in one shot →
   *      `kind: "pushed"`.
   */
  async ensurePublished(p: {
    slug: string;
    sourceDir: string;
    description?: string;
    /** Ticket identifier — names the PR branch (`beckett/<ticket>`) + the PR body. Defaults to slug. */
    ticket?: string;
    /**
     * Non-main integration/target branch to publish onto (e.g. `v5-daemon`). When set to a branch
     * other than `main`, an owned-repo publish (Case 2) ships to THIS branch and NEVER touches the
     * repo's default branch (`main`): no fetch, no rebase, no push against it. Absent (or `main`) ⇒
     * publish to the repo default exactly as before, so a normal ticket is byte-for-byte unchanged
     * (OPS-185).
     */
    targetBranch?: string;
  }): Promise<PublishResult> {
    this.requireCreds("publish repo");
    // Clean the source tree once up front (OPS-61) so NO publish path — including the brand-new-repo
    // `gh repo create --push`, which bypasses gitPush — can leak Beckett's internal scaffolding.
    await this.stripTrackedScaffolding(p.sourceDir);
    const ref = (p.ticket ?? p.slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const branch = `beckett/${ref}`;
    const title = p.description?.trim() || `beckett: ${p.slug}`;
    const body =
      `Automated contribution by Beckett${p.ticket ? ` for ${p.ticket}` : ""}.` +
      (p.description ? `\n\n${p.description}` : "");

    // Case 1 — cloned from a third-party upstream: fork → push branch to fork → PR to upstream.
    const upstream = await this.originUpstream(p.sourceDir);
    if (upstream) {
      // A retry after a lost response must not even start the create path: look for the ticket
      // branch's open PR before forking/pushing/opening. This is the publish-outbox idempotency
      // boundary (and avoids cross-fork PAT churn once a PR already exists).
      const existing = await this.findOpenPR(upstream, `${this.opts.account}:${branch}`);
      if (existing) {
        this.opts.logger.info("reused existing upstream PR", { upstream, branch, pr: existing.url });
        return { nameWithOwner: upstream, url: `${this.gitHost()}/${upstream}`, kind: "pr", prUrl: existing.url };
      }
      const fork = await this.ensureFork(upstream);
      await this.gitPush(p.sourceDir, fork, "HEAD", branch);
      const base = await this.defaultBranch(upstream);
      const pr = await this.ensurePR({ repo: upstream, base, head: `${this.opts.account}:${branch}`, title, body });
      this.opts.logger.info("published via upstream PR", { upstream, fork, branch, pr: pr.url });
      return { nameWithOwner: upstream, url: `${this.gitHost()}/${upstream}`, kind: "pr", prUrl: pr.url };
    }

    const repo = `${this.publishingOwner()}/${p.slug}`;

    // Case 2 — a repo we already own (a continuing project, incl. beckett's own repos): ship straight
    // to its default branch. Integrate the remote tip FIRST (fetch + rebase) so this isn't the
    // non-fast-forward "fetch first" reject that stranded OPS-25/27; keeping the branch current also
    // keeps it visible to DAG dependents that clone fresh. A rebase CONFLICT throws → the dispatcher
    // holds the ticket for a human (never a silent false-done).
    if (await this.repoExists(repo)) {
      await this.setPublicSafe(repo);
      // A ticket cast onto a non-main integration branch (the V5 `v5-daemon` funnel — OPS-185) ships
      // THERE and must never advance `main`. When an integration target is present we push to it and
      // only it (integrating that branch's own tip first, exactly like the default path integrates
      // main's), so no fetch/rebase/push ever references the default branch. Absent ⇒ the default
      // branch, byte-for-byte as before.
      const target = this.integrationTarget(p.targetBranch);
      await this.pushToBranch(p.sourceDir, repo, target ?? undefined);
      this.opts.logger.info("published via push to branch", { repo, branch: target ?? "(default)" });
      return { nameWithOwner: repo, url: `${this.gitHost()}/${repo}`, kind: "pushed" };
    }

    // Case 3 — brand-new project we own: create the empty repo, then push the source tree's HEAD to
    // an explicit `main`. Under v3.2 worktrees HEAD rides the ticket's branch (`beckett/<ticket>`),
    // so we must name the remote branch `main` rather than let `gh repo create --push` make the
    // local branch name the repo's default. gitPush also strips any tracked scaffolding first.
    const created = await this.createRepo({
      name: repo,
      private: false, // project repos are public so links Beckett hands out actually resolve
      description: p.description,
    });
    await this.gitPush(p.sourceDir, created.nameWithOwner, "HEAD", "main");
    return { ...created, kind: "pushed" };
  }

  /**
   * The explicit non-default branch an owned-repo publish should land on, or `null` to use the repo
   * default. A ticket cast onto an integration branch (e.g. `v5-daemon`) funnels there; an unset
   * value or an explicit `main` both mean "the default branch", so a normal ticket's publish is
   * byte-for-byte unchanged (OPS-185).
   */
  private integrationTarget(targetBranch?: string): string | null {
    const b = targetBranch?.trim();
    if (!b || b.toLowerCase() === "main") return null;
    return b;
  }

  /**
   * Push the checkout's HEAD to a repo we own, on a branch, WITHOUT a non-fast-forward reject: fetch
   * that branch's remote tip and rebase local commits onto it first, then push. `branch` defaults to
   * the repo's default branch (`main` for the self-repo) — a ticket cast onto a non-main integration
   * branch passes it explicitly so `main` is never fetched, rebased, or pushed. If the remote branch
   * doesn't exist yet (a just-created/empty repo, or a fresh integration branch) the fetch fails
   * harmlessly and the push creates it. A rebase conflict aborts and throws — the caller turns that
   * into a "needs a human" hold rather than force-pushing over someone's (or a parallel worker's)
   * commits.
   */
  private async pushToBranch(cwd: string, repo: string, branch?: string): Promise<void> {
    const base = branch ?? await this.defaultBranch(repo);
    const url = `${this.gitHost()}/${repo}.git`;
    const fetch = await this.runner(["git", "fetch", url, base], { cwd, env: this.gitEnv() });
    if (fetch.code === 0) {
      const rebase = await this.runner(["git", "rebase", "FETCH_HEAD"], { cwd, env: this.gitEnv() });
      if (rebase.code !== 0) {
        await this.runner(["git", "rebase", "--abort"], { cwd, env: this.gitEnv() });
        throw new Error(
          `publish: local work conflicts with ${repo}@${base} and can't auto-rebase — needs a human ` +
            `(${rebase.stderr.trim() || rebase.stdout.trim()})`,
        );
      }
    }
    await this.gitPush(cwd, repo, "HEAD", base);
  }

  /** `setPublic` that never throws — visibility is cosmetic and must not block shipping the code. */
  private async setPublicSafe(repo: string): Promise<void> {
    try {
      await this.setPublic(repo);
    } catch (err) {
      this.opts.logger.warn("could not make repo public (left as-is)", { repo, err: (err as Error).message });
    }
  }

  /**
   * The upstream `owner/repo` when `sourceDir`'s `origin` points outside both the authenticated
   * account and managed project owner. Null for a fresh repo or either kind of owned checkout.
   */
  private async originUpstream(sourceDir: string): Promise<string | null> {
    const r = await this.runner(["git", "remote", "get-url", "origin"], { cwd: sourceDir });
    if (r.code !== 0) return null; // no origin remote → fresh/owned project
    const nwo = parseRepoNwo(r.stdout.trim());
    if (!nwo) return null;
    const owner = nwo.split("/")[0] ?? "";
    const ownOrigins = new Set([
      this.opts.account.toLowerCase(),
      this.publishingOwner().toLowerCase(),
    ]);
    if (ownOrigins.has(owner.toLowerCase())) return null;
    return nwo;
  }

  /** A repo's default branch (`main`/`master`/…) via the API; falls back to `main` if unknown. */
  private async defaultBranch(repo: string): Promise<string> {
    const r = await this.runner(
      ["gh", "repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      { env: this.ghEnv() },
    );
    const name = r.code === 0 ? r.stdout.trim() : "";
    return name || "main";
  }

  /**
   * Ensure a fork of `upstream` exists under our account and return its `owner/repo`. `gh repo fork`
   * is idempotent (a no-op when the fork already exists) but GitHub creates the fork ASYNC, so we
   * poll `repoExists` until it's queryable before the caller pushes to it.
   */
  private async ensureFork(upstream: string): Promise<string> {
    const fork = `${this.opts.account}/${upstream.split("/")[1]}`;
    const r = await this.runner(["gh", "repo", "fork", upstream, "--clone=false"], {
      env: this.ghEnv(),
    });
    if (r.code !== 0 && !/already exists|forked|exists/i.test(`${r.stderr}${r.stdout}`)) {
      throw new Error(`gh repo fork failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    for (let i = 0; i < FORK_READY_TRIES; i++) {
      if (await this.repoExists(fork)) return fork;
      await delay(FORK_READY_DELAY_MS);
    }
    return fork; // let the subsequent push surface any genuine "fork not ready" error
  }

  /** Open a PR, but return an already-open one instead of failing (idempotent publish re-runs). */
  private async ensurePR(p: OpenPRParams): Promise<{ number: number; url: string }> {
    const existing = await this.findOpenPR(p.repo, p.head);
    if (existing) return existing;
    try {
      return await this.openPR(p);
    } catch (err) {
      const again = await this.findOpenPR(p.repo, p.head); // racy/pre-existing → re-query, don't fail
      if (again) return again;
      throw err;
    }
  }

  /** The open PR for `head` on `repo` (matches on the branch name, cross-fork `owner:branch` too). */
  private async findOpenPR(repo: string, head: string): Promise<{ number: number; url: string } | null> {
    const branch = head.includes(":") ? (head.split(":").pop() ?? head) : head;
    const r = await this.runner(
      ["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) return null;
    try {
      const arr = JSON.parse(r.stdout) as Array<{ number: number; url: string }>;
      const first = arr[0];
      return first ? { number: first.number, url: first.url } : null;
    } catch {
      return null;
    }
  }

  /** Open a PR as itself (Spec 07 §3.3). FREE: a proposal, not a change to main. */
  async openPR(p: OpenPRParams): Promise<{ number: number; url: string }> {
    this.requireCreds("open PR");
    const args = [
      "gh", "pr", "create",
      "--repo", p.repo,
      "--base", p.base,
      "--head", p.head,
      "--title", p.title,
      "--body", p.body,
    ];
    if (p.draft) args.push("--draft");
    const r = await this.runner(args, { cwd: this.opts.resolveRepoDir(p.repo), env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh pr create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    // gh prints the PR URL on stdout; the trailing path segment is the number.
    const url = (r.stdout.match(/https?:\/\/\S+\/pull\/\d+/) ?? [r.stdout.trim()])[0].trim();
    const num = url.match(/\/pull\/(\d+)/);
    if (!num) throw new Error(`gh pr create: could not parse PR number from "${r.stdout.trim()}"`);
    const number = Number(num[1]);
    this.opts.logger.info("PR opened", { repo: p.repo, number, url });
    return { number, url };
  }

  /** Update a PR (push more commits handled by pushBranch; this edits metadata). FREE. */
  async updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void> {
    this.requireCreds("update PR");
    const args = ["gh", "pr", "edit", String(n), "--repo", repo];
    if (p.title !== undefined) args.push("--title", p.title);
    if (p.body !== undefined) args.push("--body", p.body);
    if (p.base !== undefined) args.push("--base", p.base);
    if (args.length === 5) return; // nothing to change
    const r = await this.runner(args, { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh pr edit failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /** Comment / approve / request-changes on a PR (Spec 07 §3.3). FREE: speech, not state. */
  async reviewPR(repo: string, n: number, rv: ReviewParams): Promise<void> {
    this.requireCreds("review PR");
    const flag =
      rv.event === "APPROVE" ? "--approve" : rv.event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
    const r = await this.runner(
      ["gh", "pr", "review", String(n), "--repo", repo, flag, "--body", rv.body],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr review failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * Merge a PR (Spec 07 §3.4). The IRREVERSIBLE step — callers MUST route this through
   * {@link Agency.perform}("gh.pr.merge", …); this method assumes the handshake already said go.
   */
  async mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void> {
    this.requireCreds("merge PR");
    const flag = strategy === "merge" ? "--merge" : strategy === "rebase" ? "--rebase" : "--squash";
    const r = await this.runner(
      ["gh", "pr", "merge", String(n), "--repo", repo, flag, "--delete-branch"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr merge failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("PR merged", { repo, number: n, strategy });
  }

  /**
   * The lifecycle state of a PR — `"OPEN" | "CLOSED" | "MERGED"` (Spec 07 §3.4). Throws a clear
   * error (via `gh`) if the PR number doesn't exist or auth can't see it. When `repo` is empty
   * the current repo (cwd) is used, matching how the other pr verbs resolve their target.
   */
  async prState(repo: string, n: number): Promise<string> {
    this.requireCreds("view PR");
    const repoArgs = repo ? ["--repo", repo] : [];
    const r = await run(
      ["gh", "pr", "view", String(n), ...repoArgs, "--json", "state"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr view failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    try {
      return String((JSON.parse(r.stdout) as { state?: string }).state ?? "").toUpperCase();
    } catch {
      throw new Error(`gh pr view returned unparseable JSON for PR #${n}`);
    }
  }

  /**
   * Close an OPEN PR without merging (Spec 07 §3.4). Unlike {@link mergePR} this is reversible
   * (a closed PR can be reopened), but it is still an outward-facing state change. We check the
   * current state first so the caller gets a deterministic, human-legible error when the PR is
   * already closed/merged or doesn't exist — independent of `gh`'s exit-code quirks. Returns the
   * resulting state on success. When `repo` is empty the current repo (cwd) is used.
   */
  async closePR(repo: string, n: number): Promise<{ repo: string; number: number; state: string }> {
    this.requireCreds("close PR");
    const state = await this.prState(repo, n); // throws clearly if the PR doesn't exist / is invisible
    if (state === "MERGED") throw new Error(`PR #${n} is already merged — cannot close`);
    if (state === "CLOSED") throw new Error(`PR #${n} is already closed`);
    const repoArgs = repo ? ["--repo", repo] : [];
    const r = await run(
      ["gh", "pr", "close", String(n), ...repoArgs],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr close failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("PR closed", { repo, number: n });
    return { repo, number: n, state: "CLOSED" };
  }

  /** Whether a PR's status checks are all green (Spec 07 §3.6) — the pre-handshake gate. */
  async isGreen(repo: string, n: number): Promise<boolean> {
    this.requireCreds("check PR status");
    const r = await this.runner(
      ["gh", "pr", "view", String(n), "--repo", repo, "--json", "statusCheckRollup"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr view failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let parsed: { statusCheckRollup?: CheckRollupEntry[] };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return false; // unparseable → not provably green → fail-closed
    }
    const checks = summarizeCheckRollup(parsed.statusCheckRollup);
    return checks.total === 0 || checks.conclusion === "SUCCESS";
  }

  /**
   * The full signal read the PR poller diffs (OPS-124): lifecycle, draft flag, head sha, reviews,
   * conversation comments, and the rolled-up CI conclusion — in ONE `gh pr view` round-trip. Read
   * only (no state change), so it's FREE. Throws with a clear message on an unreadable/missing PR
   * so the poller can skip it for the tick and retry, exactly like the tracker poller's read failures.
   */
  /**
   * Recent commits on one branch for the external activity relay. This stays behind GitHubCli so
   * pollers reuse Beckett's credential boundary instead of invoking gh/git themselves.
   */
  async mainCommits(repo: string, branch: string): Promise<GitHubActivityCommit[]> {
    this.requireCreds("read repository commits");
    const r = await this.runner(
      ["gh", "api", "--method", "GET", `repos/${repo}/commits`, "-f", `sha=${branch}`, "-f", "per_page=100"],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) throw new Error(`gh api (commits) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    let commits: Array<{ sha?: string; author?: { login?: string }; committer?: { login?: string }; commit?: { message?: string; author?: { name?: string } } }>;
    try {
      commits = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh api (commits) returned unparseable JSON for ${repo}`);
    }
    if (!Array.isArray(commits)) throw new Error(`gh api (commits) returned a non-list for ${repo}`);
    return commits.map((commit) => ({
      sha: String(commit.sha ?? ""),
      author: commit.author?.login ?? commit.committer?.login ?? commit.commit?.author?.name ?? "",
      message: String(commit.commit?.message ?? "").split("\n")[0] ?? "",
    }));
  }

  /** Recently merged pull requests for the external activity relay (read-only). */
  async mergedPullRequests(repo: string): Promise<GitHubMergedPullRequest[]> {
    this.requireCreds("read merged pull requests");
    const r = await this.runner(
      ["gh", "api", "--method", "GET", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) throw new Error(`gh api (pulls) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    let prs: Array<{ number?: number; title?: string; user?: { login?: string }; merged_at?: string | null }>;
    try {
      prs = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh api (pulls) returned unparseable JSON for ${repo}`);
    }
    if (!Array.isArray(prs)) throw new Error(`gh api (pulls) returned a non-list for ${repo}`);
    return prs
      .filter((pr) => Boolean(pr.merged_at))
      .map((pr) => ({
        number: Number(pr.number ?? 0),
        title: String(pr.title ?? ""),
        author: pr.user?.login ?? "",
        mergedAt: String(pr.merged_at ?? ""),
      }));
  }

  /**
   * Read the aggregate metadata for one published branch/PR in a single `gh pr view` call. The
   * selected JSON fields intentionally exclude `files` and patch text: cards show scale and health,
   * never a wall of diff lines.
   */
  async branchCard(repo: string, ref: string | number): Promise<GitHubBranchCard> {
    this.requireCreds("read branch card");
    const selector = String(ref).trim();
    if (!repo.trim() || !selector) throw new Error("branch card needs both repo and branch/PR ref");
    const fields =
      "number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,updatedAt," +
      "additions,deletions,changedFiles,commits,reviewDecision,latestReviews,comments,statusCheckRollup";
    const r = await this.runner(["gh", "pr", "view", selector, "--repo", repo, "--json", fields], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh pr view (branch card) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let p: {
      number?: unknown;
      url?: unknown;
      title?: unknown;
      state?: unknown;
      isDraft?: unknown;
      headRefName?: unknown;
      baseRefName?: unknown;
      headRefOid?: unknown;
      updatedAt?: unknown;
      additions?: unknown;
      deletions?: unknown;
      changedFiles?: unknown;
      commits?: unknown;
      reviewDecision?: unknown;
      latestReviews?: unknown;
      comments?: unknown;
      statusCheckRollup?: CheckRollupEntry[];
    };
    try {
      p = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr view (branch card) returned unparseable JSON for ${repo}@${selector}`);
    }
    const number = positiveInteger(p.number);
    if (number === null) {
      throw new Error(`gh pr view (branch card) returned no valid PR number for ${repo}@${selector}`);
    }
    const state = String(p.state ?? "OPEN").toUpperCase();
    return {
      repo,
      number,
      url: String(p.url ?? ""),
      title: String(p.title ?? ""),
      state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
      isDraft: Boolean(p.isDraft),
      headRefName: String(p.headRefName ?? ""),
      baseRefName: String(p.baseRefName ?? ""),
      headRefOid: String(p.headRefOid ?? ""),
      updatedAt: String(p.updatedAt ?? ""),
      additions: nonNegativeInteger(p.additions),
      deletions: nonNegativeInteger(p.deletions),
      changedFiles: nonNegativeInteger(p.changedFiles),
      commits: Array.isArray(p.commits) ? p.commits.length : 0,
      reviewDecision: String(p.reviewDecision ?? "").toUpperCase(),
      reviewCount: Array.isArray(p.latestReviews) ? p.latestReviews.length : 0,
      commentCount: Array.isArray(p.comments) ? p.comments.length : 0,
      checks: summarizeCheckRollup(p.statusCheckRollup),
    };
  }

  async prSignals(repo: string, n: number): Promise<PrSignals> {
    this.requireCreds("read PR signals");
    const fields =
      "number,url,title,state,isDraft,headRefOid,reviewDecision,reviews,comments,statusCheckRollup";
    const r = await this.runner(["gh", "pr", "view", String(n), "--repo", repo, "--json", fields], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh pr view (signals) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let p: {
      number?: number;
      url?: string;
      title?: string;
      state?: string;
      isDraft?: boolean;
      headRefOid?: string;
      reviewDecision?: string;
      reviews?: Array<{ id?: string | number; author?: { login?: string }; state?: string; submittedAt?: string; body?: string }>;
      comments?: Array<{ id?: string | number; author?: { login?: string }; createdAt?: string; body?: string }>;
      statusCheckRollup?: CheckRollupEntry[];
    };
    try {
      p = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr view (signals) returned unparseable JSON for PR #${n}`);
    }
    const state = String(p.state ?? "OPEN").toUpperCase();
    return {
      number: typeof p.number === "number" ? p.number : n,
      url: p.url ?? "",
      title: p.title ?? "",
      state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
      isDraft: Boolean(p.isDraft),
      headRefOid: String(p.headRefOid ?? ""),
      reviewDecision: String(p.reviewDecision ?? "").toUpperCase(),
      reviews: (p.reviews ?? []).map((rv) => ({
        id: String(rv.id ?? `${rv.author?.login ?? "?"}@${rv.submittedAt ?? ""}`),
        author: rv.author?.login ?? "",
        state: String(rv.state ?? "").toUpperCase() as PrSignals["reviews"][number]["state"],
        submittedAt: rv.submittedAt ?? "",
        body: rv.body ?? "",
      })),
      comments: (p.comments ?? []).map((c) => ({
        id: String(c.id ?? `${c.author?.login ?? "?"}@${c.createdAt ?? ""}`),
        author: c.author?.login ?? "",
        createdAt: c.createdAt ?? "",
        body: c.body ?? "",
      })),
      checkConclusion: summarizeCheckRollup(p.statusCheckRollup).conclusion,
    };
  }
}

interface CheckRollupEntry {
  status?: string;
  conclusion?: string;
  state?: string;
}

/**
 * Reduce GitHub's mixed CheckRun/StatusContext rollup into exact card counts and the existing loud
 * conclusion. Neutral and skipped checks are healthy but remain separate from genuinely passed
 * checks so the card never overstates what ran.
 */
export function summarizeCheckRollup(rollup?: CheckRollupEntry[]): BranchCardCheckSummary {
  const checks = rollup ?? [];
  const summary: BranchCardCheckSummary = {
    total: checks.length,
    passed: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    conclusion: "NONE",
  };
  for (const check of checks) {
    const status = String(check.status ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const contextState = String(check.state ?? "").toUpperCase();

    if (!status && contextState) {
      if (contextState === "SUCCESS") summary.passed += 1;
      else if (contextState === "NEUTRAL" || contextState === "SKIPPED") summary.skipped += 1;
      else if (contextState === "PENDING" || contextState === "EXPECTED") summary.pending += 1;
      else summary.failed += 1;
      continue;
    }
    if (status && status !== "COMPLETED") {
      summary.pending += 1;
      continue;
    }
    if (conclusion === "SUCCESS") summary.passed += 1;
    else if (conclusion === "NEUTRAL" || conclusion === "SKIPPED") summary.skipped += 1;
    else if (!conclusion) summary.pending += 1;
    else summary.failed += 1;
  }
  summary.conclusion = summary.total === 0
    ? "NONE"
    : summary.failed > 0
      ? "FAILURE"
      : summary.pending > 0
        ? "PENDING"
        : "SUCCESS";
  return summary;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// =======================================================================================
// Identity loading (Spec 07 §2.1)
// =======================================================================================

/**
 * Load Beckett's {@link Identity} from config + `.env` (already loaded into `process.env` by
 * `loadConfig`). Read-mostly: the only runtime-mutable field is the Gmail OAuth access token
 * (Gmail is out of v0 scope; the auth shape is populated for forward-compat). The GitHub PAT
 * is read here but MUST NEVER be logged (Spec 07 §7.1).
 */
export function loadIdentity(config: Config, env: NodeJS.ProcessEnv = process.env): Identity {
  const github = resolveGitHubTarget(config, env);
  const apiBase = env.GITHUB_API_BASE ?? "https://api.github.com";

  let gmailAuth: GmailAuth;
  if (env.GMAIL_OAUTH_REFRESH_TOKEN) {
    gmailAuth = {
      kind: "oauth",
      clientId: env.GMAIL_OAUTH_CLIENT_ID ?? "",
      clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET ?? "",
      refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN,
    };
  } else {
    gmailAuth = { kind: "app-password", appPassword: env.GMAIL_APP_PASSWORD ?? "" };
  }

  return {
    name: "Beckett",
    github: {
      account: github.account,
      owner: github.owner,
      pat: env.GITHUB_PAT ?? "",
      apiBase,
      noreplyEmail: `${github.account}@users.noreply.github.com`,
    },
    gmail: {
      account: env.GMAIL_ACCOUNT ?? config.identity.gmail_address,
      auth: gmailAuth,
    },
    discord: {
      botUser: env.DISCORD_BOT_USER ?? "",
    },
    // Portable: the daemon IS OS user "beckett" on loom-desk; honor an override on dev boxes.
    osUser: env.BECKETT_OS_USER ?? "beckett",
  };
}
