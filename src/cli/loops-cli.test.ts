import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cliRaw(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "beckett.ts"), ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`CLI failed (${code}): ${stderr || stdout}`);
  return stdout;
}

async function cli(dir: string, args: string[]): Promise<unknown> {
  return JSON.parse(await cliRaw(dir, args));
}

async function cliFailure(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "beckett.ts"), ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  return stderr || stdout;
}

test("task create --loop stamps the link, and beckett loops surfaces it with a live status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-cli-"));
  dirs.push(dir);

  await cli(dir, [
    "loops", "open",
    "--name", "external-pr-has-no-watcher",
    "--kind", "recurring-error",
    "--due", "2026-08-01",
    "--source", "self",
    "--desc", "PRs outside our own org get no watcher at all",
  ]);

  const created = await cli(dir, [
    "task", "create",
    "--title", "Watch every PR I open",
    "--loop", "external-pr-has-no-watcher",
  ]) as any;
  expect(created.task.ref).toBe("#1");

  const listed = await cli(dir, ["loops", "--as-self", "--json"]) as any;
  const loop = listed.loops.find((l: any) => l.name === "external-pr-has-no-watcher");
  expect(loop.linkedTasks).toEqual([{ ref: "#1", status: "active" }]);

  const text = await cliRaw(dir, ["loops", "--as-self"]);
  expect(text).toContain("already filed: #1 active");
});

test("beckett loops rejects flags outside each subcommand's allow-list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-cli-flags-"));
  dirs.push(dir);

  const noteError = await cliFailure(dir, ["loops", "note", "anything", "--note", "probe", "--due", "2026-08-05"]);
  expect(noteError).toContain("unknown flag --due");
  expect(noteError).toContain("usage: beckett loops");

  const openError = await cliFailure(dir, [
    "loops", "open", "--name", "anything", "--kind", "wishlist", "--due", "2026-08-05",
    "--source", "self", "--desc", "probe", "--task", "#31.1",
  ]);
  expect(openError).toContain("unknown flag --task");
  expect(openError).toContain("usage: beckett loops");
});

test("beckett loops open reports every missing required flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-cli-open-required-"));
  dirs.push(dir);

  const error = await cliFailure(dir, ["loops", "open", "--name", "only-name"]);
  expect(error).toContain("--kind");
  expect(error).toContain("--due");
  expect(error).toContain("--source");
  expect(error).toContain("--desc");
});

test("beckett loops link attaches a task ref to an already-open loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-cli-link-"));
  dirs.push(dir);

  await cli(dir, [
    "loops", "open",
    "--name", "duplicate-tickets",
    "--kind", "recurring-error",
    "--due", "2026-08-01",
    "--source", "self",
    "--desc", "loops sweep duplicate tickets",
  ]);
  const created = await cli(dir, ["task", "create", "--title", "Cross-check the registry"]) as any;

  const linked = await cli(dir, ["loops", "link", "duplicate-tickets", "--task", created.task.ref]) as any;
  expect(linked).toEqual({ linked: "duplicate-tickets", linkedTasks: ["#1"] });
});
