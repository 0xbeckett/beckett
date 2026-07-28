/**
 * The proactive rot sweep (issue #79). Every dependency is injected, so this suite proves the HARD
 * constraints — opt-in-per-repo (nothing off the list is ever touched), at-most-one-PR-per-finding,
 * never-merge / never-force-push, and "a finding is a claim, not a guess" — without a network, a
 * GitHub token, or an advisory database anywhere near it.
 */

import { expect, test, describe } from "bun:test";
import {
  advisoryFixedVersion,
  classifyLink,
  dependencyRanges,
  extractReadmeLinks,
  failingChecks,
  findBrokenLinks,
  findDependencyRot,
  findingBranch,
  hasOpenFindingPr,
  rangeFloor,
  reportPath,
  runProactiveSweep,
  versionParts,
  PROACTIVE_LABEL,
  type CheckRun,
  type LinkProbe,
  type OpenPrParams,
  type PackageQuery,
  type ProactiveSweepDeps,
  type ProactiveSweepRequest,
  type RawAdvisory,
  type StatusContext,
} from "./proactive-sweep.ts";
import { quietLogger } from "../cli/io.ts";

// =======================================================================================
// Pure detectors
// =======================================================================================

describe("failingChecks", () => {
  test("reports only COMPLETED runs GitHub concluded failed", () => {
    const runs: CheckRun[] = [
      { name: "build", status: "completed", conclusion: "failure", html_url: "u1" },
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "flaky", status: "in_progress", conclusion: null },
      { name: "test", status: "completed", conclusion: "timed_out" },
      { name: "skipped-job", status: "completed", conclusion: "skipped" },
      { name: "neutral-job", status: "completed", conclusion: "neutral" },
    ];
    const failing = failingChecks(runs, []);
    expect(failing.map((c) => c.name).sort()).toEqual(["build", "test"]);
    expect(failing.find((c) => c.name === "build")!.url).toBe("u1");
  });

  test("folds in legacy commit statuses and de-dupes by name", () => {
    const statuses: StatusContext[] = [
      { context: "ci/circleci", state: "failure", target_url: "t1" },
      { context: "ci/pending", state: "pending" },
      { context: "build", state: "error" },
    ];
    const runs: CheckRun[] = [{ name: "build", status: "completed", conclusion: "failure" }];
    const failing = failingChecks(runs, statuses);
    // "build" appears in both surfaces but is reported once; pending is not a failure.
    expect(failing.map((c) => c.name).sort()).toEqual(["build", "ci/circleci"]);
  });

  test("green / still-running branch yields no findings", () => {
    expect(failingChecks([{ name: "x", status: "completed", conclusion: "success" }], [])).toEqual([]);
    expect(failingChecks([{ name: "x", status: "queued", conclusion: null }], [])).toEqual([]);
  });
});

describe("version + range helpers", () => {
  test("versionParts / rangeFloor parse real package.json shapes", () => {
    expect(versionParts("1.2.3")).toEqual([1, 2, 3]);
    expect(versionParts("not-a-version")).toBeNull();
    expect(rangeFloor("^3.24.1")).toBe("3.24.1");
    expect(rangeFloor("~1.0.0")).toBe("1.0.0");
    expect(rangeFloor("1.1.3")).toBe("1.1.3");
    expect(rangeFloor("*")).toBeNull();
    expect(rangeFloor("workspace:*")).toBeNull();
  });

  test("advisoryFixedVersion reads the first fixed event", () => {
    const adv: RawAdvisory = {
      affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "2.4.1" }] }] }],
    };
    expect(advisoryFixedVersion(adv)).toBe("2.4.1");
    expect(advisoryFixedVersion({})).toBeNull();
  });

  test("dependencyRanges spans all dependency blocks", () => {
    const ranges = dependencyRanges({
      dependencies: { a: "^1.0.0" },
      devDependencies: { b: "~2.0.0" },
      optionalDependencies: { c: "3.0.0" },
      peerDependencies: { d: "4.0.0" }, // not swept by an update verb → not included
    });
    expect(ranges).toEqual({ a: "^1.0.0", b: "~2.0.0", c: "3.0.0" });
  });
});

