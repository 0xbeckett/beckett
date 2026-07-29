import { resolveProjectOwner, resolveSelfProjectOwner } from "../github/owner.ts";

/** The GitHub ownership contract injected into every implementation worker's system prompt. */
export function buildGitHubPublishingGuidance(
  slug: string,
  config: { identity?: { github_user?: string } },
  env: Record<string, string | undefined> = process.env,
): string {
  const owner = resolveProjectOwner(slug, config, env);
  const selfOwner = resolveSelfProjectOwner(env);
  return (
    `GITHUB: don't push anything yourself. When this ticket is done, Beckett automatically ` +
    `publishes this repo to \`${owner}/${slug}\` (a standalone PUBLIC repo, NOT tied to ` +
    `${selfOwner}/beckett). Just commit your work in this checkout — the push is handled for you.`
  );
}
