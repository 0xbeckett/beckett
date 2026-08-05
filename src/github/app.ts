/**
 * Beckett — GitHub App authentication (`src/github/app.ts`)
 * =======================================================================================
 * Beckett's GitHub identity is a **GitHub App owned by `kowo-co`**, not a machine account.
 * The old `0xbeckett` account is gone (2FA unrecoverable) and a PAT tied to one human-shaped
 * login was never the right shape anyway: an App can be **installed by anyone, on the repos
 * they choose**, which is the whole product flow — a stranger in Discord grants Beckett access
 * to their repo in two clicks instead of adding a bot user as a collaborator.
 *
 * The credential chain, in full (all three steps are real; nothing here is stubbed):
 *
 *   1. **App JWT** — RS256 over `{iat, exp, iss: <app id>}`, signed with the app's private key,
 *      max 10 minutes. Authenticates Beckett *as the app itself*: `/app`, `/app/installations`,
 *      `/orgs/{org}/installation`, `/repos/{owner}/{repo}/installation`.
 *   2. **Installation lookup** — an app has one *installation* per account that installed it.
 *      Tokens are minted per-installation, so every call must first resolve which installation
 *      covers the target owner/repo.
 *   3. **Installation access token** — `POST /app/installations/{id}/access_tokens`, valid one
 *      hour, scoped to that installation's repo selection and the app's permissions. This is the
 *      thing handed to `git` (as `x-access-token:<token>`) and `gh` (as `GH_TOKEN`).
 *
 * Configuration (env, loaded from `~/.beckett/.env` — see `.env.example`):
 *   - `GITHUB_APP_ID`              — the numeric app id (required to enable app auth)
 *   - `GITHUB_APP_PRIVATE_KEY_PATH`— path to the downloaded `.pem` (preferred), **or**
 *   - `GITHUB_APP_PRIVATE_KEY_PEM` — the PEM inline (`\n` escapes accepted)
 *   - `GITHUB_APP_INSTALLATION_ID` — optional pin for the home installation (`kowo-co`)
 *   - `GITHUB_APP_SLUG`            — optional; otherwise read live from `GET /app`
 *
 * FAIL LOUD is the rule: a half-configured app (id without a key, an unreadable key path, a
 * file that isn't a private key) throws {@link GitHubAppConfigError} at load time rather than
 * quietly degrading to "no GitHub". Silence here would look exactly like success.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// =======================================================================================
// Errors
// =======================================================================================

/** Thrown when the app credentials in the environment are present-but-broken (never silent). */
export class GitHubAppConfigError extends Error {
  constructor(message: string) {
    super(`github app: ${message}`);
    this.name = "GitHubAppConfigError";
  }
}

/**
 * Thrown when a GitHub API call made with app credentials fails. Carries the HTTP status and
 * GitHub's own `message` verbatim so the troubleshooting playbook can triage on the real shape
 * (`401 "A JSON web token could not be decoded"` = bad key/clock; `404 "Not Found"` on an
 * installation lookup = not installed *or* no such repo; `422` = installation token refused).
 */
export class GitHubAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly githubMessage: string,
    readonly endpoint: string,
  ) {
    super(`github app: ${endpoint} failed — HTTP ${status}: ${githubMessage}`);
    this.name = "GitHubAppApiError";
  }
}

// =======================================================================================
// Credentials
// =======================================================================================

export interface GitHubAppCredentials {
  /** Numeric app id as a string (GitHub prints it on the app settings page). */
  appId: string;
  /** PKCS#1/PKCS#8 RSA private key, PEM-encoded. NEVER logged. */
  privateKeyPem: string;
  /** Optional pinned installation — the home installation (`kowo-co`) on this box. */
  installationId?: number;
  /** Optional slug override for building install links without a network round-trip. */
  slug?: string;
}

type Env = Record<string, string | undefined>;

const APP_ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_PRIVATE_KEY_PEM",
  "GITHUB_APP_INSTALLATION_ID",
] as const;

