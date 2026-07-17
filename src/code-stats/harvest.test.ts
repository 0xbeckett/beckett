import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harvestCodeStats, parseGitLog } from "./harvest.ts";

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function commit(cwd: string, name: string, email: string, date: string, message: string): Promise<void> {
  await run(cwd, ["add", "."]);
  await run(cwd, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  });
}

test("code-stats caches history LOC, authors, projects, and daily velocity", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-code-stats-"));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  await Promise.all([run(alpha, ["init"]), run(beta, ["init"])]);

  await writeFile(join(alpha, "hello.ts"), "one\ntwo\n");
  await commit(alpha, "Beckett", "bot@example.test", "2026-01-01T12:00:00Z", "initial");
  await writeFile(join(alpha, "hello.ts"), "one\nthree\nfour\n");
  await commit(alpha, "Ada Human", "ada@example.test", "2026-01-02T12:00:00Z", "change");
  await writeFile(join(beta, "readme.md"), "hello\n");
  await commit(beta, "Ada Human", "ada@example.test", "2026-01-02T13:00:00Z", "initial");

  const output = join(root, "code-stats.json");
  const stats = await harvestCodeStats({ output, projectsDir: root, note: () => {} });
  expect(stats.headline).toEqual({ commits: 3, files: 2, projects: 2, additions: 5, deletions: 1, net: 4 });
  expect(stats.projects.map((project) => [project.repo, project.commits, project.files, project.net]).sort()).toEqual([
    ["alpha", 2, 1, 3], ["beta", 1, 1, 1],
  ]);
  expect(stats.authors.map((author) => [author.author, author.commits, author.additions, author.deletions])).toEqual([
    ["Ada Human <ada@example.test>", 2, 3, 1], ["Beckett <bot@example.test>", 1, 2, 0],
  ]);
  expect(stats.velocity).toEqual([{ date: "2026-01-01", commits: 1 }, { date: "2026-01-02", commits: 2 }]);
  expect(JSON.parse(await readFile(output, "utf8")).headline.commits).toBe(3);
});

test("parseGitLog excludes binary numstat entries from LOC without dropping the commit", () => {
  const rows = parseGitLog("\x1eabc\x1fBeckett\x1fbot@example.test\x1f2026-01-01T00:00:00Z\n-\t-\timage.png\n2\t1\tapp.ts\n");
  expect(rows).toEqual([{ hash: "abc", name: "Beckett", email: "bot@example.test", date: "2026-01-01T00:00:00Z", additions: 2, deletions: 1 }]);
});
