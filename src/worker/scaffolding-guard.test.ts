/**
 * OPS-61 — proof that Beckett's internal scaffolding (`.beckett/`) can NEVER be staged, committed,
 * or land in a diff, under any code path. We spin up a real temp git repo (no mocks) and exercise
 * the three independent guards: `info/exclude` (blocks `git add -A`), the shared `pre-commit` hook
 * (strips even a forced `git add -f`), and the explicit strip inside {@link commitWorktree}.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  excludeFromGit,
  installScaffoldingGuardHook,
  commitWorktree,
  readDiff,
  SCAFFOLDING_DIR,
} from "./worktree.ts";

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout };
}

let repo: string;

/** A repo shaped like a worker's checkout: an initial commit, then `.beckett/` scaffolding wired in. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "beckett-scaffold-"));
  await run(["init"], dir);
  await run(["config", "user.email", "beckett@test"], dir);
  await run(["config", "user.name", "Beckett"], dir);
  await run(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# project\n");
  await run(["add", "-A"], dir);
  await run(["commit", "-m", "init"], dir);
  // The scaffolding the dispatcher writes at spawn.
  mkdirSync(join(dir, SCAFFOLDING_DIR), { recursive: true });
  writeFileSync(join(dir, SCAFFOLDING_DIR, "done-schema.json"), "{}\n");
  writeFileSync(join(dir, SCAFFOLDING_DIR, "worker-settings.json"), "{}\n");
  await excludeFromGit(dir, [`${SCAFFOLDING_DIR}/`]);
  await installScaffoldingGuardHook(dir);
  return dir;
}

beforeEach(async () => {
  repo = await makeRepo();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("scaffolding guard", () => {
  test("git add -A does not stage .beckett/ (info/exclude)", async () => {
    writeFileSync(join(repo, "real.ts"), "export const x = 1;\n");
    await run(["add", "-A"], repo);
    const staged = (await run(["diff", "--cached", "--name-only"], repo)).stdout;
    expect(staged).toContain("real.ts");
    expect(staged).not.toContain(SCAFFOLDING_DIR);
  });

  test("commitWorktree produces a clean commit — real work only, no scaffolding", async () => {
    writeFileSync(join(repo, "real.ts"), "export const x = 1;\n");
    const res = await commitWorktree(repo, "beckett: implement");
    expect(res.committed).toBe(true);
    const files = (await run(["show", "--name-only", "--pretty=format:", "HEAD"], repo)).stdout;
    expect(files).toContain("real.ts");
    expect(files).not.toContain(SCAFFOLDING_DIR);
  });

  test("even a forced `git add -f .beckett` never reaches a commit (pre-commit hook)", async () => {
    writeFileSync(join(repo, "real.ts"), "export const x = 1;\n");
    // A worker maliciously/accidentally force-adds the scaffolding past the exclude.
    await run(["add", "-f", `${SCAFFOLDING_DIR}/done-schema.json`], repo);
    await run(["add", "real.ts"], repo);
    let staged = (await run(["diff", "--cached", "--name-only"], repo)).stdout;
    expect(staged).toContain(SCAFFOLDING_DIR); // it IS staged pre-commit...
    // ...but committing via the worker's own `git commit` fires the hook that strips it.
    const c = await run(["commit", "-m", "worker commit"], repo);
    expect(c.code).toBe(0);
    const files = (await run(["show", "--name-only", "--pretty=format:", "HEAD"], repo)).stdout;
    expect(files).toContain("real.ts");
    expect(files).not.toContain(SCAFFOLDING_DIR);
  });

  test("commitWorktree strips a forced add even with hooks bypassed", async () => {
    writeFileSync(join(repo, "real.ts"), "export const x = 1;\n");
    await run(["add", "-f", `${SCAFFOLDING_DIR}/done-schema.json`], repo);
    const res = await commitWorktree(repo, "beckett: implement");
    expect(res.committed).toBe(true);
    const files = (await run(["show", "--name-only", "--pretty=format:", "HEAD"], repo)).stdout;
    expect(files).not.toContain(SCAFFOLDING_DIR);
  });

  test("the worker's diff readout never shows scaffolding", async () => {
    writeFileSync(join(repo, "real.ts"), "export const x = 1;\n");
    const diff = await readDiff(repo);
    expect(diff).toContain("real.ts");
    expect(diff).not.toContain(SCAFFOLDING_DIR);
  });

  test("installing the hook does not clobber a project's own pre-commit hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-hook-"));
    await run(["init"], dir);
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\n# project's own hook\nexit 0\n");
    await installScaffoldingGuardHook(dir);
    const after = await Bun.file(hookPath).text();
    expect(after).toContain("project's own hook");
    expect(after).not.toContain("beckett-scaffolding-guard");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the hook is idempotent — reinstalling is a no-op we own", async () => {
    await installScaffoldingGuardHook(repo);
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    expect(existsSync(hookPath)).toBe(true);
    const body = await Bun.file(hookPath).text();
    expect(body).toContain("beckett-scaffolding-guard");
  });
});