/** True when the operator has started configuring app auth (so a partial config must throw). */
export function hasGitHubAppEnv(env: Env = process.env): boolean {
  return APP_ENV_KEYS.some((k) => (env[k] ?? "").trim() !== "");
}

/**
 * Load app credentials from the environment. Returns `null` ONLY when nothing app-shaped is
 * configured at all (the PAT path is still valid); throws {@link GitHubAppConfigError} for every
 * partial or malformed configuration.
 */
export function loadGitHubAppCredentials(env: Env = process.env): GitHubAppCredentials | null {
  if (!hasGitHubAppEnv(env)) return null;

  const appId = (env.GITHUB_APP_ID ?? "").trim();
  if (!appId) {
    throw new GitHubAppConfigError(
      "GITHUB_APP_PRIVATE_KEY_* is set but GITHUB_APP_ID is not — set the numeric app id from " +
        "https://github.com/organizations/kowo-co/settings/apps",
    );
  }
  if (!/^\d+$/.test(appId)) {
    throw new GitHubAppConfigError(
      `GITHUB_APP_ID must be the numeric app id, got "${appId}" (the slug is GITHUB_APP_SLUG)`,
    );
  }

  const keyPath = (env.GITHUB_APP_PRIVATE_KEY_PATH ?? "").trim();
  const inlinePem = (env.GITHUB_APP_PRIVATE_KEY_PEM ?? "").trim();
  if (!keyPath && !inlinePem) {
    throw new GitHubAppConfigError(
      "GITHUB_APP_ID is set but no private key — set GITHUB_APP_PRIVATE_KEY_PATH to the .pem " +
        "downloaded from the app settings page (or GITHUB_APP_PRIVATE_KEY_PEM inline)",
    );
  }

  let privateKeyPem: string;
  if (keyPath) {
    try {
      privateKeyPem = readFileSync(keyPath, "utf8");
    } catch (err) {
      throw new GitHubAppConfigError(
        `cannot read GITHUB_APP_PRIVATE_KEY_PATH "${keyPath}": ${(err as Error).message}`,
      );
    }
  } else {
    // An inline PEM in a dotenv file carries literal \n; restore them so the key parses.
    privateKeyPem = inlinePem.includes("\\n") ? inlinePem.replace(/\\n/g, "\n") : inlinePem;
  }

  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKeyPem)) {
    throw new GitHubAppConfigError(
      `${keyPath ? `the file at "${keyPath}"` : "GITHUB_APP_PRIVATE_KEY_PEM"} is not a PEM private ` +
        "key — download the key again from the app settings page (Generate a private key)",
    );
  }

  const rawInstallation = (env.GITHUB_APP_INSTALLATION_ID ?? "").trim();
  let installationId: number | undefined;
  if (rawInstallation) {
    if (!/^\d+$/.test(rawInstallation)) {
      throw new GitHubAppConfigError(
        `GITHUB_APP_INSTALLATION_ID must be numeric, got "${rawInstallation}"`,
      );
    }
    installationId = Number(rawInstallation);
  }

  const slug = (env.GITHUB_APP_SLUG ?? "").trim() || undefined;
  return { appId, privateKeyPem, installationId, slug };
}

// =======================================================================================
// JWT
// =======================================================================================

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint the app JWT (RS256). `iat` is backdated 60s because GitHub rejects a token whose `iat` is
 * in the future by even a second of clock drift; `exp` is 9 minutes out (GitHub's ceiling is 10).
 */
export function mintAppJwt(creds: GitHubAppCredentials, nowMs: number = Date.now()): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: creds.appId }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = base64url(signer.sign(creds.privateKeyPem));
  } catch (err) {
    throw new GitHubAppConfigError(
      `could not sign the app JWT with the configured private key: ${(err as Error).message}`,
    );
  }
  return `${signingInput}.${signature}`;
}

// =======================================================================================
// API shapes
// =======================================================================================

export interface AppMetadata {
  id: number;
  slug: string;
  name: string;
  /** Login of the account that owns the app (`kowo-co`). */
  owner: string;
}

