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
  Agency,
  ActionType,
  ActionContext,
  GateActionResult,
  HandshakeSpec,
  PendingAction,
  PendingActionClass,
  PendingActionRow,
  GitHubClient,
  OpenPRParams,
  UpdatePRParams,
  ReviewParams,
  MergeStrategy,
  Identity,
  GmailAuth,
  Config,
  Paths,
  Store,
  Logger,
} from "../types.ts";
import { ActionClass } from "../types.ts";
import { pendingActionId } from "../ids.ts";
import { log as rootLog } from "../log.ts";

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
        `(Spec 07 §2.3) — it requires an explicit, specific Jason instruction`,
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

/** Env keys that must NEVER be passed to a subprocess (Spec 00 §4 — subscription auth only). */
const FORBIDDEN_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/** A copy of `process.env` with the forbidden API-key vars removed. */
function sanitizedEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of FORBIDDEN_ENV_KEYS) delete out[k];
  return out;
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
  /** API base (https://api.github.com or a GHE base). */
  apiBase: string;
  /** Resolve a repo "org/name" to its local working dir (for `git push`). */
  resolveRepoDir: (repo: string) => string;
  logger: Logger;
}

/**
 * Beckett's GitHub agency surface (Spec 07 §3). All PR/issue/review ops shell out to the
 * `gh` CLI with `GH_TOKEN` set per-invocation (stateless, single credential — Spec 07 §3.2);
 * `git push` uses plain git with a credential helper that reads the PAT from the *environment*
 * (`$GITHUB_PAT`) so the token never appears in argv. Most ops are FREE; the caller GATES
 * `mergePR` behind {@link Agency.perform}.
 */
export class GitHubCli implements GitHubClient {
  constructor(private readonly opts: GitHubClientOptions) {}

  /** Whether GitHub agency is usable (a PAT is configured). */
  get available(): boolean {
    return this.opts.pat.length > 0;
  }

