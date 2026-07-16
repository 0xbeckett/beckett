import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cli(dir: string, args: string[], env: Record<string, string> = {}): Promise<unknown> {
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
  return JSON.parse(stdout);
}

test("task create, branch, show, and list share one durable public namespace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-"));
  dirs.push(dir);

  const created = await cli(dir, [
    "task", "create",
    "--title", "Voting launch",
    "--branch-title", "Votes schema",
    "--project", "polls",
  ]) as any;
  expect(created).toMatchObject({
    task: { ref: "#1", displayName: "#1 - Voting launch", project: "polls" },
    branch: { ref: "#1.1", title: "Votes schema", status: "ready" },
  });

  const branch = await cli(dir, [
    "task", "branch", "#1",
    "--title", "Voting API",
    "--needs", "#1.1",
  ]) as any;
  expect(branch).toMatchObject({
    taskRef: "#1",
    branch: { ref: "#1.2", needs: ["1.1"], status: "waiting" },
  });

  const shown = await cli(dir, ["task", "show", "#1.2"]) as any;
  expect(shown).toMatchObject({
    task: { ref: "#1", title: "Voting launch" },
    branch: { ref: "#1.2", title: "Voting API" },
  });

  const listed = await cli(dir, ["task", "list"]) as any[];
  expect(listed).toEqual([
    expect.objectContaining({
      ref: "#1",
      displayName: "#1 - Voting launch",
      branches: [
        expect.objectContaining({ ref: "#1.1", title: "Votes schema" }),
        expect.objectContaining({ ref: "#1.2", title: "Voting API" }),
      ],
    }),
  ]);
});

test("task start files the public branch marker into the tracker and links the internal ticket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-start-"));
  dirs.push(dir);
  const createPayloads: Array<Record<string, unknown>> = [];
  const tickets: Array<Record<string, unknown>> = [];
  // A minimal fake of bored's HTTP surface: create files as `todo`; a staff call opens the run.
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/tickets" && request.method === "GET") {
        return Response.json({ tickets });
      }
      if (url.pathname === "/tickets" && request.method === "POST") {
        const createPayload = await request.json() as Record<string, unknown>;
        createPayloads.push(createPayload);
        const ticket = {
          ref: "OPS-77",
          title: createPayload.title,
          body: createPayload.body,
          criteria: createPayload.criteria ?? [],
          state: "todo",
          needs: createPayload.needs ?? [],
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
        };
        tickets.push(ticket);
        return Response.json({ ticket });
      }
      if (url.pathname === "/tickets/OPS-77" && request.method === "GET") {
        return Response.json({ ticket: tickets[0] });
      }
      if (url.pathname === "/tickets/OPS-77/staff" && request.method === "POST") {
        tickets[0]!.state = "in_progress";
        return Response.json({ ok: true });
      }
      return new Response(`unexpected ${request.method} ${url.pathname}`, { status: 404 });
    },
  });

  try {
    await cli(dir, ["task", "create", "--title", "Voting launch", "--project", "polls"]);
    const started = await cli(
      dir,
      [
        "task", "start", "#1.1",
        "--body", "Build it",
        "--criteria", "works;tested",
        "--cast", '{"implement":{"harness":"pi","effort":"medium"}}',
      ],
      { BECKETT_BORED_URL: server.url.origin },
    ) as any;

    expect(started).toMatchObject({
      taskRef: "#1",
      branchRef: "#1.1",
      identifier: "OPS-77",
      state: "in_progress",
    });
    expect(String(createPayloads[0]?.body)).toContain("```beckett-branch\n1.1\n```");
    const shown = await cli(dir, ["task", "show", "#1.1"]) as any;
    expect(shown.branch).toMatchObject({
      ref: "#1.1",
      status: "running",
      ticket: { id: "OPS-77", identifier: "OPS-77", board: "ops" },
    });
  } finally {
    server.stop(true);
  }
});