export interface AppInstallation {
  id: number;
  /** Login of the account the app is installed on. */
  account: string;
  /** "User" | "Organization". */
  accountType: string;
  /** "all" = every repo the account owns, "selected" = an explicit list. */
  repositorySelection: "all" | "selected";
}

export interface InstallationToken {
  token: string;
  /** ISO-8601 expiry (GitHub gives one hour). */
  expiresAt: string;
  installationId: number;
  repositorySelection?: "all" | "selected";
  permissions?: Record<string, string>;
}

/**
 * The result of {@link GitHubAppAuth.diagnoseAccess} — the ordered triage the troubleshooting
 * playbook runs BEFORE telling anyone "I can't see that repo".
 */
export type AccessDiagnosis =
  /** An installation covers the target; Beckett can act. */
  | { status: "ok"; owner: string; repo?: string; installationId: number; repositorySelection: "all" | "selected" }
  /** The app is not installed on that account at all → send the install link. */
  | { status: "not-installed"; owner: string; installUrl: string }
  /** Installed on the account, but this repo isn't in the selection → send the same link to add it. */
  | { status: "repo-not-selected"; owner: string; repo: string; installationId: number; installUrl: string }
  /**
   * Installed on the account; the repo is neither selected nor publicly visible. Either it is not
   * in the selection (private) or it does not exist. GitHub cannot distinguish these for us — say so.
   */
  | { status: "repo-not-selected-or-missing"; owner: string; repo: string; installationId: number; installUrl: string }
  /** No such user/org on GitHub — almost always a typo in the owner. */
  | { status: "no-such-owner"; owner: string };

// =======================================================================================
// GitHubAppAuth — JWT → installation lookup → cached installation token
// =======================================================================================

export interface GitHubAppAuthOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Refresh an installation token this long before it actually expires (GitHub gives 60 min). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class GitHubAppAuth {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<number, InstallationToken>();
  private metadata: AppMetadata | null = null;

  constructor(
    private readonly creds: GitHubAppCredentials,
    opts: GitHubAppAuthOptions = {},
  ) {
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  get appId(): string {
    return this.creds.appId;
  }

  /** The pinned home installation, when the operator set `GITHUB_APP_INSTALLATION_ID`. */
  get pinnedInstallationId(): number | undefined {
    return this.creds.installationId;
  }

  /** One request authenticated as the APP (JWT). `null` on 404 when `allow404`. */
  private async apiAsApp<T>(
    path: string,
    init: { method?: string; body?: unknown; allow404?: boolean } = {},
  ): Promise<T | null> {
    const jwt = mintAppJwt(this.creds, this.now());
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "beckett",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (res.status === 404 && init.allow404) return null;
    if (!res.ok) throw new GitHubAppApiError(res.status, await githubMessage(res), path);
    return (await res.json()) as T;
  }

  /** `GET /app` — the app's own record; the source of the slug used to build install links. */
  async appMetadata(): Promise<AppMetadata> {
    if (this.metadata) return this.metadata;
    const raw = await this.apiAsApp<{ id: number; slug: string; name: string; owner?: { login?: string } }>("/app");
    if (!raw) throw new GitHubAppApiError(404, "Not Found", "/app");
    this.metadata = { id: raw.id, slug: raw.slug, name: raw.name, owner: raw.owner?.login ?? "" };
    return this.metadata;
  }

  /** The public install link a user clicks to grant Beckett access to their repos. */
  async installUrl(): Promise<string> {
    const slug = this.creds.slug ?? (await this.appMetadata()).slug;
    return appInstallUrl(slug);
  }

  /** `GET /app/installations` — every account that has installed Beckett. */
  async listInstallations(): Promise<AppInstallation[]> {
    const raw =
      (await this.apiAsApp<
        Array<{
          id: number;
          account?: { login?: string; type?: string };
          repository_selection?: string;
        }>
      >("/app/installations?per_page=100")) ?? [];
    return raw.map((i) => ({
      id: i.id,
      account: i.account?.login ?? "",
      accountType: i.account?.type ?? "",
      repositorySelection: i.repository_selection === "all" ? "all" : "selected",
    }));
  }

  /** The installation on a user/org, or `null` when the app is not installed there. */
  async installationForOwner(owner: string): Promise<AppInstallation | null> {
    const name = owner.trim();
    if (!name) return null;
    for (const path of [`/orgs/${name}/installation`, `/users/${name}/installation`]) {
      const raw = await this.apiAsApp<{
        id: number;
        account?: { login?: string; type?: string };
        repository_selection?: string;
      }>(path, { allow404: true });
      if (raw) {
        return {
          id: raw.id,
          account: raw.account?.login ?? name,
          accountType: raw.account?.type ?? "",
          repositorySelection: raw.repository_selection === "all" ? "all" : "selected",
        };
      }
    }
    return null;
  }

  /**
   * The installation that covers `owner/repo`, or `null`. A 404 here means EITHER not installed,
   * OR installed without this repo selected, OR no such repo — {@link diagnoseAccess} separates them.
   */
  async installationForRepo(repo: string): Promise<AppInstallation | null> {
    const slug = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!slug.includes("/")) return null;
    const raw = await this.apiAsApp<{
      id: number;
      account?: { login?: string; type?: string };
      repository_selection?: string;
    }>(`/repos/${slug}/installation`, { allow404: true });
    if (!raw) return null;
    return {
      id: raw.id,
      account: raw.account?.login ?? slug.split("/")[0]!,
      accountType: raw.account?.type ?? "",
      repositorySelection: raw.repository_selection === "all" ? "all" : "selected",
    };
  }

