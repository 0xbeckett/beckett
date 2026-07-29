import { describe, expect, test } from "bun:test";

import {
  resolveGitHubAccount,
  resolveGitHubOwner,
  resolveGitHubTarget,
  resolveProjectOwner,
  resolveSelfProjectOwner,
} from "./owner.ts";

describe("resolveGitHubOwner", () => {
  test("prefers the explicit project-owner environment override", () => {
    expect(
      resolveGitHubOwner(
        { identity: { github_user: "octocat" } },
        { BECKETT_GH_ORG: " acme-labs ", GITHUB_ACCOUNT: "publisher-bot" },
      ),
    ).toBe("acme-labs");
  });

  test("uses the authenticated account as the project owner when no org override is set", () => {
    expect(
      resolveGitHubOwner(
        { identity: { github_user: "octocat" } },
        { GITHUB_ACCOUNT: " publisher-bot " },
      ),
    ).toBe("publisher-bot");
  });

  test("falls back to the configured GitHub identity", () => {
    expect(resolveGitHubOwner({ identity: { github_user: "octocat" } }, {})).toBe("octocat");
  });

  test("refuses to guess a maintainer account for partial configs", () => {
    expect(() => resolveGitHubOwner({}, {})).toThrow(
      "GitHub account is not configured — set GITHUB_ACCOUNT or identity.github_user in config.toml",
    );
    expect(() => resolveGitHubOwner({ identity: { github_user: "  " } }, { BECKETT_GH_ORG: " " })).toThrow(
      /set GITHUB_ACCOUNT or identity\.github_user/,
    );
  });

  test("keeps the authenticated account separate from an organization target", () => {
    const target = resolveGitHubTarget(
      { identity: { github_user: "octocat" } },
      { BECKETT_GH_ORG: "acme-labs", GITHUB_ACCOUNT: "publisher-bot" },
    );

    expect(target).toEqual({ account: "publisher-bot", owner: "acme-labs" });
    expect(
      resolveGitHubAccount(
        { identity: { github_user: "octocat" } },
        { BECKETT_GH_ORG: "acme-labs", GITHUB_ACCOUNT: "publisher-bot" },
      ),
    ).toBe("publisher-bot");
  });
});

describe("resolveProjectOwner", () => {
  const config = { identity: { github_user: "octocat" } };

  test("resolves the beckett self-project to kowo-co, not the default owner", () => {
    expect(resolveProjectOwner("beckett", config, { GITHUB_ACCOUNT: "publisher-bot" })).toBe("kowo-co");
    expect(resolveProjectOwner("  Beckett ", config, { GITHUB_ACCOUNT: "publisher-bot" })).toBe("kowo-co");
  });

  test("leaves every other project slug on the default owner", () => {
    expect(resolveProjectOwner("balloons", config, { GITHUB_ACCOUNT: "publisher-bot" })).toBe("publisher-bot");
    expect(resolveProjectOwner("balloons", config, { BECKETT_GH_ORG: "acme-labs" })).toBe("acme-labs");
    expect(resolveProjectOwner("balloons", config, {})).toBe("octocat");
  });

  test("honors BECKETT_SELF_PROJECT_OWNER and BECKETT_SELF_PROJECT overrides", () => {
    expect(
      resolveProjectOwner("beckett", config, { BECKETT_SELF_PROJECT_OWNER: "some-org" }),
    ).toBe("some-org");
    // A renamed self-project takes the self-owner; the literal "beckett" then falls through.
    expect(
      resolveProjectOwner("myself", config, { BECKETT_SELF_PROJECT: "myself", GITHUB_ACCOUNT: "publisher-bot" }),
    ).toBe("kowo-co");
    expect(
      resolveProjectOwner("beckett", config, { BECKETT_SELF_PROJECT: "myself", GITHUB_ACCOUNT: "publisher-bot" }),
    ).toBe("publisher-bot");
  });

  test("resolveSelfProjectOwner defaults to kowo-co and honors the env override", () => {
    expect(resolveSelfProjectOwner({})).toBe("kowo-co");
    expect(resolveSelfProjectOwner({ BECKETT_SELF_PROJECT_OWNER: " some-org " })).toBe("some-org");
  });
});