describe("findDependencyRot", () => {
  test("surfaces advisories at the floor and long-dead (>=2 majors behind) pins", async () => {
    const advisoriesFor = async (pkg: PackageQuery): Promise<RawAdvisory[]> =>
      pkg.name === "leftpad"
        ? [{ id: "GHSA-xxxx", summary: "bad things", references: [{ url: "https://advisory" }], affected: [{ ranges: [{ events: [{ fixed: "1.1.0" }] }] }] }]
        : [];
    const latestVersion = async (name: string): Promise<string | null> =>
      ({ leftpad: "1.0.5", ancient: "5.2.0", fresh: "1.4.0" })[name] ?? null;
    const { advisories, dead } = await findDependencyRot(
      { leftpad: "^1.0.0", ancient: "^3.1.0", fresh: "^1.2.0" },
      { advisoriesFor, latestVersion },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ name: "leftpad", version: "1.0.0", id: "GHSA-xxxx", fixed: "1.1.0" });
    // ancient: floor 3 vs latest 5 → 2 majors behind → dead. fresh: 0 behind → not dead.
    expect(dead.map((d) => d.name)).toEqual(["ancient"]);
    expect(dead[0]!.majorsBehind).toBe(2);
  });

  test("a lookup failure is swallowed — the report says less, never throws", async () => {
    const { advisories, dead } = await findDependencyRot(
      { a: "^1.0.0" },
      { advisoriesFor: async () => { throw new Error("network"); }, latestVersion: async () => { throw new Error("network"); } },
    );
    expect(advisories).toEqual([]);
    expect(dead).toEqual([]);
  });

  test("unparseable ranges are skipped, never guessed", async () => {
    let queried = 0;
    await findDependencyRot(
      { a: "workspace:*", b: "*" },
      { advisoriesFor: async () => (queried++, []), latestVersion: async () => null },
    );
    expect(queried).toBe(0);
  });
});

describe("README link extraction + classification", () => {
  test("extracts markdown, autolink, and bare forms, de-duped, skips relative/anchors", () => {
    const md = [
      "[docs](https://example.com/docs)",
      "[titled](https://example.com/x \"a title\")",
      "<https://autolink.dev>",
      "see https://bare.example.org/page.",
      "[rel](./local.md) and [anchor](#section) and <mailto:x@y.z>",
      "[dup](https://example.com/docs)",
    ].join("\n");
    const links = extractReadmeLinks(md);
    expect(links).toEqual([
      "https://example.com/docs",
      "https://example.com/x",
      "https://autolink.dev",
      "https://bare.example.org/page",
    ]);
  });

  test("classifyLink: dead on 4xx/5xx and transport errors, moved on permanent redirect, fine otherwise", () => {
    expect(classifyLink("u", { status: 404, location: null, error: null })!.reason).toBe("dead");
    expect(classifyLink("u", { status: 500, location: null, error: null })!.reason).toBe("dead");
    expect(classifyLink("u", { status: null, location: null, error: "ENOTFOUND" })!.reason).toBe("dead");
    expect(classifyLink("u", { status: 301, location: "https://new", error: null })).toMatchObject({
      reason: "moved",
      movedTo: "https://new",
    });
    expect(classifyLink("u", { status: 200, location: null, error: null })).toBeNull();
    expect(classifyLink("u", { status: 302, location: "https://tmp", error: null })).toBeNull(); // temporary → fine
    expect(classifyLink("u", { status: 429, location: null, error: null })).toBeNull(); // rate-limited → not the link's fault
  });

  test("findBrokenLinks probes, classifies, and orders dead-before-moved", async () => {
    const table: Record<string, LinkProbe> = {
      "https://ok.dev": { status: 200, location: null, error: null },
      "https://gone.dev": { status: 404, location: null, error: null },
      "https://moved.dev": { status: 301, location: "https://new.dev", error: null },
    };
    const md = "[a](https://ok.dev) [b](https://gone.dev) [c](https://moved.dev)";
    const { broken } = await findBrokenLinks(md, async (u) => table[u]!);
    expect(broken.map((b) => b.reason)).toEqual(["dead", "moved"]);
    expect(broken[0]!.url).toBe("https://gone.dev");
  });
});

