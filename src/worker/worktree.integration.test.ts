/**
 * v3.2 worktrees — proof against REAL git (no mocks) that the per-ticket worktree path works end
 * to end: a tree cut from a freshly-fetched `origin/main`, nested under `.beckett/worktrees/<id>`
 * (and hidden from the parent's `git add -A`), a correct review-diff base, a branch that carries
 * the ticket's commits for publish, reuse across stages, best-effort fetch, and teardown. The
 * dispatcher fakes these ops in its unit tests, so this file is the only thing that exercises the
 * real git behavior the live daemon depends on.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
  fetchRemote,
  headSha,
  readDiff,
  excludeFromGit,
  SCAFFOLDING_DIR,
} from "./worktree.ts";

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout };
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await run(["init", "-b", "main"], dir);
  await run(["config", "user.email", "beckett@test"], dir);
  await run(["config", "user.name", "Beckett"], dir);
  await run(["config", "commit.gpgsign", "false"], dir);
}

let root: string; // holds a bare "origin" + the local clone that stands in for ~/Projects/<slug>
let repo: string;

/** A project repo cloned from a bare origin, shaped like a provisioned `~/Projects/<slug>`. */
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "beckett-wt-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  repo = join(root, "clone");

  // Seed an origin with one commit on main.
  await initRepo(seed);
  writeFileSync(join(seed, "base.txt"), "base\n");
  await run(["add", "-A"], seed);
  await run(["commit", "-m", "base on main"], seed);
  await run(["init", "--bare", "-b", "main", origin], root);
  await run(["remote", "add", "origin", origin], seed);
  await run(["push", "origin", "main"], seed);

  // Clone it → the project repo the dispatcher would provision.
  await run(["clone", origin, repo], root);
  await run(["config", "user.email", "beckett@test"], repo);
  await run(["config", "user.name", "Beckett"], repo);
  await run(["config", "commit.gpgsign", "false"], repo);
  await excludeFromGit(repo, [`${SCAFFOLDING_DIR}/`]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const wtPath = (id: string) => join(repo, SCAFFOLDING_DIR, "worktrees", id);

describe("worktree lifecycle (real git)", () => {
  test("creates a worktree on beckett/<ticket> off origin/main, nested under .beckett", async () => {
    const ws = wtPath("t1");
    const handle = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });

    expect(handle.workspace).toBe(ws);
    expect(existsSync(ws)).toBe(true);
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], ws)).stdout.trim()).toBe("beckett/t1");
    // Branched from origin/main, not a HEAD-fallback that would mask a broken fetch.
    const wtBase = (await run(["rev-parse", "HEAD"], ws)).stdout.trim();
    const originMain = (await run(["rev-parse", "origin/main"], repo)).stdout.trim();
    expect(wtBase).toBe(originMain);
  });

  test("the nested worktree is hidden from the parent repo's git add -A", async () => {
    await createWorktree({ repoRoot: repo, workspace: wtPath("t1"), branch: "beckett/t1", baseRef: "origin/main" });
    writeFileSync(join(repo, "real.txt"), "parent work\n");
    await run(["add", "-A"], repo);
    const staged = (await run(["diff", "--cached", "--name-only"], repo)).stdout;
    expect(staged).toContain("real.txt");
    expect(staged).not.toContain(SCAFFOLDING_DIR); // the worktree dir never leaks into the parent index
  });

  test("review diff base: work committed in the worktree shows against its base sha (publish payload)", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main" });
    const base = await headSha(ws); // captured before any work — the review diff base
    expect(base).toBeTruthy();

    writeFileSync(join(ws, "feature.ts"), "export const shipped = true;\n");
    await run(["add", "-A"], ws);
    await run(["commit", "-m", "beckett: t1 implement"], ws);

    // What a reviewer sees, and what publish would push on beckett/t1: exactly the ticket's work.
    const diff = await readDiff(ws, base!);
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("shipped");
    // The branch tip is the ticket's commit on top of the fetched base → a clean push/rebase.
    expect((await run(["rev-list", "--count", `${base}..HEAD`], ws)).stdout.trim()).toBe("1");
  });

  test("reuseIfExists returns the SAME tree across stages (implement → review), keeping its work", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });
    writeFileSync(join(ws, "wip.txt"), "in progress\n");

    // A later stage re-allocates: must NOT wipe the tree or re-cut from main.
    const again = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });
    expect(again.workspace).toBe(ws);
    expect(existsSync(join(ws, "wip.txt"))).toBe(true);
  });

  test("removeWorktree tears the tree down and deregisters it", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main" });
    expect(existsSync(ws)).toBe(true);

    await removeWorktree(repo, ws);
    expect(existsSync(ws)).toBe(false);
    const list = (await run(["worktree", "list"], repo)).stdout;
    expect(list).not.toContain(ws);
  });

  test("fetchRemote succeeds on a real origin and is a no-op (not a throw) with none", async () => {
    expect(await fetchRemote(repo)).toBe(true); // has origin
    const noRemote = mkdtempSync(join(tmpdir(), "beckett-noremote-"));
    try {
      await initRepo(noRemote);
      expect(await fetchRemote(noRemote)).toBe(false); // best-effort, never throws
    } finally {
      rmSync(noRemote, { recursive: true, force: true });
    }
  });

  test("falls back to HEAD when the base ref is absent (offline / private, fetch got nothing)", async () => {
    const ws = wtPath("t1");
    // No such ref — createWorktree must not throw; it branches from local HEAD instead.
    const handle = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/does-not-exist" });
    expect(existsSync(handle.workspace)).toBe(true);
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], ws)).stdout.trim()).toBe("beckett/t1");
  });
});
