import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validateConfig } from "../config.ts";
import { renderDoctrine } from "./index.ts";

const doctrineTemplate = readFileSync(join(import.meta.dir, "concierge.md"), "utf8");

/**
 * The prompt is a CORPUS now, not a file: a small always-loaded index (`concierge.md`) plus one
 * playbook per procedure, read when its trigger fires (#128). The placeholder guarantee has to
 * hold across all of it — `{{github_owner}}` mostly lives in the playbooks now, so asserting
 * against the index alone would pass by simply no longer containing the thing under test.
 */
const playbooksDir = join(import.meta.dir, "playbooks");
const promptCorpus = [
  doctrineTemplate,
  ...readdirSync(playbooksDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(playbooksDir, f), "utf8")),
].join("\n");

describe("concierge doctrine instance rendering", () => {
  test("renders every project repository under the configured GitHub identity", () => {
    const rendered = renderDoctrine(
      promptCorpus,
      validateConfig({ identity: { github_user: "octocat" } }),
      {},
    );

    expect(promptCorpus).toContain("{{github_owner}}/balloons");
    expect(rendered).toContain("octocat/balloons");
    expect(rendered).toContain("octocat/beckett");
    expect(rendered).not.toContain("{{github_owner}}");
    expect(rendered).not.toContain("0xbeckett/");
  });

  test("the index cites only playbook paths that exist, and leaves no placeholder unrendered", () => {
    // A dangling pointer is the one failure this architecture must not have: the model reports the
    // file missing and then proceeds from memory, which is exactly what the index exists to stop.
    const rendered = renderDoctrine(doctrineTemplate, validateConfig({ identity: { github_user: "octocat" } }), {});
    expect(rendered).not.toMatch(/\{\{[a-z_]+\}\}/);
    const cited = [...rendered.matchAll(/`(\/[^`]+\.md)`/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(10);
    expect(cited.filter((p) => !existsSync(p))).toEqual([]);
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
