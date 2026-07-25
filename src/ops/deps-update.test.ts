/**
 * The weekly dependency-update job (issue #85). Every dependency is injected, so this suite proves
 * the HARD constraints — isolation, in-range-only, abort-before-publish, one line out — without a
 * network, a git repo, or a package manager anywhere near it.
 */

import { expect, test, describe } from "bun:test";
import {
  dependencyRanges,
  detectPackageManagers,
  findHeldBack,
  checkFailureDetail,
  parsePorcelainPaths,
  parsePrUrl,
  runDepsUpdate,
  satisfiesRange,
  type DepsUpdateDeps,
  type DepsUpdateRequest,
  type DepsUpdateStatus,
  type ExecResult,
} from "./deps-update.ts";
import { quietLogger } from "../cli/io.ts";

const LIVE_CHECKOUT = "/home/beckett/beckett";

const PACKAGE_JSON = JSON.stringify({
  dependencies: { betterwright: "1.1.3", zod: "^3.24.1", "smol-toml": "^1.3.1" },
  devDependencies: { typescript: "^5.7.2" },
});

function request(over: Partial<DepsUpdateRequest> = {}): DepsUpdateRequest {
  return {
    repo: "0xbeckett/beckett",
    base: "main",
    sourceRepo: LIVE_CHECKOUT,
    workRoot: "/tmp/deps-work",
    branch: "beckett/deps-update-2026-07-26",
    author: { name: "0xbeckett", email: "0xbeckett@users.noreply.github.com" },
    ...over,
  };
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

interface Harness {
  deps: DepsUpdateDeps;
  /** Every command run, as "cwd :: argv". */
  ran: string[];
  /** Every command run, with the argv and the env layered over it. */
  calls: Array<{ cmd: string[]; cwd: string; env?: Record<string, string> }>;
  /** Every `beckett …` invocation's argv. */
  beckettCalls: string[][];
  removed: string[];
}

/**
 * A fake world. `respond` overrides the result for the first command whose joined argv MATCHES a
 * key prefix; everything else succeeds silently. `lockfiles` are the files that "exist".
 */
function harness(opts: {
  lockfiles?: string[];
  respond?: Record<string, ExecResult>;
  statusPorcelain?: string;
  latest?: Record<string, string>;
} = {}): Harness {
  const ran: string[] = [];
  const calls: Array<{ cmd: string[]; cwd: string; env?: Record<string, string> }> = [];
  const beckettCalls: string[][] = [];
  const removed: string[] = [];
  const lockfiles = opts.lockfiles ?? ["bun.lock"];
  const status = opts.statusPorcelain ?? " M bun.lock\n";

  const deps: DepsUpdateDeps = {
    async exec(cmd, o) {
      const joined = cmd.join(" ");
      ran.push(`${o.cwd} :: ${joined}`);
      calls.push({ cmd, cwd: o.cwd, ...(o.env ? { env: o.env } : {}) });
      for (const [prefix, result] of Object.entries(opts.respond ?? {})) {
        if (joined.startsWith(prefix)) return result;
      }
      if (joined.startsWith("git status")) return { ...OK, stdout: status };
      if (joined.startsWith("git rev-parse")) return OK;
      if (joined.startsWith("git diff")) return { ...OK, stdout: " bun.lock | 12 +++---\n" };
      return OK;
    },
    async beckett(args) {
      beckettCalls.push(args);
      if (args.includes("pr")) {
        return { ...OK, stdout: JSON.stringify({ number: 91, url: "https://github.com/0xbeckett/beckett/pull/91" }) };
      }
      return OK;
    },
    async latestVersion(name) {
      return opts.latest?.[name] ?? null;
    },
    exists: (path) => lockfiles.some((lock) => path.endsWith(`/${lock}`)),
    readText: () => PACKAGE_JSON,
    removeDir: (path) => void removed.push(path),
    logger: quietLogger,
  };
  return { deps, ran, calls, beckettCalls, removed };
}

// ── manager detection ────────────────────────────────────────────────────────────────────────

describe("package-manager detection is driven by lockfiles present, never assumed", () => {
  test("bun.lock alone → bun only; npm and pnpm stay inert", () => {
    const found = detectPackageManagers("/repo", (p) => p === "/repo/bun.lock");
    expect(found.map((m) => m.id)).toEqual(["bun"]);
    expect(found[0]!.update).toEqual(["bun", "update"]);
  });

  test("package-lock.json alone → npm only", () => {
    expect(detectPackageManagers("/repo", (p) => p === "/repo/package-lock.json").map((m) => m.id))
      .toEqual(["npm"]);
  });

  test("pnpm-lock.yaml alone → pnpm only", () => {
    expect(detectPackageManagers("/repo", (p) => p === "/repo/pnpm-lock.yaml").map((m) => m.id))
      .toEqual(["pnpm"]);
  });

  test("bun.lockb (the older binary lockfile) still counts as bun", () => {
    expect(detectPackageManagers("/repo", (p) => p === "/repo/bun.lockb").map((m) => m.id))
      .toEqual(["bun"]);
  });

  test("npm-shrinkwrap.json counts as npm", () => {
    expect(detectPackageManagers("/repo", (p) => p === "/repo/npm-shrinkwrap.json").map((m) => m.id))
      .toEqual(["npm"]);
  });

  test("several lockfiles → several managers, in table order (element 0 runs the checks)", () => {
    const all = new Set(["/repo/package-lock.json", "/repo/bun.lock", "/repo/pnpm-lock.yaml"]);
    expect(detectPackageManagers("/repo", (p) => all.has(p)).map((m) => m.id))
      .toEqual(["npm", "bun", "pnpm"]);
  });

  test("no lockfile at all → nothing to run", () => {
    expect(detectPackageManagers("/repo", () => false)).toEqual([]);
  });

  test("no manager's update command ever asks for the LATEST version (that would jump majors)", () => {
    const all = detectPackageManagers("/repo", () => true);
    expect(all.length).toBe(3);
    for (const pm of all) {
      expect(pm.update).not.toContain("--latest");
      expect(pm.update).not.toContain("-L");
    }
  });
});

// ── in-range vs. held back ───────────────────────────────────────────────────────────────────

describe("satisfiesRange decides what counts as in-range", () => {
  test("caret pins the major (and the minor at 0.x, npm's rule)", () => {
    expect(satisfiesRange("^3.24.1", "3.25.0")).toBe(true);
    expect(satisfiesRange("^3.24.1", "3.24.0")).toBe(false); // below the floor
    expect(satisfiesRange("^3.24.1", "4.0.0")).toBe(false);
    expect(satisfiesRange("^0.2.3", "0.2.9")).toBe(true);
    expect(satisfiesRange("^0.2.3", "0.3.0")).toBe(false);
  });

  test("tilde pins the minor; an exact pin takes only itself", () => {
    expect(satisfiesRange("~1.2.3", "1.2.9")).toBe(true);
    expect(satisfiesRange("~1.2.3", "1.3.0")).toBe(false);
    expect(satisfiesRange("1.1.3", "1.1.3")).toBe(true);
    expect(satisfiesRange("1.1.3", "1.3.1")).toBe(false); // the betterwright case
  });

  test(">= takes anything newer", () => {
    expect(satisfiesRange(">=1.2.3", "9.9.9")).toBe(true);
    expect(satisfiesRange(">=1.2.3", "1.0.0")).toBe(false);
  });

  test("a range it cannot read returns null — never a guess", () => {
    expect(satisfiesRange("*", "1.0.0")).toBeNull();
    expect(satisfiesRange("workspace:*", "1.0.0")).toBeNull();
    expect(satisfiesRange("^1.2.3 || ^2.0.0", "2.1.0")).toBeNull();
    expect(satisfiesRange("github:foo/bar", "1.0.0")).toBeNull();
    expect(satisfiesRange("^1.2.3", "not-a-version")).toBeNull();
  });
});

describe("held-back reporting is 'available, not applied'", () => {
  test("a major jump and an outgrown exact pin are both reported, in-range bumps are not", async () => {
    const held = await findHeldBack(dependencyRanges(JSON.parse(PACKAGE_JSON)), async (name) =>
      ({
        betterwright: "1.3.1", // exact pin 1.1.3 → out of range, same major
        zod: "4.1.0",          // ^3.24.1 → a major jump
        "smol-toml": "1.7.0",  // ^1.3.1 → in range, applied by the update, NOT reported
        typescript: "5.9.3",   // ^5.7.2 → in range
      })[name] ?? null);

    expect(held.map((h) => `${h.name}:${h.reason}`)).toEqual([
      "betterwright:out-of-range",
      "zod:major",
    ]);
    expect(held[0]!.latest).toBe("1.3.1");
  });

  test("an unresolvable lookup is omitted, never guessed at", async () => {
    const held = await findHeldBack({ private_pkg: "1.0.0" }, async () => null);
    expect(held).toEqual([]);
  });

  test("a throwing lookup cannot fail the run", async () => {
    const held = await findHeldBack({ zod: "^3.0.0" }, async () => {
      throw new Error("registry down");
    });
    expect(held).toEqual([]);
  });

  test("dependencyRanges reads deps, devDeps and optionalDeps, ignoring non-string entries", () => {
    expect(dependencyRanges({
      dependencies: { a: "^1.0.0" },
      devDependencies: { b: "~2.0.0" },
      optionalDependencies: { c: "3.0.0" },
      overrides: { d: "9.9.9" },
      peerDependencies: { e: "^1.0.0" },
      scripts: { test: "bun test" },
    })).toEqual({ a: "^1.0.0", b: "~2.0.0", c: "3.0.0" });
    expect(dependencyRanges(null)).toEqual({});
  });
});

// ── the run: isolation, abort-before-publish, one line out ───────────────────────────────────

describe("the run never touches the live checkout", () => {
  test("the live path is only ever a clone SOURCE; every mutation runs inside the clone", async () => {
    const h = harness({ latest: { zod: "4.1.0" } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("opened");

    const clonePath = "/tmp/deps-work/beckett-deps-update-2026-07-26";
    for (const line of h.ran) {
      const [cwd, cmd] = line.split(" :: ");
      if (cmd!.startsWith("git clone")) {
        // The one command that names the live checkout — as an argument, reading it.
        expect(cmd).toContain(LIVE_CHECKOUT);
        continue;
      }
      // Everything else — update, checks, add, commit — runs with cwd INSIDE the clone.
      expect(cwd).toBe(clonePath);
    }
    // No command whatsoever runs with the live checkout as its working directory.
    expect(h.ran.some((line) => line.startsWith(`${LIVE_CHECKOUT} ::`))).toBe(false);
    // ...and the clone is disposable: removed before use and again on the way out.
    expect(h.removed.filter((p) => p === clonePath).length).toBe(2);
  });

  test("the clone is made with --no-hardlinks so it shares no objects with the live repo", async () => {
    const h = harness();
    await runDepsUpdate(request(), h.deps);
    const clone = h.ran.find((line) => line.includes("git clone"))!;
    expect(clone).toContain("--no-hardlinks");
  });

  test("the checks run with the ambient env — BECKETT_DIR is NOT overridden", async () => {
    const h = harness();
    await runDepsUpdate(request(), h.deps);
    const checks = h.calls.filter((c) => c.cmd.includes("run"));
    expect(checks.map((c) => c.cmd.join(" "))).toEqual(["bun run typecheck", "bun run test"]);
    // Pinning a deliberate REVERSAL: pointing BECKETT_DIR at a scratch dir looks like obvious
    // hardening, but it is the highest-precedence path override, so it also overrides the
    // `paths.beckett_dir` that 34 browser/config tests set for themselves — every one of them fails
    // and the routine aborts every week for a reason that has nothing to do with the update. If this
    // assertion is ever "fixed" by adding the override back, run the suite in a fresh clone first.
    expect(h.calls.some((c) => c.env)).toBe(false);
  });

  test("only the paths the UPDATE changed are staged, never a blanket `git add -A`", async () => {
    // The test suite drops junk in the tree; `git status` was captured before it ran.
    const h = harness({ statusPorcelain: ' M bun.lock\n M package.json\n?? "odd name.txt"\nR  a.ts -> b.ts\n' });
    await runDepsUpdate(request(), h.deps);
    const add = h.calls.find((c) => c.cmd[1] === "add")!;
    expect(add.cmd).toEqual(["git", "add", "--", "b.ts", "bun.lock", "odd name.txt", "package.json"]);
    expect(add.cmd).not.toContain("-A");
  });

  test("parsePorcelainPaths unquotes, takes a rename's NEW path, and dedupes", () => {
    expect(parsePorcelainPaths(' M bun.lock\n?? "odd name.txt"\nR  old.ts -> new.ts\n M bun.lock\n\n'))
      .toEqual(["bun.lock", "new.ts", "odd name.txt"]);
    expect(parsePorcelainPaths("")).toEqual([]);
  });

  test("the clone is removed even when the run blows up", async () => {
    const h = harness({ respond: { "git clone": { code: 128, stdout: "", stderr: "boom" } } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("error");
    expect(h.removed.length).toBeGreaterThanOrEqual(1);
    expect(h.beckettCalls).toEqual([]); // nothing published
  });
});

describe("a red PR is worse than no PR", () => {
  test("a failing typecheck aborts before ANY publish, and says which check failed", async () => {
    const h = harness({ respond: { "bun run typecheck": { code: 2, stdout: "", stderr: "src/x.ts(1,1): error TS1005" } } });
    const result = await runDepsUpdate(request(), h.deps);

    expect(result.status).toBe("checks-failed");
    expect(result.failedCheck).toBe("bun run typecheck");
    expect(result.prUrl).toBeNull();
    expect(h.beckettCalls).toEqual([]); // no push, no PR
    expect(h.ran.some((l) => l.includes(" commit -m"))).toBe(false);
    expect(result.summary).toContain("no PR");
    // The test suite is not even attempted once typecheck is red.
    expect(h.ran.some((l) => l.includes("bun run test"))).toBe(false);
  });

  test("the failure detail names the failure, not the log noise before it", () => {
    // Real shape: `bun test` opens with pages of application logging, so the FIRST lines say
    // nothing. This is the exact noise the first live rehearsal quoted.
    const noisy = [
      "$ bun test",
      '{"level":"info","component":"e2e-resume.driver.claude","msg":"spawning claude worker"}',
      '{"level":"info","component":"concierge.pool","msg":"evicted idle session"}',
      "(fail) routines > weekly fires once per ISO week",
      " 1600 pass",
      " 1 fail",
    ].join("\n");
    const detail = checkFailureDetail(noisy, "");
    expect(detail).toContain("(fail) routines > weekly fires once per ISO week");
    expect(detail).toContain("1 fail");
    expect(detail).not.toContain("spawning claude worker");
    expect(detail).not.toContain("\n");
  });

  test("with no failure lines to find, the detail falls back to the tail, not the head", () => {
    const detail = checkFailureDetail("line one\nline two\nline three\nthe last thing it said", "");
    expect(detail).toContain("the last thing it said");
    expect(detail).not.toContain("line one");
  });

  test("typecheck errors are named too, and empty output still says something", () => {
    expect(checkFailureDetail("src/x.ts(1,1): error TS2322: Type 'string' is not assignable", ""))
      .toContain("error TS2322");
    expect(checkFailureDetail("", "")).toBe("(the check failed but printed nothing)");
  });

  test("a failing test suite aborts the same way", async () => {
    const h = harness({ respond: { "bun run test": { code: 1, stdout: "3 fail", stderr: "" } } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("checks-failed");
    expect(result.failedCheck).toBe("bun run test");
    expect(h.beckettCalls).toEqual([]);
  });

  test("typecheck AND the test suite both run before anything is published", async () => {
    const h = harness();
    await runDepsUpdate(request(), h.deps);
    const commitAt = h.ran.findIndex((l) => l.includes(" commit -m"));
    expect(h.ran.findIndex((l) => l.includes("bun run typecheck"))).toBeLessThan(commitAt);
    expect(h.ran.findIndex((l) => l.includes("bun run test"))).toBeLessThan(commitAt);
  });

  test("a failed update command stops the run instead of publishing a half-update", async () => {
    const h = harness({ respond: { "bun update": { code: 1, stdout: "", stderr: "ETIMEDOUT" } } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("No PR");
    expect(h.beckettCalls).toEqual([]);
  });
});

describe("publishing goes through beckett gh — a PR, never main, never a deploy", () => {
  test("push the head branch, then open a PR against base", async () => {
    const h = harness();
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("opened");
    expect(result.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/91");

    // Exactly two GitHub calls, both `beckett gh` — no raw gh, no `git push` in the exec log.
    expect(h.beckettCalls.length).toBe(2);
    expect(h.beckettCalls.every((args) => args[0] === "gh")).toBe(true);
    expect(h.ran.some((l) => l.includes("git push"))).toBe(false);

    const [push, pr] = h.beckettCalls;
    expect(push!.slice(0, 2)).toEqual(["gh", "push"]);
    expect(push).toContain("beckett/deps-update-2026-07-26");
    expect(pr!.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    // main is the PR's BASE (its target), and the head is the update branch — never the reverse.
    expect(pr![pr!.indexOf("--base") + 1]).toBe("main");
    expect(pr![pr!.indexOf("--head") + 1]).toBe("beckett/deps-update-2026-07-26");
  });

  test("the base branch is never a push target and nothing ever deploys", async () => {
    const h = harness();
    await runDepsUpdate(request(), h.deps);
    for (const args of h.beckettCalls) {
      expect(args).not.toContain("deploy");
      expect(args).not.toContain("merge");
      // `gh push --branch main` would be the one way to write to main from here.
      if (args[1] === "push") expect(args[args.indexOf("--branch") + 1]).not.toBe("main");
    }
    expect(h.ran.some((l) => l.includes("deploy"))).toBe(false);
  });

  test("a push failure reports it and never leaves a dangling PR attempt", async () => {
    const ran: string[][] = [];
    const h = harness();
    const deps: DepsUpdateDeps = {
      ...h.deps,
      async beckett(args) {
        ran.push(args);
        return { code: 1, stdout: "", stderr: "remote: permission denied" };
      },
    };
    const result = await runDepsUpdate(request(), deps);
    expect(result.status).toBe("error");
    expect(ran.length).toBe(1); // stopped at the push; `pr create` never attempted
    expect(result.prUrl).toBeNull();
  });

  test("parsePrUrl reads the CLI's JSON, or a bare URL as a fallback", () => {
    expect(parsePrUrl(JSON.stringify({ number: 5, url: "https://github.com/o/r/pull/5" })))
      .toBe("https://github.com/o/r/pull/5");
    expect(parsePrUrl("opened https://github.com/o/r/pull/7\n")).toBe("https://github.com/o/r/pull/7");
    expect(parsePrUrl("nothing useful")).toBeNull();
  });
});

describe("the report is exactly one terse line, whatever happens", () => {
  const outcomes: Array<[DepsUpdateStatus, Harness]> = [
    ["opened", harness({ latest: { zod: "4.1.0", betterwright: "1.3.1" } })],
    ["no-changes", harness({ statusPorcelain: "" })],
    ["no-managers", harness({ lockfiles: [] })],
    ["checks-failed", harness({ respond: { "bun run test": { code: 1, stdout: "1 fail\nsecond line\n", stderr: "" } } })],
    ["error", harness({ respond: { "git clone": { code: 1, stdout: "", stderr: "no such\nrepo\n" } } })],
  ];

  for (const [expected, h] of outcomes) {
    test(`${expected}: one line, no newlines, and it says what happened`, async () => {
      const result = await runDepsUpdate(request(), h.deps);
      expect(result.status).toBe(expected);
      expect(result.summary).not.toContain("\n");
      expect(result.summary.startsWith("deps")).toBe(true);
      expect(result.summary.length).toBeGreaterThan(10);
    });
  }

  test("the success line carries the PR link and names what was held back", async () => {
    const h = harness({ latest: { zod: "4.1.0", betterwright: "1.3.1" } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.summary).toContain("https://github.com/0xbeckett/beckett/pull/91");
    expect(result.summary).toContain("bun");
    expect(result.summary).toContain("Held back for a human");
    expect(result.summary).toContain("zod ^3.24.1→4.1.0");
    expect(result.summary).toContain("betterwright 1.1.3→1.3.1");
    expect(result.summary).not.toContain("\n");
  });

  test("no lockfile → it says so and runs no package manager", async () => {
    const h = harness({ lockfiles: [] });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("no-managers");
    expect(result.managers).toEqual([]);
    expect(h.ran.some((l) => l.endsWith("update"))).toBe(false);
    expect(h.beckettCalls).toEqual([]);
  });

  test("nothing in range to update → no commit, no PR, still one line", async () => {
    const h = harness({ statusPorcelain: "", latest: { zod: "4.1.0" } });
    const result = await runDepsUpdate(request(), h.deps);
    expect(result.status).toBe("no-changes");
    expect(h.beckettCalls).toEqual([]);
    expect(h.ran.some((l) => l.includes(" commit -m"))).toBe(false);
    // Majors are still worth saying even when nothing moved — that IS the report.
    expect(result.summary).toContain("zod ^3.24.1→4.1.0");
  });
});

test("the commit is authored per-invocation, never by writing git config", async () => {
  const h = harness();
  await runDepsUpdate(request(), h.deps);
  const commit = h.ran.find((l) => l.includes(" commit -m"))!;
  expect(commit).toContain("user.name=0xbeckett");
  expect(commit).toContain("user.email=0xbeckett@users.noreply.github.com");
  expect(h.ran.some((l) => l.includes("git config"))).toBe(false);
});
