import { resolveGitHubOwner } from "../github/owner.ts";

/** The GitHub ownership contract injected into every implementation worker's system prompt. */
export function buildGitHubPublishingGuidance(
  slug: string,
  config: { identity?: { github_user?: string } },
  env: Record<string, string | undefined> = process.env,
): string {
  const owner = resolveGitHubOwner(config, env);
  return (
    `GITHUB: don't push anything yourself. When this ticket is done, Beckett automatically ` +
    `publishes this repo to \`${owner}/${slug}\` (a standalone PUBLIC repo, NOT tied to ` +
    `${owner}/beckett). Just commit your work in this checkout — the push is handled for you.`
  );
}
