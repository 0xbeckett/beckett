import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cliRaw(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "beckett.ts"), ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir, ...env },
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

async function cli(dir: string, args: string[], env: Record<string, string> = {}): Promise<unknown> {
  return JSON.parse(await cliRaw(dir, args, env));
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-agent-cli-"));
  dirs.push(dir);
  return dir;
}

test("agent add writes a full definition; ls and show read it back", async () => {
  const dir = freshDir();

  const added = (await cli(dir, [
    "agent", "add", "release-notes-writer",
    "--description", "drafts release notes",
    "--prompt", "You write crisp release notes.",
    "--model", "claude-opus-5",
    "--harness", "claude",
    "--effort", "high",
    "--skills", "github,deliver",
    "--tools", "Read,Edit",
    "--persistent",
  ])) as any;
  expect(added).toMatchObject({
    id: "release-notes-writer",
    description: "drafts release notes",
    harness: "claude",
    model: "claude-opus-5",
    effort: "high",
    skills: ["github", "deliver"],
    tools: ["Read", "Edit"],
    persistent: true,
  });

  const listed = (await cli(dir, ["agent", "ls"])) as any[];
  expect(listed).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "release-notes-writer", persistent: true })]),
  );
  // The built-in social-media agent is seeded into every registry (pure data).
  expect(listed.map((a) => a.id)).toContain("social-media");

  const shown = (await cli(dir, ["agent", "show", "release-notes-writer"])) as any;
  expect(shown).toMatchObject({
    id: "release-notes-writer",
    systemPrompt: "You write crisp release notes.",
  });
  expect(shown.createdAt).toBeTruthy();
});

test("agent defaults harness/effort/persistent and ephemeral is the default", async () => {
  const dir = freshDir();
  const added = (await cli(dir, [
    "agent", "add", "quick-helper",
    "--description", "a helper",
    "--prompt", "help",
    "--model", "claude-sonnet-5",
  ])) as any;
  expect(added).toMatchObject({
    id: "quick-helper",
    harness: "claude",
    effort: "medium",
    persistent: false, // ephemeral by default
    skills: [],
    tools: [],
  });
});

test("agent rm removes it; a subsequent show fails", async () => {
  const dir = freshDir();
  await cli(dir, ["agent", "add", "tmp", "--description", "d", "--prompt", "p", "--model", "m"]);
  const removed = await cliRaw(dir, ["agent", "rm", "tmp"]);
  expect(removed).toContain("removed agent tmp");
  const listed = (await cli(dir, ["agent", "ls"])) as any[];
  expect(listed.map((a) => a.id)).not.toContain("tmp");
  await expect(cli(dir, ["agent", "show", "tmp"])).rejects.toThrow(/no such agent/);
});

test("agent new derives a kebab id from --name and defaults the description to the name", async () => {
  const dir = freshDir();
  const created = (await cli(dir, [
    "agent", "new",
    "--name", "Foo Bar",
    "--prompt", "you are foo bar",
    "--model", "claude-sonnet-5",
  ])) as any;
  expect(created).toMatchObject({
    id: "foo-bar",
    description: "Foo Bar", // name used as the description when --description is omitted
    harness: "claude",
    effort: "medium",
    persistent: false,
  });

  // It round-trips through the same store as `add`.
  const shown = (await cli(dir, ["agent", "show", "foo-bar"])) as any;
  expect(shown).toMatchObject({ id: "foo-bar", systemPrompt: "you are foo bar" });
});

test("agent new accepts the same optional flags as add and honors --description", async () => {
  const dir = freshDir();
  const created = (await cli(dir, [
    "agent", "new",
    "--name", "Release Notes Writer!",
    "--description", "drafts release notes",
    "--prompt", "You write crisp release notes.",
    "--model", "claude-opus-5",
    "--harness", "claude",
    "--effort", "high",
    "--skills", "github,deliver",
    "--tools", "Read,Edit",
    "--persistent",
  ])) as any;
  expect(created).toMatchObject({
    id: "release-notes-writer",
    description: "drafts release notes",
    effort: "high",
    skills: ["github", "deliver"],
    tools: ["Read", "Edit"],
    persistent: true,
  });
});

test("agent new requires --name and rejects a colliding derived id", async () => {
  const dir = freshDir();
  await expect(
    cli(dir, ["agent", "new", "--prompt", "p", "--model", "m"]),
  ).rejects.toThrow(/name/);

  await cli(dir, ["agent", "new", "--name", "Foo Bar", "--prompt", "p", "--model", "m"]);
  await expect(
    cli(dir, ["agent", "new", "--name", "foo bar", "--prompt", "p", "--model", "m"]),
  ).rejects.toThrow(/already exists/);
});

test("agent invoke validates input and a known agent before spawning any harness", async () => {
  const dir = freshDir();
  // Missing the input argument → usage error, no spawn.
  await expect(cli(dir, ["agent", "invoke", "social-media"])).rejects.toThrow(/usage/);
  // Unknown agent → clean failure, no spawn.
  await expect(cli(dir, ["agent", "invoke", "nope", "do a thing"])).rejects.toThrow(/no such agent/);
});

test("agent add rejects a missing required flag and a bad harness", async () => {
  const dir = freshDir();
  await expect(
    cli(dir, ["agent", "add", "x", "--prompt", "p", "--model", "m"]),
  ).rejects.toThrow(/description/);
  await expect(
    cli(dir, ["agent", "add", "x", "--description", "d", "--prompt", "p", "--model", "m", "--harness", "bogus"]),
  ).rejects.toThrow(/harness must be one of/);
});
