/**
 * Beckett — `beckett finish` (`src/cli/finish.ts`)
 * =======================================================================================
 * ONE verb for the end-of-ticket motion the concierge used to run by hand: push the finished
 * branch, open (or reuse) its PR with the given message, wait for CI, merge it into main, then run
 * THE guarded redeploy (`deploy/deploy-prod.sh` — dirty-tree refusal, typecheck gate, browser
 * drain, health read-back, release tag). Five-plus separate CLI calls and a lot of back-and-forth
 * collapse into `beckett finish -m "<message>"`.
 *
 * Two properties matter more than the convenience:
 *
 *  1. **Every stop is NAMED.** A wrapper that fails with "merge failed" or hangs forever is worse
 *     than the manual sequence it replaced, because the caller can no longer see which step it was
 *     on. So each stage diagnoses its own blocker into a specific, actionable line — which PR, what
 *     GitHub says is blocking it, and the exact command that unsticks it — and CI waiting is
 *     BOUNDED (`--ci-timeout`), never an open-ended poll. {@link gateMerge} holds that logic as a
 *     pure function so the message for every blocker shape is pinned by tests, not discovered in
 *     production.
 *  2. **It reuses the existing guarded paths.** PR/merge go through `GitHubCli` (the one credential
 *     boundary — never raw `gh`/`git push`); the deploy is the existing script, spawned, never a
 *     hand-rolled restart. This command adds sequencing and diagnosis, not a second way to ship.
 *
 * Idempotent by construction: re-running after a fixed blocker reuses the open PR
 * (`GitHubCli.ensurePR`), skips the merge if it already landed, and redeploys.
 *
 * Every invocation posts one line to the ops channel ({@link FINISH_AUDIT_CHANNEL_ID}) before it
 * touches anything, so the ledger records the runs that FAILED too — those are the ones worth
 * seeing. The post is best-effort: a dead daemon must never block shipping.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PrMergeability } from "../github/types.ts";
import { fail, out, quietLogger } from "./io.ts";
import { config, SOCK } from "./context.ts";

export const FINISH_USAGE =
  'usage: beckett finish -m "<message>" [--dir <path>] [--repo <owner/name>] [--base <branch>] ' +
  "[--strategy squash|merge|rebase] [--bump yes|patch|minor|major] [--no-deploy] [--no-commit] " +
  "[--ci-timeout <secs>] [--json (quiet: result only, no progress narration)]";

/**
 * The ops channel every `beckett finish` run announces itself in — the same room the daemon posts
 * startup and dispatch events to, so shipping shows up in the ledger next to everything else.
 * `BECKETT_FINISH_AUDIT_CHANNEL_ID=disabled` silences it (dev boxes, tests).
 */
export const FINISH_AUDIT_CHANNEL_ID = "1520658476974735490";

/** How long to keep polling GitHub for a verdict before giving up with a specific message. */
const DEFAULT_CI_TIMEOUT_MS = 15 * 60_000;
/** Gap between mergeability reads while CI runs. */
const POLL_INTERVAL_MS = 15_000;
/**
 * A PR that was opened seconds ago legitimately reports ZERO checks — the workflows have not
 * registered yet. Merging into that window would ship past a CI suite that never ran, so an
 * empty rollup is treated as "still pending" until this grace elapses, and only then as "this repo
 * has no CI".
 */
const CHECKS_GRACE_MS = 60_000;
/** Lines of deploy output kept for the failure message. */
const DEPLOY_TAIL_LINES = 25;

// ── argv ────────────────────────────────────────────────────────────────────────────────────

export interface FinishOptions {
  /** PR title — the first line of `-m`. */
  title: string;
  /** PR body — the remaining lines of `-m`, or `--body`. */
  body: string;
  dir: string;
  repo?: string;
  base: string;
  strategy: "squash" | "merge" | "rebase";
  /** `BECKETT_BUMP` for the guarded deploy — it must never prompt from here (no TTY). */
  bump: "yes" | "patch" | "minor" | "major";
  deploy: boolean;
  /** Commit a dirty tree with the given message instead of refusing it. */
  commit: boolean;
  ciTimeoutMs: number;
  /** Suppress the live progress/deploy narration on stderr; stdout's result object is unchanged. */
  json: boolean;
}