describe("branch + idempotency helpers", () => {
  test("findingBranch is day-stamped and reportPath is out-of-source", () => {
    expect(findingBranch("ci", "2026-07-28")).toBe("beckett/proactive/ci-2026-07-28");
    expect(reportPath("dependencies")).toBe(".beckett/proactive/dependencies.md");
  });

  test("hasOpenFindingPr matches the kind's branch prefix only", () => {
    const heads = ["beckett/proactive/ci-2026-07-01", "feature/x"];
    expect(hasOpenFindingPr(heads, "ci")).toBe(true);
    expect(hasOpenFindingPr(heads, "dependencies")).toBe(false);
    expect(hasOpenFindingPr(heads, "readme-links")).toBe(false);
  });
});

// =======================================================================================
// Orchestration — the whole run against a fake GitHub
// =======================================================================================

interface RepoFixture {
  defaultBranch?: string | null;
  checkRuns?: CheckRun[];
  statuses?: StatusContext[];
  files?: Record<string, string>;
  openPrHeads?: string[];
  advisories?: Record<string, RawAdvisory[]>;
  latest?: Record<string, string>;
  probes?: Record<string, LinkProbe>;
}

interface Harness {
  deps: ProactiveSweepDeps;
  reposRead: string[];
  createdBranches: Array<{ repo: string; branch: string; sha: string }>;
  putFiles: Array<{ repo: string; branch: string; path: string }>;
  openedPrs: Array<{ repo: string; params: OpenPrParams }>;
  /** Every GitHub-mutating method name that fired — proves no merge/force path exists. */
  mutations: string[];
}

function harness(fixtures: Record<string, RepoFixture>): Harness {
  const reposRead: string[] = [];
  const createdBranches: Harness["createdBranches"] = [];
  const putFiles: Harness["putFiles"] = [];
  const openedPrs: Harness["openedPrs"] = [];
  const mutations: string[] = [];
  let prNumber = 100;

  const fx = (repo: string): RepoFixture | undefined => fixtures[repo];

  const deps: ProactiveSweepDeps = {
    async defaultBranch(repo) {
      reposRead.push(repo);
      const f = fx(repo);
      if (!f) throw new Error(`test: repo ${repo} was touched but has no fixture — opt-in leak!`);
      return f.defaultBranch === undefined ? "main" : f.defaultBranch;
    },
    async branchSha(repo) {
      return `sha-${repo}`;
    },
    async branchChecks(repo) {
      const f = fx(repo)!;
      return { checkRuns: f.checkRuns ?? [], statuses: f.statuses ?? [] };
    },
    async fileAt(repo, _ref, path) {
      return fx(repo)!.files?.[path] ?? null;
    },
    async openPrHeads(repo) {
      return fx(repo)!.openPrHeads ?? [];
    },
    async createBranch(repo, branch, sha) {
      mutations.push("createBranch");
      createdBranches.push({ repo, branch, sha });
    },
    async putFile(repo, branch, path) {
      mutations.push("putFile");
      putFiles.push({ repo, branch, path });
    },
    async openPr(repo, params) {
      mutations.push("openPr");
      openedPrs.push({ repo, params });
      return { number: prNumber, url: `https://github.com/${repo}/pull/${prNumber++}` };
    },
    async advisoriesFor(pkg: PackageQuery) {
      for (const f of Object.values(fixtures)) if (f.advisories?.[pkg.name]) return f.advisories[pkg.name]!;
      return [];
    },
    async latestVersion(name) {
      // latest is per-run, not per-repo, in these fixtures — read from whichever repo declares it.
      for (const f of Object.values(fixtures)) if (f.latest?.[name]) return f.latest[name]!;
      return null;
    },
    async probeLink(url) {
      for (const f of Object.values(fixtures)) if (f.probes?.[url]) return f.probes[url]!;
      return { status: 200, location: null, error: null };
    },
    logger: quietLogger,
  };
  return { deps, reposRead, createdBranches, putFiles, openedPrs, mutations };
}

