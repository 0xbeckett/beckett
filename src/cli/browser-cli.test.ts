import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTaskSubcommandMistake } from "./core.ts";

async function browserCli(args: string[]): Promise<{ exit: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-cli-"));
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "beckett.ts"), "browser", ...args], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exit: await proc.exited, stderr: await new Response(proc.stderr).text() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rejects bare browser subcommand attempts and points to a real subcommand", () => {
  for (const token of ["status", "watch", "steer", "stop", "exec", "stats"]) {
    expect(browserTaskSubcommandMistake([token])).not.toBeNull();
  }
  for (const token of ["list", "ls", "ps", "logs", "log", "show", "help", "run", "task", "info"]) {
    expect(browserTaskSubcommandMistake([token])).not.toBeNull();
  }
  expect(browserTaskSubcommandMistake(["ls"])).toEqual({ token: "ls", nearest: "status" });
  expect(browserTaskSubcommandMistake(["stats"])).toEqual({ token: "stats", nearest: "status" });
  expect(browserTaskSubcommandMistake(["logs"])).toEqual({ token: "logs", nearest: "watch" });
});

test("allows browser task prose, including prose beginning with a subcommand-shaped word", () => {
  expect(browserTaskSubcommandMistake(["list the open issues on github.com/0xbeckett/beckett"])).toBeNull();
  expect(browserTaskSubcommandMistake(["list", "the", "open", "issues"])).toBeNull();
  expect(browserTaskSubcommandMistake(["ls", "--context", "background"])).toBeNull();
});

test("CLI prints named usage for a bare alias but reaches dispatch for task prose", async () => {
  const rejected = await browserCli(["ls"]);
  expect(rejected.exit).toBe(1);
  expect(rejected.stderr).toContain('"ls" looks like a browser subcommand');
  expect(rejected.stderr).toContain('usage: beckett browser "<task>"');

  const dispatched = await browserCli(["list the open issues on github.com/0xbeckett/beckett"]);
  expect(dispatched.exit).toBe(1); // No daemon in this hermetic test means dispatch reaches its socket boundary.
  expect(dispatched.stderr).toContain("shell not running");
  expect(dispatched.stderr).not.toContain("usage: beckett browser");
});
