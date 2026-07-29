/**
 * Beckett — child environment builder (`src/env.ts`)
 * =======================================================================================
 * ONE place that decides what a spawned harness child may see (issue #19 — this rule was
 * hand-copied six times across the tree, each copy stripping only two exact keys).
 *
 * Subscription auth ONLY (Spec 00 §4): Beckett drives `claude`/`codex`/`pi` through their
 * `~/.claude` / `~/.codex` / `~/.pi` logins, never an API key. Stripping by PREFIX closes the
 * holes the exact-key copies left open: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 * `OPENAI_ORG_ID`, … would all silently redirect a child onto API billing or a foreign
 * endpoint. Harmless, needed vars that share a prefix go on the explicit allowlist.
 *
 * The ONE allowlisted exception is `ANTHROPIC_OAUTH_TOKEN` (#127). It is NOT an API key —
 * it is the Anthropic *subscription* OAuth token (sk-ant-oat0…), i.e. exactly the
 * subscription auth this rule exists to PRESERVE, and pi 0.82.1 consumes it natively for
 * `--provider anthropic`. Stripping it forced the pi+claude cast defaults (#85.1) to
 * silently substitute back to the claude harness. The other two `ANTHROPIC_` credential
 * vars stay forbidden because they are the two things the guard is for:
 * `ANTHROPIC_AUTH_TOKEN` is a per-token API key (redirects onto API billing) and
 * `ANTHROPIC_BASE_URL` is an endpoint override (redirects onto a foreign endpoint).
 */

/** Env-var prefixes a harness child must never inherit (API auth / endpoint overrides). */
const FORBIDDEN_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_", "CLAUDE_CODE_"] as const;

/**
 * Prefix-matched vars that are explicitly safe to pass through. `ANTHROPIC_OAUTH_TOKEN` is
 * the subscription OAuth token (not an API key) that pi needs for `--provider anthropic`;
 * see the header for why this single key is allowed while the other `ANTHROPIC_` creds are not.
 */
const ALLOWED_ENV_KEYS = new Set<string>(["ANTHROPIC_OAUTH_TOKEN"]);

/** True when a child env must not inherit `key` (subscription-auth-only rule). */
export function isForbiddenEnvKey(key: string): boolean {
  if (ALLOWED_ENV_KEYS.has(key)) return false;
  return FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build a harness child's environment from the daemon's, with API-auth/endpoint overrides
 * stripped. `extra` lets a driver layer its own vars (e.g. pi's PATH prefix) on top.
 */
export function childEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isForbiddenEnvKey(k)) env[k] = v;
  }
  return { ...env, ...extra };
}