const STRATEGIES = ["squash", "merge", "rebase"] as const;
const BUMPS = ["yes", "patch", "minor", "major"] as const;
const VALUE_FLAGS = ["message", "body", "dir", "repo", "base", "strategy", "bump", "ci-timeout"];
const BOOL_FLAGS = ["no-deploy", "no-commit", "json"];

/** A usage problem, raised so {@link runFinish} owns the single `fail()` (helpers stay testable). */
export class FinishUsageError extends Error {}

function usage(msg: string): never {
  throw new FinishUsageError(`${msg}\n${FINISH_USAGE}`);
}

/**
 * Parse `beckett finish`'s argv. Hand-rolled rather than reusing `io.ts::parse` for one reason:
 * `-m` is a SINGLE-dash short flag (the shape the ticket specifies and the shape every operator
 * types), which the shared parser reads as a positional. Unknown flags are refused rather than
 * ignored — a typo'd `--ci-timeout` silently falling back to the default is exactly the kind of
 * quiet wrongness this command exists to remove.
 */
export function parseFinishArgs(argv: string[], cwd = process.cwd()): FinishOptions {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const key = token === "-m" ? "message" : token.startsWith("--") ? token.slice(2) : null;
    if (key === null) usage(`beckett finish: unexpected argument "${token}" (the message needs -m or --message)`);
    if (BOOL_FLAGS.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(key)) usage(`beckett finish: unknown flag "${token}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value === "-m") usage(`beckett finish: --${key} needs a value`);
    flags[key] = value;
    i++;
  }

  const message = typeof flags.message === "string" ? flags.message.trim() : "";
  if (!message) usage('beckett finish: a message is required — beckett finish -m "what this ticket shipped"');

  // `-m` doubles as the commit message and the PR title/body: first line titles, the rest is body.
  const [firstLine, ...restLines] = message.split("\n");
  const inlineBody = restLines.join("\n").trim();
  const body = typeof flags.body === "string" ? flags.body : inlineBody;

  const strategy = typeof flags.strategy === "string" ? flags.strategy : "squash";
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    usage(`beckett finish: --strategy must be one of ${STRATEGIES.join("|")}`);
  }
  const bump = typeof flags.bump === "string" ? flags.bump : "yes";
  if (!(BUMPS as readonly string[]).includes(bump)) {
    usage(`beckett finish: --bump must be one of ${BUMPS.join("|")}`);
  }

  let ciTimeoutMs = DEFAULT_CI_TIMEOUT_MS;
  if (typeof flags["ci-timeout"] === "string") {
    const secs = Number(flags["ci-timeout"]);
    // 0 means "don't wait": anything not already mergeable is reported as a blocker immediately.
    if (!Number.isFinite(secs) || secs < 0) usage("beckett finish: --ci-timeout must be a number of seconds (0 to refuse rather than wait)");
    ciTimeoutMs = Math.round(secs * 1000);
  }

  return {
    title: firstLine!.trim(),
    body,
    dir: typeof flags.dir === "string" ? flags.dir : cwd,
    repo: typeof flags.repo === "string" ? flags.repo : undefined,
    base: typeof flags.base === "string" ? flags.base : "main",
    strategy: strategy as FinishOptions["strategy"],
    bump: bump as FinishOptions["bump"],
    deploy: flags["no-deploy"] !== true,
    commit: flags["no-commit"] !== true,
    ciTimeoutMs,
    json: flags.json === true,
  };
}

// ── git plumbing ────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const git = (args: string[], cwd: string) => run(["git", ...args], cwd);

/**
 * `owner/name` out of any origin URL shape git hands back — HTTPS with or without `.git`, SSH
 * (`git@host:owner/name.git`), and `ssh://` — or null when it isn't a recognizable GitHub-style
 * remote (a local path remote, say), in which case the caller asks for `--repo`.
 */
export function repoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const scp = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/); // git@github.com:owner/name
  const path = scp ? scp[1]! : trimmed.match(/^[a-z+]+:\/\/[^/]+\/(.+)$/i)?.[1] ?? null;
  if (path === null) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join("/");
}

// ── the merge gate (pure: every blocker's message is pinned by tests) ────────────────────────

export type MergeGate =
  /** Already on main — skip the merge and go straight to the deploy. */
  | { kind: "merged" }
  /** Clear to merge now. */
  | { kind: "ready" }
  /** Not yet, but it may still resolve on its own — keep polling until the deadline. */
  | { kind: "wait"; why: string }
  /** It will not resolve on its own. `error` names the blocker AND the command that clears it. */
  | { kind: "blocked"; error: string };