function request(over: Partial<ProactiveSweepRequest> = {}): ProactiveSweepRequest {
  return {
    repos: [],
    author: { name: "0xbeckett", email: "0xbeckett@users.noreply.github.com" },
    dateStamp: "2026-07-28",
    ...over,
  };
}

describe("runProactiveSweep — opt-in gating", () => {
  test("an empty repo list sweeps NOTHING and touches no GitHub API", async () => {
    const h = harness({});
    const result = await runProactiveSweep(request({ repos: [] }), h.deps);
    expect(result.status).toBe("no-repos");
    expect(result.opened).toBe(0);
    expect(h.reposRead).toEqual([]);
    expect(h.mutations).toEqual([]);
  });

  test("only repos ON the list are ever read — nothing off it is touched", async () => {
    const h = harness({ "me/on-list": { checkRuns: [] } });
    await runProactiveSweep(request({ repos: ["me/on-list"] }), h.deps);
    // The fake throws if a repo without a fixture is read; reaching here proves no leak.
    expect(new Set(h.reposRead)).toEqual(new Set(["me/on-list"]));
  });

  test("whitespace / duplicates in the list are cleaned, not swept twice", async () => {
    const h = harness({ "me/repo": { checkRuns: [] } });
    await runProactiveSweep(request({ repos: [" me/repo ", "me/repo", "  "] }), h.deps);
    expect(h.reposRead).toEqual(["me/repo"]);
  });
});

describe("runProactiveSweep — findings become PRs", () => {
  test("red CI opens one proactive-labelled PR against the default branch", async () => {
    const h = harness({
      "me/app": { checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }] },
    });
    const result = await runProactiveSweep(request({ repos: ["me/app"] }), h.deps);
    expect(result.status).toBe("opened");
    expect(result.opened).toBe(1);
    expect(h.openedPrs).toHaveLength(1);
    const pr = h.openedPrs[0]!;
    expect(pr.params.labels).toEqual([PROACTIVE_LABEL]);
    expect(pr.params.base).toBe("main");
    expect(pr.params.head).toBe("beckett/proactive/ci-2026-07-28");
    expect(pr.params.body).toContain("CI is red");
    // The only file the PR touches is the out-of-source report.
    expect(h.putFiles[0]!.path).toBe(".beckett/proactive/ci.md");
  });

  test("dependency advisories + dead pins open one PR describing the rot and fix", async () => {
    const h = harness({
      "me/lib": {
        checkRuns: [],
        files: { "package.json": JSON.stringify({ dependencies: { leftpad: "^1.0.0", ancient: "^3.0.0" } }) },
        advisories: { leftpad: [{ id: "GHSA-1", summary: "rce", affected: [{ ranges: [{ events: [{ fixed: "1.1.0" }] }] }] }] },
        latest: { leftpad: "1.0.9", ancient: "6.0.0" },
      },
    });
    const result = await runProactiveSweep(request({ repos: ["me/lib"] }), h.deps);
    expect(result.opened).toBe(1);
    const pr = h.openedPrs[0]!;
    expect(pr.params.head).toBe("beckett/proactive/dependencies-2026-07-28");
    expect(pr.params.body).toContain("GHSA-1");
    expect(pr.params.body).toContain("fixed in `1.1.0`");
    expect(pr.params.body).toContain("ancient"); // the long-dead pin
    expect(pr.params.labels).toEqual([PROACTIVE_LABEL]);
  });

  test("broken README links open one PR; permanent-redirect-only READMEs do NOT", async () => {
    const broken = harness({
      "me/site": {
        checkRuns: [],
        files: { "README.md": "[gone](https://gone.dev) [ok](https://ok.dev)" },
        probes: { "https://gone.dev": { status: 404, location: null, error: null }, "https://ok.dev": { status: 200, location: null, error: null } },
      },
    });
    const r1 = await runProactiveSweep(request({ repos: ["me/site"] }), broken.deps);
    expect(r1.opened).toBe(1);
    expect(broken.openedPrs[0]!.params.head).toBe("beckett/proactive/readme-links-2026-07-28");

    const movedOnly = harness({
      "me/site": {
        checkRuns: [],
        files: { "README.md": "[moved](https://moved.dev)" },
        probes: { "https://moved.dev": { status: 301, location: "https://new.dev", error: null } },
      },
    });
    const r2 = await runProactiveSweep(request({ repos: ["me/site"] }), movedOnly.deps);
    expect(r2.opened).toBe(0); // a moved link alone is not rot worth a PR
    expect(r2.status).toBe("clean");
  });

  test("a repo with all three kinds of rot opens exactly three PRs — one per finding", async () => {
    const h = harness({
      "me/rotten": {
        checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }],
        files: {
          "package.json": JSON.stringify({ dependencies: { old: "^1.0.0" } }),
          "README.md": "[dead](https://dead.dev)",
        },
        latest: { old: "9.0.0" },
        probes: { "https://dead.dev": { status: 404, location: null, error: null } },
      },
    });
    const result = await runProactiveSweep(request({ repos: ["me/rotten"] }), h.deps);
    expect(result.opened).toBe(3);
    expect(h.openedPrs.map((p) => p.params.head).sort()).toEqual([
      "beckett/proactive/ci-2026-07-28",
      "beckett/proactive/dependencies-2026-07-28",
      "beckett/proactive/readme-links-2026-07-28",
    ]);
    // Every PR is labelled proactive.
    expect(h.openedPrs.every((p) => p.params.labels.includes(PROACTIVE_LABEL))).toBe(true);
  });
});

