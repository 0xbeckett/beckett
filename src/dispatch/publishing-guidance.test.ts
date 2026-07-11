import { describe, expect, test } from "bun:test";

import { validateConfig } from "../config.ts";
import { buildGitHubPublishingGuidance } from "./publishing-guidance.ts";

describe("worker GitHub publishing guidance", () => {
  test("names the configured project owner instead of the canonical account", () => {
    const guidance = buildGitHubPublishingGuidance(
      "balloons",
      validateConfig({ identity: { github_user: "octocat" } }),
      {},
    );

    expect(guidance).toContain("octocat/balloons");
    expect(guidance).toContain("octocat/beckett");
    expect(guidance).not.toContain("0xbeckett/");
  });

  test("honors BECKETT_GH_ORG ahead of the configured identity", () => {
    const guidance = buildGitHubPublishingGuidance(
      "balloons",
      validateConfig({ identity: { github_user: "octocat" } }),
      { BECKETT_GH_ORG: "acme-labs" },
    );

    expect(guidance).toContain("acme-labs/balloons");
  });

  test("uses GITHUB_ACCOUNT when there is no project-org override", () => {
    const guidance = buildGitHubPublishingGuidance(
      "balloons",
      validateConfig({ identity: { github_user: "octocat" } }),
      { GITHUB_ACCOUNT: "publisher-bot" },
    );

    expect(guidance).toContain("publisher-bot/balloons");
  });
});