/**
 * Decide what to do with a PR from GitHub's own verdict. Ordering is deliberate: the most SPECIFIC
 * cause wins, because `mergeStateStatus` collapses several distinct problems into `BLOCKED` and a
 * caller told "blocked" learns nothing. So failed checks are reported as failed checks, conflicts
 * as conflicts, and only a genuinely unexplained block falls through to the generic branch —
 * which still names the status GitHub returned rather than inventing a reason.
 *
 * `checksGraceElapsed` distinguishes "this repo has no CI" from "the workflows have not registered
 * yet", which look identical over the API (an empty rollup) for the first seconds of a PR's life.
 */
export function gateMerge(pr: PrMergeability, repo: string, checksGraceElapsed: boolean): MergeGate {
  const ref = `PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}`;
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state === "CLOSED") {
    return {
      kind: "blocked",
      error:
        `${ref} is CLOSED, so there is nothing to merge. Reopen it (\`beckett gh raw -- pr reopen ${pr.number} ` +
        `--repo ${repo}\`) and re-run \`beckett finish\`, or finish from a branch that still has an open PR.`,
    };
  }
  if (pr.isDraft) {
    return {
      kind: "blocked",
      error:
        `${ref} is a DRAFT — GitHub refuses to merge drafts. Mark it ready with ` +
        `\`beckett gh raw -- pr ready ${pr.number} --repo ${repo}\`, then re-run \`beckett finish\`.`,
    };
  }
  if (pr.checks.conclusion === "FAILURE") {
    return {
      kind: "blocked",
      error:
        `CI FAILED on ${ref}: ${pr.checks.failed} of ${pr.checks.total} checks red ` +
        `(${pr.checks.passed} passed, ${pr.checks.pending} still running). Refusing to merge red. ` +
        `Read them with \`beckett gh raw -- pr checks ${pr.number} --repo ${repo}\`, push the fix to ` +
        `\`${pr.headRefName || "the branch"}\`, then re-run \`beckett finish\`.`,
    };
  }
  if (pr.checks.conclusion === "PENDING") {
    return { kind: "wait", why: `${pr.checks.pending} of ${pr.checks.total} checks still running` };
  }
  if (pr.checks.total === 0 && !checksGraceElapsed) {
    return { kind: "wait", why: "no checks reported yet (waiting for the workflows to register)" };
  }
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return {
      kind: "blocked",
      error:
        `${ref} has MERGE CONFLICTS with ${pr.baseRefName || "the base branch"}. Nothing automatic can ` +
        `resolve these. In the branch checkout: \`git fetch origin && git rebase origin/${pr.baseRefName || "main"}\`, ` +
        `settle the conflicts, push, then re-run \`beckett finish\`.`,
    };
  }
  // GitHub recomputes mergeability asynchronously; UNKNOWN means "ask again", not "no".
  if (pr.mergeable === "UNKNOWN") return { kind: "wait", why: "GitHub is still computing mergeability" };
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      kind: "blocked",
      error:
        `${ref} is BEHIND ${pr.baseRefName || "main"} and this repo requires branches to be up to date ` +
        `before merging. Update it (\`git fetch origin && git rebase origin/${pr.baseRefName || "main"}\` in the ` +
        `branch checkout, then push) and re-run \`beckett finish\`.`,
    };
  }
  if (pr.mergeStateStatus === "BLOCKED") {
    return {
      kind: "blocked",
      error:
        `${ref} is BLOCKED by branch protection — checks are ${pr.checks.conclusion.toLowerCase()}, so what is ` +
        `missing is almost certainly a required REVIEW or a required check that has not reported. ` +
        `Check with \`beckett gh raw -- pr view ${pr.number} --repo ${repo}\`; get the approval (or fix the ` +
        `protection rule), then re-run \`beckett finish\`.`,
    };
  }
  return { kind: "ready" };
}

/**
 * A `gh pr merge` refusal, translated. gh's own stderr is accurate but terse ("Pull request is not
 * mergeable"), and by the time it appears the caller has already lost the pre-merge read — so
 * restate what it means HERE, with the branch and repo filled in, rather than passing the raw line
 * through and letting whoever reads it guess.
 */
