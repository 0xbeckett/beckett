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
    // The contrast clause names Beckett's own repo, which lives under its self-project owner (#114).
    expect(guidance).toContain("kowo-co/beckett");
    expect(guidance).not.toContain("0xbeckett/");
  });

  test("resolves the beckett self-project to its moved owner, not the default", () => {
    const guidance = buildGitHubPublishingGuidance(
      "beckett",
      validateConfig({ identity: { github_user: "octocat" } }),
      {},
    );

    expect(guidance).toContain("kowo-co/beckett");
    expect(guidance).not.toContain("octocat/beckett");
  });

  test("honors BECKETT_SELF_PROJECT_OWNER for the self-project", () => {
    const guidance = buildGitHubPublishingGuidance(
      "beckett",
      validateConfig({ identity: { github_user: "octocat" } }),
      { BECKETT_SELF_PROJECT_OWNER: "some-org" },
    );

    expect(guidance).toContain("some-org/beckett");
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
