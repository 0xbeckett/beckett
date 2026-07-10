/**
 * Coverage for the hardened GitHub publish path (`GitHubCli.ensurePublished`) — the decision tree
 * that replaced the non-idempotent `gh repo create --remote origin` that stranded OPS-28 (cloned
 * checkout already had an `origin` → publish threw → ticket was already "done" → work never shipped).
 * The subprocess runner is injected, so every branch + its idempotency is exercised without touching
 * live GitHub. Each fake matches on argv and returns canned `gh`/`git` output.
 */

import { expect, test } from "bun:test";
import { GitHubCli, parseRepoNwo } from "./index.ts";
import type { Logger } from "../types.ts";

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLog;
  },
} as unknown as Logger;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
type FakeRun = (cmd: string[], opts?: { cwd?: string }) => Promise<RunResult>;

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): RunResult => ({ code, stdout: "", stderr });

/** Build a GitHubCli whose subprocess runner is `route`, recording every argv it sees. */
function cli(route: (joined: string, cmd: string[]) => RunResult | undefined) {
  const calls: string[] = [];
  const run: FakeRun = async (cmd) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    return route(joined, cmd) ?? fail(`unrouted: ${joined}`);
  };
  const gh = new GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/src",
    logger: noopLog,
    run: run as never,
  });
  return { gh, calls };
}

test("parseRepoNwo handles https, ssh, bare, and rejects junk", () => {
  expect(parseRepoNwo("https://github.com/owner/repo.git")).toBe("owner/repo");
  expect(parseRepoNwo("https://github.com/owner/repo")).toBe("owner/repo");
  expect(parseRepoNwo("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(parseRepoNwo("owner/repo")).toBe("owner/repo");
  expect(parseRepoNwo("not-a-repo")).toBeNull();
  expect(parseRepoNwo("")).toBeNull();
});

test("case 3 — fresh owned project (no origin, repo absent): create empty, then push HEAD→main", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin"); // fresh
    if (j.startsWith("gh repo view 0xbeckett/balloons")) return fail("404"); // repoExists → no
    if (j.startsWith("gh repo create")) return ok("https://github.com/0xbeckett/balloons\n");
    if (j.startsWith("git ls-files")) return ok(""); // no tracked scaffolding to strip
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "balloons", sourceDir: "/src", description: "d", ticket: "OPS-9" });
  expect(r.kind).toBe("pushed");
  expect(r.url).toContain("0xbeckett/balloons");
  // Repo created WITHOUT --source/--push (branch-name-agnostic), then HEAD pushed to `main` by name
  // — so a worktree on `beckett/<ticket>` still yields a `main`-default repo, not a weirdly-named one.
  const create = calls.find((c) => c.startsWith("gh repo create"))!;
  expect(create).not.toContain("--push");
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false); // fresh project → no PR
});

test("case 2 — repo we already own: integrate remote (fetch+rebase) then push HEAD→default branch", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok(); // remote tip present
    if (j.startsWith("git rebase")) return ok(); // clean rebase
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(r.kind).toBe("pushed"); // owned repos ship straight to main
  // Fetched + rebased the remote tip FIRST (fixes the OPS-25/27 non-fast-forward reject), then pushed main.
  expect(calls.some((c) => c.startsWith("git fetch"))).toBe(true);
  expect(calls.some((c) => c.startsWith("git rebase FETCH_HEAD"))).toBe(true);
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false); // owned repo → no PR
});

test("case 2 — a rebase CONFLICT aborts and throws (dispatcher then holds the ticket, no force-push)", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase --abort")) return ok();
    if (j.startsWith("git rebase")) return fail("CONFLICT (content): merge conflict in x");
    if (j.startsWith("git push")) return ok("SHOULD-NOT-PUSH");
    return undefined;
  });
  await expect(gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })).rejects.toThrow(
    /needs a human/,
  );
  expect(calls.some((c) => c.startsWith("git rebase --abort"))).toBe(true);
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false); // never force over a conflict
});

test("case 1 — cloned third-party upstream: fork → push to fork → PR to upstream", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo fork")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json name")) return ok('{"name":"probabilities"}'); // fork ready
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/SSHdotCodes/probabilities/pull/7\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.kind).toBe("pr");
  expect(r.nameWithOwner).toBe("SSHdotCodes/probabilities");
  expect(r.prUrl).toContain("/pull/7");
  expect(calls.some((c) => c.startsWith("gh repo fork SSHdotCodes/probabilities"))).toBe(true);
  // PR is opened against the UPSTREAM with a cross-fork head (0xbeckett:beckett/ops-28).
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("--repo SSHdotCodes/probabilities");
  expect(create).toContain("0xbeckett:beckett/ops-28");
});

test("idempotent (upstream PR) — an already-open PR is reused, gh pr create is NOT called again", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo fork")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json name")) return ok('{"name":"probabilities"}');
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok('[{"number":99,"url":"https://github.com/SSHdotCodes/probabilities/pull/99"}]');
    if (j.startsWith("gh pr create")) return ok("SHOULD-NOT-BE-CALLED");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.prUrl).toContain("/pull/99");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  // The check happens before fork/push/create, so an outbox replay does not race into another PR.
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
  expect(calls.some((c) => c.startsWith("gh repo fork"))).toBe(false);
});