describe("runProactiveSweep — at most one PR, and the safety rails", () => {
  test("an already-open proactive PR for a finding is NOT re-filed", async () => {
    const h = harness({
      "me/app": {
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        openPrHeads: ["beckett/proactive/ci-2026-07-01"], // an earlier day's proactive CI PR, still open
      },
    });
    const result = await runProactiveSweep(request({ repos: ["me/app"] }), h.deps);
    expect(result.opened).toBe(0);
    expect(h.openedPrs).toHaveLength(0);
    expect(h.createdBranches).toHaveLength(0); // gated BEFORE any branch/commit
    const ci = result.repos[0]!.findings.find((f) => f.kind === "ci")!;
    expect(ci.status).toBe("already-open");
  });

  test("a clean repo opens no PRs", async () => {
    const h = harness({
      "me/pristine": {
        checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
        files: { "package.json": JSON.stringify({ dependencies: { fine: "^1.0.0" } }), "README.md": "[ok](https://ok.dev)" },
        latest: { fine: "1.0.1" },
        probes: { "https://ok.dev": { status: 200, location: null, error: null } },
      },
    });
    const result = await runProactiveSweep(request({ repos: ["me/pristine"] }), h.deps);
    expect(result.status).toBe("clean");
    expect(result.opened).toBe(0);
    expect(h.mutations).toEqual([]);
  });

  test("the ONLY GitHub writes are createBranch / putFile / openPr — no merge, no force path exists", async () => {
    const h = harness({
      "me/app": { checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }] },
    });
    await runProactiveSweep(request({ repos: ["me/app"] }), h.deps);
    // The injected surface has no merge/force method at all; the mutations that DID fire are only
    // the three non-destructive ones, in order.
    expect(h.mutations).toEqual(["createBranch", "putFile", "openPr"]);
    expect(Object.keys(h.deps)).not.toContain("mergePr");
  });

  test("an unreadable repo is reported, not thrown, and doesn't stop the rest", async () => {
    const h = harness({
      "me/missing": { defaultBranch: null },
      "me/ok": { checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }] },
    });
    const result = await runProactiveSweep(request({ repos: ["me/missing", "me/ok"] }), h.deps);
    expect(result.repos.find((r) => r.repo === "me/missing")!.error).toContain("could not read");
    expect(result.opened).toBe(1); // me/ok still swept
    expect(result.status).toBe("partial");
  });
});
