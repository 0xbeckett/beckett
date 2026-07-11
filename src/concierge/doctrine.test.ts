import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateConfig } from "../config.ts";
import { renderDoctrine } from "./index.ts";

const doctrineTemplate = readFileSync(join(import.meta.dir, "concierge.md"), "utf8");

describe("concierge doctrine instance rendering", () => {
  test("renders every project repository under the configured GitHub identity", () => {
    const rendered = renderDoctrine(
      doctrineTemplate,
      validateConfig({ identity: { github_user: "octocat" } }),
      {},
    );

    expect(doctrineTemplate).toContain("{{github_owner}}/balloons");
    expect(rendered).toContain("octocat/balloons");
    expect(rendered).toContain("octocat/beckett");
    expect(rendered).not.toContain("{{github_owner}}");
    expect(rendered).not.toContain("0xbeckett/");
  });

  test("uses BECKETT_GH_ORG ahead of the configured user", () => {
    const rendered = renderDoctrine(
      "publish to {{github_owner}}/demo",
      validateConfig({ identity: { github_user: "octocat" } }),
      { BECKETT_GH_ORG: "acme-labs" },
    );

    expect(rendered).toBe("publish to acme-labs/demo");
  });
});
