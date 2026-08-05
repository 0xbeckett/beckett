/**
 * The GitHub App path through {@link GitHubCli} (#114). `passthrough.test.ts` pins the legacy PAT
 * invariants; this pins the ones that only exist under App auth:
 *
 *   - the token handed to `gh`/`git` is a freshly minted INSTALLATION token, not a PAT,
 *   - `git` authenticates as `x-access-token` (the only username GitHub accepts for one),
 *   - the installation is chosen from the operation's TARGET repo, so a client configured for one
 *     account cannot push with another account's token, and
 *   - the secret still never reaches argv.
 */

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubCli, githubAuth, githubConfigured, loadIdentity } from "./index.ts";
import { GitHubAppAuth } from "../github/app.ts";
import { defaultConfig } from "../config.ts";
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

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A GitHub API fake: each repo maps to its installation, each installation to its own token. */
function apiFake(installs: Record<string, { id: number; token: string }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.github.com", "");
    const repo = path.match(/^\/repos\/(.+)\/installation$/)?.[1];
    if (repo) {
      const hit = installs[repo];
      return hit
        ? Response.json({ id: hit.id, account: { login: repo.split("/")[0] }, repository_selection: "selected" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const owner = path.match(/^\/(?:orgs|users)\/([^/]+)\/installation$/)?.[1];
    if (owner) {
      const hit = Object.entries(installs).find(([r]) => r.split("/")[0] === owner);
      return hit
        ? Response.json({ id: hit[1].id, account: { login: owner }, repository_selection: "selected" })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (path === "/app") {
      return Response.json({ id: 111, slug: "beckett", name: "beckett", owner: { login: "kowo-co" } });
    }
    if (path.startsWith("/app/installations?")) {
      return Response.json(
        Object.entries(installs).map(([r, i]) => ({
          id: i.id,
          account: { login: r.split("/")[0], type: "Organization" },
          repository_selection: "selected",
        })),
      );
    }
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)?.[1];
    if (mint && (init?.method ?? "GET") === "POST") {
      const found = Object.values(installs).find((i) => String(i.id) === mint);
      return Response.json(
        { token: found?.token ?? "ghs_unknown", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function cli(installs: Record<string, { id: number; token: string }>) {
  const runs: Array<{ cmd: string[]; env?: Record<string, string | undefined> }> = [];
  const app = new GitHubAppAuth(
    { appId: "111", privateKeyPem: privateKey },
    { fetchImpl: apiFake(installs) },
  );
  const gh = new GitHubCli({
    pat: "", // App auth only — no PAT anywhere
    app,
    account: "beckett[bot]",
    owner: "kowo-co",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/repo",
    logger: noopLog,
    run: (async (cmd: string[], o?: { env?: Record<string, string | undefined> }) => {
      runs.push({ cmd, env: o?.env });
      return { code: 0, stdout: "", stderr: "" };
    }) as never,
  });
  return { gh, runs };
}

test("a push authenticates with the installation token as x-access-token, never in argv", async () => {
  const { gh, runs } = cli({ "kowo-co/beckett": { id: 555, token: "ghs_kowo" } });
  await gh.pushBranch("kowo-co/beckett", "HEAD", "beckett/feature");

  const push = runs.find((r) => r.cmd[0] === "git" && r.cmd[1] === "push");
  expect(push).toBeDefined();
  expect(push!.env?.GITHUB_PAT).toBe("ghs_kowo"); // the carrier slot holds the SHORT-LIVED token
  expect(push!.env?.GIT_CONFIG_VALUE_1).toContain("username=x-access-token");
  expect(push!.env?.GIT_CONFIG_VALUE_1).toContain("password=$GITHUB_PAT"); // a reference, not a value
  expect(push!.cmd.join(" ")).not.toContain("ghs_kowo");
});

test("gh gets the same installation token via GH_TOKEN", async () => {
  const { gh, runs } = cli({ "kowo-co/beckett": { id: 555, token: "ghs_kowo" } });
  await gh.isGreen("kowo-co/beckett", 42);
  const view = runs.find((r) => r.cmd[0] === "gh");
  expect(view!.env?.GH_TOKEN).toBe("ghs_kowo");
  expect(view!.env?.GITHUB_TOKEN).toBe("ghs_kowo");
});

test("the token follows the TARGET repo — one client never reuses another account's token", async () => {
  const { gh, runs } = cli({
    "kowo-co/beckett": { id: 555, token: "ghs_kowo" },
    "octocat/hello": { id: 777, token: "ghs_octocat" },
  });
  await gh.pushBranch("kowo-co/beckett", "HEAD", "a");
  await gh.pushBranch("octocat/hello", "HEAD", "b");

  const pushes = runs.filter((r) => r.cmd[0] === "git" && r.cmd[1] === "push");
  expect(pushes[0]!.env?.GITHUB_PAT).toBe("ghs_kowo");
  expect(pushes[1]!.env?.GITHUB_PAT).toBe("ghs_octocat");
});

test("a repo no installation covers fails loudly with the install link, never silently", async () => {
  // Two installations, so there is no "sole installation" to fall back to — the only honest
  // outcome is a refusal naming the real accounts and the install link.
  const { gh } = cli({
    "kowo-co/beckett": { id: 555, token: "ghs_kowo" },
    "octocat/hello": { id: 777, token: "ghs_octocat" },
  });
  const push = gh.pushBranch("stranger/private-thing", "HEAD", "a");
  await expect(push).rejects.toThrow(/no installation covers stranger\/private-thing/);
  await expect(gh.pushBranch("stranger/private-thing", "HEAD", "a")).rejects.toThrow(
    /apps\/beckett\/installations\/new/,
  );
});

test("a single installation IS the fallback — a one-tenant box keeps working", async () => {
  const { gh, runs } = cli({ "kowo-co/beckett": { id: 555, token: "ghs_kowo" } });
  await gh.pushBranch("kowo-co/other-repo", "HEAD", "a");
  const push = runs.find((r) => r.cmd[0] === "git" && r.cmd[1] === "push");
  expect(push!.env?.GITHUB_PAT).toBe("ghs_kowo");
});

test("githubAuth/githubConfigured route the identity to the App when one is configured", () => {
  const config = defaultConfig();
  const env = {
    GITHUB_ACCOUNT: "beckett",
    GITHUB_APP_ID: "111",
    GITHUB_APP_PRIVATE_KEY_PEM: privateKey,
  } as unknown as NodeJS.ProcessEnv;

  const identity = loadIdentity(config, env);
  expect(identity.github.app?.appId).toBe("111");
  expect(githubConfigured(identity)).toBe(true);
  const auth = githubAuth(identity);
  expect(auth.app).toBeInstanceOf(GitHubAppAuth);
  expect(auth.pat).toBe("");
  // One GitHubAppAuth per app id for the process, so the token cache is shared across clients.
  expect(githubAuth(loadIdentity(config, env)).app).toBe(auth.app);
});

test("a PAT-only identity keeps the legacy path and reports no App", () => {
  const identity = loadIdentity(defaultConfig(), {
    GITHUB_ACCOUNT: "beckett",
    GITHUB_PAT: "ghp_legacy",
  } as unknown as NodeJS.ProcessEnv);
  expect(identity.github.app).toBeUndefined();
  expect(githubConfigured(identity)).toBe(true);
  expect(githubAuth(identity)).toEqual({ pat: "ghp_legacy" });
});

test("no credential at all is not configured — and every op throws instead of no-opping", async () => {
  const identity = loadIdentity(defaultConfig(), { GITHUB_ACCOUNT: "beckett" } as unknown as NodeJS.ProcessEnv);
  expect(githubConfigured(identity)).toBe(false);
  const gh = new GitHubCli({
    ...githubAuth(identity),
    account: "beckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/repo",
    logger: noopLog,
  });
  expect(gh.available).toBe(false);
  await expect(gh.pushBranch("kowo-co/beckett", "HEAD", "a")).rejects.toThrow(/no GitHub credentials/);
});
