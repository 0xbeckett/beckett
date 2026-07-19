type GitHubIdentityConfig = { identity?: { github_user?: string } };
type GitHubEnv = Record<string, string | undefined>;

export interface GitHubTarget {
  /** Login authenticated by GITHUB_PAT. Organizations are not valid here. */
  account: string;
  /** Account or organization that owns Beckett-managed project repositories. */
  owner: string;
}

/** Resolve the credential identity and project owner without letting their fallbacks diverge. */
export function resolveGitHubTarget(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): GitHubTarget {
  const configuredAccount = config.identity?.github_user?.trim();
  const account = env.GITHUB_ACCOUNT?.trim() || configuredAccount;
  if (!account) {
    throw new Error(
      "GitHub account is not configured — set GITHUB_ACCOUNT or identity.github_user in config.toml",
    );
  }
  const owner = env.BECKETT_GH_ORG?.trim() || account;
  return { account, owner };
}

/** Resolve the login that GITHUB_PAT is expected to authenticate as. */
export function resolveGitHubAccount(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): string {
  return resolveGitHubTarget(config, env).account;
}

/** Resolve the GitHub account/org that owns Beckett-managed project repositories. */
export function resolveGitHubOwner(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): string {
  return resolveGitHubTarget(config, env).owner;
}