export function describeMergeFailure(err: string, repo: string, number: number, branch: string): string {
  const raw = err.trim();
  const lower = raw.toLowerCase();
  const rebase = `\`git fetch origin && git rebase origin/main\` in the ${branch} checkout, push, then re-run \`beckett finish\``;
  if (lower.includes("not mergeable") || lower.includes("conflict")) {
    return `merging PR #${number} failed: GitHub refused it as not mergeable — the base moved under the branch. Resolve with ${rebase}.\n${raw}`;
  }
  if (lower.includes("required status check") || lower.includes("review") || lower.includes("protected branch")) {
    return `merging PR #${number} failed: branch protection on ${repo} still refuses it (a required review or check). Read \`beckett gh raw -- pr view ${number} --repo ${repo}\`, clear it, then re-run \`beckett finish\`.\n${raw}`;
  }
  return `merging PR #${number} on ${repo} failed. ${raw}`;
}

/**
 * The guarded deploy's exit, translated. Its own gates already print a `FATAL:` line explaining
 * themselves, so surface THAT rather than a generic non-zero exit — and recognize the host-config
 * failures whose real cause ("Author identity unknown") is several layers below the symptom.
 */
export function describeDeployFailure(code: number, tail: string): string {
  const lower = tail.toLowerCase();
  const head = `the guarded deploy failed (exit ${code}) — the merge DID land on main, only the deploy is incomplete.`;
  if (lower.includes("author identity unknown") || lower.includes("please tell me who you are")) {
    return (
      `${head} Cause: git has no commit identity on this host, so the release-version bump could not be ` +
      `committed. Fix it once with \`git config --global user.email "<address>"\` and ` +
      `\`git config --global user.name "<name>"\`, then re-run \`beckett finish\` (the PR is already merged, ` +
      `so it will go straight to the deploy).\n${tail}`
    );
  }
  if (lower.includes("checkout is dirty")) {
    return (
      `${head} Cause: the deploy checkout on the daemon host has uncommitted edits, and it refuses to ` +
      `deploy over hand edits. On the host: \`cd ~/beckett && git status --short\`, restore it to a clean ` +
      `origin/main, then re-run \`beckett finish\`.\n${tail}`
    );
  }
  if (lower.includes("permission denied") || lower.includes("could not resolve hostname") || lower.includes("connection refused")) {
    return (
      `${head} Cause: the deploy could not reach the daemon host over ssh. Check BECKETT_HOST and the ssh ` +
      `key, then re-run \`beckett finish\`.\n${tail}`
    );
  }
  const fatal = tail.split("\n").find((line) => line.includes("FATAL:"));
  return `${head}${fatal ? ` Cause: ${fatal.trim()}` : ""}\n${tail}`;
}

/** Longest title the audit line carries; the daemon caps an ack at 240 chars, so cap it HERE
 *  rather than letting it truncate the trailing context away. */
const AUDIT_TITLE_MAX = 90;

/**
 * The one line each invocation records in the ops channel. `at` (a wall-clock stamp) is what makes
 * two runs distinct: the daemon coalesces byte-identical posts inside a two-minute window, and
 * "fix the blocker, re-run" legitimately repeats the same message — without the stamp the second
 * invocation would silently leave no record.
 */
export function finishAuditLine(repo: string, branch: string, title: string, at: Date): string {
  const short = title.length > AUDIT_TITLE_MAX ? `${title.slice(0, AUDIT_TITLE_MAX - 1).trimEnd()}…` : title;
  const stamp = at.toISOString().slice(11, 19);
  return `\`beckett finish\` ${stamp}Z — \`${repo}\` @ \`${branch}\`: "${short}" (PR → merge → redeploy)`;
}

// ── side-effecting helpers ──────────────────────────────────────────────────────────────────

/**
 * Live narration goes to STDERR so stdout stays exactly one JSON object for the caller to parse.
 * `--json` silences the narration (and the deploy's own output) for a caller that only wants the
 * result; nothing that ends up in an error message is narration-only, so silencing it never costs
 * diagnosis.
 */
let quiet = false;
function step(msg: string): void {
  if (!quiet) process.stderr.write(`finish: ${msg}\n`);
}

function auditChannelId(): string {
  return process.env.BECKETT_FINISH_AUDIT_CHANNEL_ID?.trim() || FINISH_AUDIT_CHANNEL_ID;
}