  private requireCreds(op: string): void {
    if (!this.available) throw new GitHubUnavailableError(op);
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

  /** Push a local ref to a remote branch over authenticated HTTPS (Spec 07 §3.3). FREE caller. */
  async pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void> {
    this.requireCreds("push branch");
    const url = `${this.gitHost()}/${repo}.git`;
    const cwd = this.opts.resolveRepoDir(repo);
    const r = await run(["git", "push", url, `${localRef}:refs/heads/${remoteBranch}`], {
      cwd,
      env: this.gitEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`git push failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("branch pushed", { repo, remoteBranch });
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
    const r = await run(args, { cwd: p.sourceDir, env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh repo create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const nameWithOwner = p.name.includes("/") ? p.name : `${this.opts.account}/${p.name}`;
    const url = (r.stdout.match(/https?:\/\/\S+/) ?? [`${this.gitHost()}/${nameWithOwner}`])[0].trim();
    this.opts.logger.info("repo created", { repo: nameWithOwner, url });
    return { nameWithOwner, url };
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
    const r = await run(args, { cwd: this.opts.resolveRepoDir(p.repo), env: this.ghEnv() });
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
    const r = await run(args, { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh pr edit failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /** Comment / approve / request-changes on a PR (Spec 07 §3.3). FREE: speech, not state. */
  async reviewPR(repo: string, n: number, rv: ReviewParams): Promise<void> {
    this.requireCreds("review PR");
    const flag =
      rv.event === "APPROVE" ? "--approve" : rv.event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
    const r = await run(
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
    const r = await run(
      ["gh", "pr", "merge", String(n), "--repo", repo, flag, "--delete-branch"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr merge failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("PR merged", { repo, number: n, strategy });
  }

  /** Whether a PR's status checks are all green (Spec 07 §3.6) — the pre-handshake gate. */
  async isGreen(repo: string, n: number): Promise<boolean> {
    this.requireCreds("check PR status");
    const r = await run(
      ["gh", "pr", "view", String(n), "--repo", repo, "--json", "statusCheckRollup"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr view failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let parsed: { statusCheckRollup?: Array<{ conclusion?: string; state?: string; status?: string }> };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return false; // unparseable → not provably green → fail-closed
    }
    const checks = parsed.statusCheckRollup ?? [];
    if (checks.length === 0) return true; // no required checks configured → nothing blocking
    const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
    return checks.every((c) => {
      const verdict = (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
      return GREEN.has(verdict);
    });
  }
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
  const account = env.GITHUB_ACCOUNT ?? config.identity.github_user;
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
      account,
      pat: env.GITHUB_PAT ?? "",
      apiBase,
      noreplyEmail: `${account}@users.noreply.github.com`,
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

// =======================================================================================
// BeckettAgency — the one choke point (Spec 07 §2.4)
// =======================================================================================

export interface AgencyOptions {
  identity: Identity;
  store: Store;
  paths: Paths;
  github?: GitHubClient;
  logger?: Logger;
  /** Resolve a repo "org/name" to its local working dir; defaults to <projects>/<name>. */
  resolveRepoDir?: (repo: string) => string;
}

/**
 * The action-class gate (Spec 07 §2.4). Every outward action funnels through {@link perform}.
 * FREE runs immediately; HANDSHAKE_GATED stages a persisted {@link PendingAction} and returns
 * a `pending` handle (the irreversible thunk is held for {@link executeApproved} and is
 * rehydratable from `(actionClass, payload)` after a restart, Spec 07 §5.3); ALWAYS_ASK
 * throws {@link GateRefused}.
 */
export class BeckettAgency implements Agency {
  readonly github: GitHubClient;
  readonly identity: Identity;
  private readonly store: Store;
  private readonly logger: Logger;
  private readonly resolveRepoDir: (repo: string) => string;
  /** In-process execute thunks for pending actions staged this run (lost on restart → rehydrate). */
  private readonly pendingThunks = new Map<string, () => Promise<unknown>>();

  constructor(opts: AgencyOptions) {
    this.identity = opts.identity;
    this.store = opts.store;
    this.logger = opts.logger ?? rootLog.child("agency");
    this.resolveRepoDir =
      opts.resolveRepoDir ??
      ((repo: string) => join(opts.paths.projects, repo.split("/").pop() ?? repo));
    this.github =
      opts.github ??
      new GitHubCli({
        pat: opts.identity.github.pat,
        account: opts.identity.github.account,
        apiBase: opts.identity.github.apiBase,
        resolveRepoDir: this.resolveRepoDir,
        logger: this.logger,
      });
  }

  /** Whether GitHub agency has credentials (drives graceful degradation in DELIVER). */
  get githubAvailable(): boolean {
    return this.identity.github.pat.length > 0;
  }

  classify(type: ActionType, ctx: ActionContext): ActionClass {
    return classifyAction(type, ctx);
  }

  /**
   * The one door (Spec 07 §2.4). Returns `done` for FREE (after running `execute`); `pending`
   * for HANDSHAKE_GATED (a PendingAction is staged + persisted, `execute` is held, NOT run);
   * throws {@link GateRefused} for ALWAYS_ASK.
   */
  async perform<T>(
    type: ActionType,
    ctx: ActionContext,
    execute: () => Promise<T>,
    handshake?: HandshakeSpec,
  ): Promise<GateActionResult<T>> {
    const cls = this.classify(type, ctx);
    this.logger.debug("gate.classify", { type, cls });

    switch (cls) {
      case ActionClass.FREE: {
        const value = await execute();
        return { status: "done", value };
      }

      case ActionClass.HANDSHAKE_GATED: {
        if (!handshake) {
          throw new Error(`agency: gated action "${type}" requires a HandshakeSpec (Spec 07 §2.4)`);
        }
        const pa = this.stagePendingAction(type, ctx, handshake);
        // Hold the live thunk for same-process execution on approval; rehydratable otherwise.
        this.pendingThunks.set(pa.id, execute as () => Promise<unknown>);
        return { status: "pending", pendingAction: pa };
      }

      case ActionClass.ALWAYS_ASK:
      default:
        throw new GateRefused(type, ctx);
    }
  }

  /** Persist a PendingAction row + return the in-memory handle (Spec 07 §5.1; Spec 09 §2.11). */
  private stagePendingAction(
    type: ActionType,
    ctx: ActionContext,
    handshake: HandshakeSpec,
  ): PendingAction {
    const taskId = typeof ctx.taskId === "string" ? ctx.taskId : "";
    const userId = typeof ctx.userId === "string" ? ctx.userId : "";
    if (!taskId || !userId) {
      throw new Error(
        `agency: gated action "${type}" needs ctx.taskId and ctx.userId to stage a PendingAction`,
      );
    }
    const now = Date.now();
    const expiresAt = handshake.expiresAt ?? now + DEFAULT_HANDSHAKE_MS;
    const actionClass = handshake.actionClass ?? pendingClassFor(type);

    const pa: PendingAction = {
      id: pendingActionId(),
      taskId,
      userId,
      actionClass,
      payload: handshake.payload,
      promptText: handshake.promptText,
      status: "pending",
      createdAt: now,
      expiresAt,
    };

    const row: PendingActionRow = {
      id: pa.id,
      task_id: taskId,
      user_id: userId,
      action_class: actionClass,
      payload_json: JSON.stringify(handshake.payload),
      prompt_text: handshake.promptText,
      posted_msg_id: null,
      status: "pending",
      decided_by: null,
      created_at: now,
      decided_at: null,
      expires_at: expiresAt,
    };
    this.store.createPendingAction(row); // emits handshake.posted (Spec 09)
    this.logger.info("handshake staged", { pendingActionId: pa.id, type, actionClass });
    return pa;
  }

  /**
   * Execute a handshake-approved action and mark it `executed` (Spec 07 §5.2). Uses the live
   * thunk if this is the same daemon run; otherwise rehydrates the irreversible op from the
   * persisted `(action_class, payload)` (Spec 07 §5.3 — restart-safe, no closure state).
   * The caller (orchestrator) is responsible for having recorded the user's `go`.
   */
  async executeApproved(pa: PendingActionRow): Promise<GateActionResult<unknown>> {
    const thunk = this.pendingThunks.get(pa.id);
    const value = thunk ? await thunk() : await this.rehydrateAndRun(pa);
    this.pendingThunks.delete(pa.id);
    this.store.setPendingActionStatus(pa.id, "executed", pa.decided_by ?? undefined);
    return { status: "done", value };
  }

  /**
   * Reconstruct + run a pending action's irreversible op from its persisted payload after a
   * restart (Spec 07 §5.3). v0 rehydrates `merge_pr`; other classes are not reconstructable in
   * v0 and surface a clear error rather than a silent no-op.
   */
  private async rehydrateAndRun(pa: PendingActionRow): Promise<unknown> {
    const payload = JSON.parse(pa.payload_json) as Record<string, unknown>;
    switch (pa.action_class) {
      case "merge_pr": {
        const repo = String(payload.repo);
        const number = Number(payload.number);
        const strategy = (payload.strategy as MergeStrategy) ?? "squash";
        await this.github.mergePR(repo, number, strategy);
        return { merged: true, repo, number, strategy };
      }
      default:
        throw new Error(
          `agency: cannot rehydrate pending action class "${pa.action_class}" in v0 ` +
            `(${pa.id}) — only merge_pr is reconstructable; re-issue the action from the orchestrator`,
        );
    }
  }
}

// =======================================================================================
// Factory
// =======================================================================================

/**
 * Build the wired {@link BeckettAgency} from config + paths + store (Spec 01 wiring). Loads
 * the {@link Identity} from `.env`, constructs the GitHub client, and resolves repo dirs under
 * `paths.projects`. If `GITHUB_PAT` is absent the agency still builds — classify/perform work,
 * and GitHub ops degrade gracefully (see {@link PR_PENDING_CREDS_NOTE}).
 */
export function createAgency(
  config: Config,
  paths: Paths,
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
): BeckettAgency {
  const identity = loadIdentity(config, env);
  return new BeckettAgency({ identity, store, paths });
}

/** Compile-time check: BeckettAgency satisfies the frozen Agency contract. */
const _agencyCheck: (a: BeckettAgency) => Agency = (a) => a;
void _agencyCheck;

export type { Agency } from "../types.ts";