  /** The repositories an installation can reach (installation-token auth, paginated). */
  async installationRepositories(installationId: number): Promise<string[]> {
    const { token } = await this.tokenForInstallation(installationId);
    const names: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await this.fetchImpl(`${this.apiBase}/installation/repositories?per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "beckett",
        },
      });
      if (!res.ok) {
        throw new GitHubAppApiError(res.status, await githubMessage(res), "/installation/repositories");
      }
      const body = (await res.json()) as { repositories?: Array<{ full_name?: string }> };
      const batch = body.repositories ?? [];
      for (const r of batch) if (r.full_name) names.push(r.full_name);
      if (batch.length < 100) break;
    }
    return names;
  }

  /**
   * Mint (or reuse) an installation access token. Cached per installation and refreshed
   * {@link TOKEN_REFRESH_MARGIN_MS} before expiry, so long-running daemon work never hands a
   * dead token to `git push`.
   */
  async tokenForInstallation(installationId: number): Promise<InstallationToken> {
    const cached = this.tokens.get(installationId);
    if (cached && Date.parse(cached.expiresAt) - this.now() > TOKEN_REFRESH_MARGIN_MS) return cached;

    const path = `/app/installations/${installationId}/access_tokens`;
    const raw = await this.apiAsApp<{
      token?: string;
      expires_at?: string;
      repository_selection?: string;
      permissions?: Record<string, string>;
    }>(path, { method: "POST" });
    if (!raw?.token || !raw.expires_at) {
      throw new GitHubAppApiError(502, "installation token response had no token", path);
    }
    const minted: InstallationToken = {
      token: raw.token,
      expiresAt: raw.expires_at,
      installationId,
      repositorySelection: raw.repository_selection === "all" ? "all" : "selected",
      permissions: raw.permissions,
    };
    this.tokens.set(installationId, minted);
    return minted;
  }

  /**
   * Resolve a usable installation token for a target, in the order that keeps a multi-installation
   * app honest: the repo's own installation → the owner's installation → the pinned home
   * installation → the sole installation when there is exactly one. Anything else throws with the
   * real list, because guessing which stranger's repos to touch is the one thing that must not happen.
   */
  async token(target: { repo?: string; owner?: string } = {}): Promise<InstallationToken> {
    if (target.repo) {
      const byRepo = await this.installationForRepo(target.repo);
      if (byRepo) return this.tokenForInstallation(byRepo.id);
    }
    const owner = target.owner ?? (target.repo?.includes("/") ? target.repo.split("/")[0] : undefined);
    if (owner) {
      const byOwner = await this.installationForOwner(owner);
      if (byOwner) return this.tokenForInstallation(byOwner.id);
    }
    if (this.creds.installationId) return this.tokenForInstallation(this.creds.installationId);

    const all = await this.listInstallations();
    if (all.length === 1) return this.tokenForInstallation(all[0]!.id);

    const where = target.repo ?? owner ?? "the request";
    const installUrl = await this.installUrl().catch(() => "https://github.com/apps");
    if (all.length === 0) {
      throw new GitHubAppApiError(
        404,
        `the app has no installations at all — nobody has installed it yet. Install link: ${installUrl}`,
        `installation lookup for ${where}`,
      );
    }
    throw new GitHubAppApiError(
      404,
      `no installation covers ${where}; the app is installed on ${all.map((i) => i.account).join(", ")}. ` +
        `Install link: ${installUrl}`,
      `installation lookup for ${where}`,
    );
  }

  /**
   * Ordered triage for "I can't reach that repo" (the FIRST thing the troubleshooting playbook
   * runs). Distinguishes not-installed / repo-not-selected / no-such-owner, and is explicit about
   * the one case GitHub genuinely cannot disambiguate (a private repo that is either unselected or
   * nonexistent looks identical from outside the installation).
   */
  async diagnoseAccess(target: { owner: string; repo?: string }): Promise<AccessDiagnosis> {
    const owner = target.owner.trim();
    const full = target.repo ? (target.repo.includes("/") ? target.repo : `${owner}/${target.repo}`) : undefined;

    if (full) {
      const byRepo = await this.installationForRepo(full);
      if (byRepo) {
        return {
          status: "ok",
          owner,
          repo: full,
          installationId: byRepo.id,
          repositorySelection: byRepo.repositorySelection,
        };
      }
    }

    const byOwner = await this.installationForOwner(owner);
    const installUrl = await this.installUrl().catch(() => "https://github.com/apps");

    if (!byOwner) {
      // Not installed on that account — but first make sure the account exists at all.
      const exists = await this.ownerExists(owner);
      if (!exists) return { status: "no-such-owner", owner };
      return { status: "not-installed", owner, installUrl };
    }

    if (!full) {
      return {
        status: "ok",
        owner,
        installationId: byOwner.id,
        repositorySelection: byOwner.repositorySelection,
      };
    }

    // Installed on the account but the repo lookup 404'd. If the repo is publicly visible the
    // answer is unambiguous: it exists and simply isn't in the selection.
    const publiclyVisible = await this.repoIsPublic(full);
    return publiclyVisible
      ? { status: "repo-not-selected", owner, repo: full, installationId: byOwner.id, installUrl }
      : { status: "repo-not-selected-or-missing", owner, repo: full, installationId: byOwner.id, installUrl };
  }

  /**
   * Unauthenticated existence probe for a user/org login (a typo check, not an auth check).
   * Only a 404 counts as "doesn't exist" — an unauthenticated 403 (rate limit) must not make
   * the triage tell someone their own account is a typo.
   */
  private async ownerExists(owner: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.apiBase}/users/${owner}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "beckett" },
    });
    return res.status !== 404;
  }

  /** Unauthenticated existence probe for a repo — 200 only for public repos, which is the point. */
  private async repoIsPublic(repo: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.apiBase}/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "beckett" },
    });
    return res.ok;
  }
}

/** GitHub's own `message` for a failed response, falling back to the status text. */
async function githubMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === "string" && body.message) return body.message;
  } catch {
    /* non-JSON error body — fall through */
  }
  return res.statusText || "unknown error";
}

/**
 * The public install link. This is what Beckett hands a user who wants it working on their repos:
 * GitHub shows them the repo picker ("Only select repositories" vs "All repositories") and, for an
 * org, routes the request through the org's install approval.
 */
export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