/**
 * Record this invocation in the ops channel. Best-effort BY DESIGN: the audit trail is worth a
 * couple of seconds, never worth refusing to ship because the daemon is restarting. A failure is
 * reported in the result rather than swallowed, so a silently-broken ledger stays visible.
 *
 * `discord.ack`, NOT `discord.reply` — and that difference is load-bearing. The concierge runs
 * `beckett finish` from INSIDE a live turn, and a `discord.reply` into the channel that turn is
 * running in CLAIMS it (`repliedViaCli`), which would make this bookkeeping line swallow the
 * concierge's actual answer. An ack posts without claiming anything.
 */
async function postAuditLine(text: string): Promise<{ posted: boolean; channel: string; note?: string }> {
  const channelId = auditChannelId();
  if (channelId === "disabled") return { posted: false, channel: channelId, note: "audit posting disabled" };
  try {
    const { callBus } = await import("../shell/control-bus.ts");
    const res = await callBus(SOCK, "discord.ack", { channelId, text }, 20_000);
    return res.ok
      ? { posted: true, channel: channelId }
      : { posted: false, channel: channelId, note: res.error ?? "the daemon refused the audit post" };
  } catch (err) {
    return { posted: false, channel: channelId, note: (err as Error).message };
  }
}

/** Build the one credentialed GitHub client this command uses (never raw `gh`/`git push`). */
async function buildGh(dir: string) {
  const { GITHUB_UNCONFIGURED_NOTE, GitHubCli, githubAuth, githubConfigured, loadIdentity } = await import("../agency/index.ts");
  const identity = loadIdentity(config);
  if (!githubConfigured(identity)) fail(`beckett finish: ${GITHUB_UNCONFIGURED_NOTE}`);
  return new GitHubCli({
    ...githubAuth(identity),
    account: identity.github.account,
    owner: identity.github.owner,
    apiBase: identity.github.apiBase,
    resolveRepoDir: () => dir,
    logger: quietLogger,
  });
}

/** Pump a child's stream to stderr live while keeping the last {@link DEPLOY_TAIL_LINES} lines. */
async function teeToStderr(stream: ReadableStream<Uint8Array> | null, tail: string[]): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    if (!quiet) process.stderr.write(text);
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      tail.push(line);
      if (tail.length > DEPLOY_TAIL_LINES) tail.shift();
    }
  }
  if (pending) tail.push(pending);
  while (tail.length > DEPLOY_TAIL_LINES) tail.shift();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the verb ────────────────────────────────────────────────────────────────────────────────

