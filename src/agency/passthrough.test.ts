/**
 * Coverage for the two aperture-openers on the already-tokenized GitHub wrapper (#88):
 *   - {@link GitHubCli.raw} — the `beckett gh raw -- <args>` passthrough to the real `gh` binary, and
 *   - {@link GitHubCli.pushTag} — pushing a release tag to `refs/tags/*`, the ref-shape the curated
 *     branch push structurally can't reach.
 *
 * The invariant both must hold (the whole reason this is a passthrough, not a bashrc alias): the PAT
 * rides the ENVIRONMENT (GH_TOKEN / the inline git credential helper), never argv — so it can't leak
 * into a transcript, a hook, or `~/.git-credentials`. Every subprocess is faked (an injected `spawn`
 * for the streaming passthrough, an injected `run` for the tag push), so nothing touches a real gh.
 */

import { expect, test } from "bun:test";
import { GitHubCli } from "./index.ts";
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

const PAT = "ghp_secret_tok";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A GitHubCli wired with a fake streaming spawner (for `raw`) and a fake runner (for `pushTag`). */
function cli(opts: {
  spawnExit?: number;
  route?: (joined: string) => RunResult | undefined;
  pat?: string;
} = {}) {
  const spawns: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
  const runs: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
  const gh = new GitHubCli({
    pat: opts.pat ?? PAT,
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/repo",
    logger: noopLog,
    spawn: (cmd, o) => {
      spawns.push({ cmd, cwd: o.cwd, env: o.env });
      return { exited: Promise.resolve(opts.spawnExit ?? 0) };
    },
    run: (async (cmd: string[], o?: { cwd?: string; env?: Record<string, string | undefined> }) => {
      runs.push({ cmd, cwd: o?.cwd, env: o?.env });
      return opts.route?.(cmd.join(" ")) ?? { code: 0, stdout: "", stderr: "" };
    }) as never,
  });
  return { gh, spawns, runs };
}

test("raw forwards argv VERBATIM to the real gh, prefixed with `gh`", async () => {
  const { gh, spawns } = cli();
  const code = await gh.raw(["api", "repos/0xbeckett/beckett/rulesets", "--paginate"]);
  expect(code).toBe(0);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.cmd).toEqual(["gh", "api", "repos/0xbeckett/beckett/rulesets", "--paginate"]);
});

test("raw injects the PAT via the environment (GH_TOKEN + git helper), NEVER argv", async () => {
  const { gh, spawns } = cli();
  await gh.raw(["release", "create", "v6.0.4", "--generate-notes"]);
  const { cmd, env } = spawns[0]!;
  // The token reaches gh (its own API) and any git it shells out to (the credential helper) …
  expect(env?.GH_TOKEN).toBe(PAT);
  expect(env?.GITHUB_TOKEN).toBe(PAT);
  expect(env?.GITHUB_PAT).toBe(PAT);
  expect(env?.GIT_CONFIG_VALUE_1).toContain('password=$GITHUB_PAT'); // a REFERENCE, not the value
  // … but the secret itself is nowhere in the argument vector.
  expect(cmd.join(" ")).not.toContain(PAT);
  expect(cmd.some((a) => a.includes(PAT))).toBe(false);
});

test("raw propagates gh's exit code", async () => {
  const { gh } = cli({ spawnExit: 3 });
  expect(await gh.raw(["pr", "view", "999"])).toBe(3);
});

test("raw runs in the given working dir", async () => {
  const { gh, spawns } = cli();
  await gh.raw(["repo", "view"], "/some/checkout");
  expect(spawns[0]!.cwd).toBe("/some/checkout");
});

test("raw refuses when no PAT is configured (never spawns gh)", async () => {
  const { gh, spawns } = cli({ pat: "" });
  await expect(gh.raw(["pr", "list"])).rejects.toThrow(/GITHUB_PAT/);
  expect(spawns).toHaveLength(0);
});

test("pushTag pushes refs/tags/<tag>:refs/tags/<tag> with the credential-helper env", async () => {
  const { gh, runs } = cli();
  await gh.pushTag("0xbeckett/beckett", "v6.0.4");
  expect(runs).toHaveLength(1);
  expect(runs[0]!.cmd).toEqual([
    "git",
    "push",
    "https://github.com/0xbeckett/beckett.git",
    "refs/tags/v6.0.4:refs/tags/v6.0.4",
  ]);
  // Same env boundary as every transport op: PAT in the helper, never in argv.
  expect(runs[0]!.env?.GITHUB_PAT).toBe(PAT);
  expect(runs[0]!.cmd.join(" ")).not.toContain(PAT);
});

test("pushTag accepts an already-qualified refs/tags/ ref without doubling it", async () => {
  const { gh, runs } = cli();
  await gh.pushTag("0xbeckett/beckett", "refs/tags/v6.0.4");
  expect(runs[0]!.cmd[3]).toBe("refs/tags/v6.0.4:refs/tags/v6.0.4");
});

test("pushTag surfaces a server rejection (e.g. a pre-receive hook decline) with the tag named", async () => {
  const { gh } = cli({
    route: (j) =>
      j.startsWith("git push")
        ? { code: 1, stdout: "", stderr: "remote: error: GH006: Protected tag update failed\nremote: pre-receive hook declined" }
        : undefined,
  });
  await expect(gh.pushTag("0xbeckett/beckett", "v6.0.4")).rejects.toThrow(/tag v6\.0\.4.*pre-receive hook declined/s);
});

test("pushTag refuses when no PAT is configured", async () => {
  const { gh } = cli({ pat: "" });
  await expect(gh.pushTag("0xbeckett/beckett", "v6.0.4")).rejects.toThrow(/GITHUB_PAT/);
});
