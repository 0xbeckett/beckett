import { describe, expect, test } from "bun:test";

import { resolveGitHubAccount, resolveGitHubOwner, resolveGitHubTarget } from "./owner.ts";

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

  test("preserves the legacy canonical owner for partial configs", () => {
    expect(resolveGitHubOwner({}, {})).toBe("0xbeckett");
    expect(resolveGitHubOwner({ identity: { github_user: "  " } }, { BECKETT_GH_ORG: " " })).toBe(
      "0xbeckett",
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