export async function runFinish(argv: string[]): Promise<void> {
  let opts: FinishOptions;
  try {
    opts = parseFinishArgs(argv);
  } catch (err) {
    if (err instanceof FinishUsageError) fail(err.message);
    throw err;
  }
  quiet = opts.json;

  // ── repo/branch context ──────────────────────────────────────────────────────────────────
  const top = await git(["rev-parse", "--show-toplevel"], opts.dir);
  if (top.code !== 0) {
    fail(
      `beckett finish: ${opts.dir} is not a git checkout, so there is no finished branch to ship. ` +
        `Run it from the ticket's worktree (e.g. ~/Projects/beckett) or pass --dir <path>.`,
    );
  }
  const repoRoot = top.stdout.trim();

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch || branch === "HEAD") {
    fail(
      `beckett finish: ${repoRoot} has no checked-out branch (detached HEAD), so there is nothing to open a ` +
        `PR from. Check the ticket's branch out first: \`git checkout <branch>\`.`,
    );
  }
  if (branch === opts.base) {
    fail(
      `beckett finish: you are on ${opts.base} — that is the merge TARGET, not a finished branch. Check out ` +
        `the ticket's branch (\`git checkout <branch>\`), or pass --base <other-branch> if you meant a ` +
        `different target. To redeploy what is already on ${opts.base}, run ./deploy/deploy-prod.sh.`,
    );
  }

  let repo = opts.repo;
  if (!repo) {
    const remote = await git(["remote", "get-url", "origin"], repoRoot);
    repo = (remote.code === 0 ? repoFromRemoteUrl(remote.stdout) : null) ?? undefined;
  }
  if (!repo) {
    fail(
      `beckett finish: could not work out which GitHub repo ${repoRoot} belongs to (no usable \`origin\` ` +
        `remote). Pass it explicitly: \`beckett finish -m "…" --repo <owner/name>\`.`,
    );
  }

  // Announce FIRST: the ledger should record the runs that go on to fail, not only the clean ones.
  const audit = await postAuditLine(finishAuditLine(repo, branch, opts.title, new Date()));
  if (audit.channel === "disabled") step("audit posting is disabled for this host — continuing");
  else if (!audit.posted) step(`audit post to ${audit.channel} did not land (${audit.note}) — continuing`);

  // ── the working tree ─────────────────────────────────────────────────────────────────────
  const status = await git(["status", "--porcelain"], repoRoot);
  if (status.code !== 0) fail(`beckett finish: could not read git status in ${repoRoot}: ${status.stderr.trim()}`);
  const dirty = status.stdout.trim();
  let committed = false;
  if (dirty) {
    if (!opts.commit) {
      fail(
        `beckett finish: ${repoRoot} has uncommitted changes and --no-commit was passed, so they would be ` +
          `left behind by the merge:\n${dirty}\nCommit them yourself and re-run, or drop --no-commit to let ` +
          `finish commit them with the given message.`,
      );
    }
    const identity = await gitIdentityProblem(repoRoot);
    if (identity) fail(`beckett finish: ${identity}`);
    step(`committing ${dirty.split("\n").length} pending change(s) with the given message`);
    const add = await git(["add", "-A"], repoRoot);
    if (add.code !== 0) fail(`beckett finish: \`git add -A\` failed in ${repoRoot}: ${add.stderr.trim()}`);
    const message = opts.body ? `${opts.title}\n\n${opts.body}` : opts.title;
    const commit = await git(["commit", "-m", message], repoRoot);
    if (commit.code !== 0) {
      fail(`beckett finish: committing the pending changes failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
    }
    committed = true;
  }

  // Only Beckett's own repo ships a guarded deploy. Resolving that here (not after the merge) is
  // what lets the identity preflight below run ONLY when a deploy is actually going to happen.
  const script = join(repoRoot, "deploy", "deploy-prod.sh");
  const willDeploy = opts.deploy && existsSync(script);

  // The deploy commits the release bump on THIS checkout, so a missing identity blocks it just as
  // surely as it blocks the commit above — catch it here, before the PR, not 10 minutes in.
  if (willDeploy) {
    const identity = await gitIdentityProblem(repoRoot);
    if (identity) fail(`beckett finish: ${identity} (the guarded deploy commits the release version bump)`);
  }

  const gh = await buildGh(repoRoot);

  // ── push ─────────────────────────────────────────────────────────────────────────────────
  step(`pushing ${branch} to ${repo}`);
  try {
    await gh.pushBranch(repo, "HEAD", branch);
  } catch (err) {
    const raw = (err as Error).message;
    const hint = /non-fast-forward|fetch first|rejected/i.test(raw)
      ? ` The remote branch has commits yours does not. Reconcile with \`git fetch origin && git rebase origin/${branch}\` in ${repoRoot}, then re-run.`
      : "";
    fail(`beckett finish: pushing ${branch} to ${repo} failed.${hint}\n${raw}`);
  }

  // ── PR ───────────────────────────────────────────────────────────────────────────────────
  step(`opening (or reusing) the PR into ${opts.base}`);
  let pr: { number: number; url: string };
  try {
    pr = await gh.ensurePR({ repo, base: opts.base, head: branch, title: opts.title, body: opts.body });
  } catch (err) {
    const raw = (err as Error).message;
    if (/no commits between/i.test(raw)) {
      fail(
        `beckett finish: ${branch} has no commits that ${opts.base} does not already have, so there is no PR ` +
          `to open — this work is already merged, or nothing was committed. Check with ` +
          `\`git log origin/${opts.base}..${branch}\` in ${repoRoot}.`,
      );
    }
    fail(`beckett finish: opening the PR for ${branch} on ${repo} failed.\n${raw}`);
  }
  step(`PR #${pr.number} — ${pr.url}`);

  // ── CI + merge gate ──────────────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  let gate: MergeGate = { kind: "wait", why: "reading the PR" };
  let lastWhy = "";
  for (;;) {
    let state: PrMergeability;
    try {
      state = await gh.prMergeability(repo, pr.number);
    } catch (err) {
      fail(`beckett finish: could not read PR #${pr.number} on ${repo} — cannot tell whether it is safe to merge.\n${(err as Error).message}`);
    }
    gate = gateMerge(state, repo, Date.now() - startedAt >= CHECKS_GRACE_MS);
    if (gate.kind === "blocked") fail(`beckett finish: ${gate.error}`);
    if (gate.kind !== "wait") break;
    lastWhy = gate.why;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= opts.ciTimeoutMs) {
      fail(
        `beckett finish: gave up waiting on PR #${pr.number} (${pr.url}) after ${Math.round(elapsed / 1000)}s — ` +
          `${lastWhy}. Nothing was merged and nothing was deployed. Watch it with ` +
          `\`beckett gh pr status ${pr.number} --repo ${repo}\` and re-run \`beckett finish\` once it settles, ` +
          `or raise the budget with --ci-timeout <secs>.`,
      );
    }
    step(`waiting on CI — ${lastWhy} (${Math.round(elapsed / 1000)}s of ${Math.round(opts.ciTimeoutMs / 1000)}s)`);
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, opts.ciTimeoutMs - elapsed)));
  }

  // ── merge ────────────────────────────────────────────────────────────────────────────────
  let merged: "merged" | "already-merged";
  if (gate.kind === "merged") {
    step(`PR #${pr.number} is already merged — going straight to the deploy`);
    merged = "already-merged";
  } else {
    step(`merging PR #${pr.number} into ${opts.base} (${opts.strategy})`);
    try {
      await gh.mergePR(repo, pr.number, opts.strategy);
    } catch (err) {
      fail(`beckett finish: ${describeMergeFailure((err as Error).message, repo, pr.number, branch)}`);
    }
    merged = "merged";
  }

  // ── the guarded redeploy ─────────────────────────────────────────────────────────────────
  let deploy: { ran: boolean; reason?: string } = { ran: false };
  if (!opts.deploy) {
    deploy = { ran: false, reason: "--no-deploy" };
    step("skipping the deploy (--no-deploy)");
  } else if (!willDeploy) {
    // Refusing here would strand every OTHER project's finish at the merge, and hand-rolling a
    // restart for them would be worse. Say plainly that there was nothing to redeploy.
    deploy = { ran: false, reason: `no guarded deploy path in this repo (${script} does not exist)` };
    step(`merged, but ${deploy.reason} — nothing to redeploy`);
  } else {
    step(`running the guarded redeploy (${script}, BECKETT_BUMP=${opts.bump})`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    // The deploy prompts for the version bump on a TTY; from here there is nobody to prompt, so it
    // is always pre-decided (`yes` accepts the script's own MINOR/PATCH classification).
    env.BECKETT_BUMP = opts.bump;
    const proc = Bun.spawn(["bash", script], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const tail: string[] = [];
    await Promise.all([teeToStderr(proc.stdout, tail), teeToStderr(proc.stderr, tail)]);
    const code = await proc.exited;
    if (code !== 0) fail(`beckett finish: ${describeDeployFailure(code, tail.join("\n").trim())}`);
    deploy = { ran: true };
  }

  out({
    ok: true,
    repo,
    branch,
    base: opts.base,
    committed,
    pr: { number: pr.number, url: pr.url },
    merge: { state: merged, strategy: opts.strategy },
    deploy: deploy.ran ? { ran: true, script, bump: opts.bump } : { ran: false, reason: deploy.reason },
    audit,
  });
}

/**
 * The commit identity `git commit` needs, checked BEFORE anything is pushed or merged. Git's own
 * failure ("Author identity unknown") surfaces deep inside the deploy, minutes after the merge has
 * already landed — exactly the "blocked by host config" case this command must name up front.
 */
async function gitIdentityProblem(cwd: string): Promise<string | null> {
  const [email, name] = await Promise.all([
    git(["config", "--get", "user.email"], cwd),
    git(["config", "--get", "user.name"], cwd),
  ]);
  const missing = [
    email.code === 0 && email.stdout.trim() ? null : "user.email",
    name.code === 0 && name.stdout.trim() ? null : "user.name",
  ].filter((v): v is string => v !== null);
  if (missing.length === 0) return null;
  return (
    `git has no commit identity in ${cwd} (${missing.join(" and ")} unset), so nothing here can be ` +
    `committed. Set it once: ` +
    missing.map((key) => `\`git config --global ${key} "<value>"\``).join(" and ") +
    `, then re-run \`beckett finish\`.`
  );
}
