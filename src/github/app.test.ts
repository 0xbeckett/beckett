/**
 * Coverage for GitHub App auth (`src/github/app.ts`) — the credential chain that replaced the
 * lost `0xbeckett` PAT. Everything here runs against a REAL RSA keypair (generated per-run) and a
 * fake `fetch` that returns GitHub's actual response shapes, so the JWT is genuinely verified with
 * `crypto.createVerify` rather than string-matched.
 */

import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitHubAppApiError,
  GitHubAppAuth,
  GitHubAppConfigError,
  appInstallUrl,
  hasGitHubAppEnv,
  loadGitHubAppCredentials,
  mintAppJwt,
} from "./app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CREDS = { appId: "123456", privateKeyPem: privateKey };

function b64urlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** A fake fetch that routes on `METHOD path`; anything unrouted is a 404 Not Found. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Array<{ method: string; url: string; auth?: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url: path, auth: headers.Authorization });
    const hit = routes[`${method} ${path}`];
    const status = hit?.status ?? (hit ? 200 : 404);
    const body = hit?.body ?? { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── credential loading ────────────────────────────────────────────────────────────────────────

describe("loadGitHubAppCredentials", () => {
  test("returns null when nothing app-shaped is configured (the PAT path stays valid)", () => {
    expect(hasGitHubAppEnv({})).toBe(false);
    expect(loadGitHubAppCredentials({})).toBeNull();
  });

  test("reads the private key off disk and pins an installation", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-app-"));
    const pem = join(dir, "beckett.private-key.pem");
    writeFileSync(pem, privateKey);
    const creds = loadGitHubAppCredentials({
      GITHUB_APP_ID: " 123456 ",
      GITHUB_APP_PRIVATE_KEY_PATH: pem,
      GITHUB_APP_INSTALLATION_ID: "987",
      GITHUB_APP_SLUG: "beckett",
    });
    expect(creds?.appId).toBe("123456");
    expect(creds?.privateKeyPem).toContain("PRIVATE KEY");
    expect(creds?.installationId).toBe(987);
    expect(creds?.slug).toBe("beckett");
  });

  test("accepts an inline PEM with dotenv-escaped newlines", () => {
    const creds = loadGitHubAppCredentials({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY_PEM: privateKey.replace(/\n/g, "\\n"),
    });
    expect(creds?.privateKeyPem).toBe(privateKey);
  });

  test("a half-configured app FAILS LOUD rather than degrading to no-GitHub", () => {
    expect(() => loadGitHubAppCredentials({ GITHUB_APP_ID: "123456" })).toThrow(GitHubAppConfigError);
    expect(() => loadGitHubAppCredentials({ GITHUB_APP_ID: "123456" })).toThrow(/no private key/);
    expect(() => loadGitHubAppCredentials({ GITHUB_APP_PRIVATE_KEY_PEM: privateKey })).toThrow(
      /GITHUB_APP_ID is not/,
    );
    expect(() =>
      loadGitHubAppCredentials({ GITHUB_APP_ID: "beckett", GITHUB_APP_PRIVATE_KEY_PEM: privateKey }),
    ).toThrow(/numeric app id/);
    expect(() =>
      loadGitHubAppCredentials({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/nope/missing.pem" }),
    ).toThrow(/cannot read GITHUB_APP_PRIVATE_KEY_PATH/);
    expect(() =>
      loadGitHubAppCredentials({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PEM: "not-a-key" }),
    ).toThrow(/not a PEM private key/);
    expect(() =>
      loadGitHubAppCredentials({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY_PEM: privateKey,
        GITHUB_APP_INSTALLATION_ID: "abc",
      }),
    ).toThrow(/must be numeric/);
  });
});

// ── the JWT ───────────────────────────────────────────────────────────────────────────────────

describe("mintAppJwt", () => {
  test("is a real RS256 JWT that verifies against the app's public key", () => {
    const now = 1_770_000_000_000;
    const jwt = mintAppJwt(CREDS, now);
    const [header, payload, signature] = jwt.split(".");
    expect(b64urlJson(header!)).toEqual({ alg: "RS256", typ: "JWT" });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    const sig = Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  test("backdates iat against clock drift and stays inside GitHub's 10-minute ceiling", () => {
    const now = 1_770_000_000_000;
    const claims = b64urlJson(mintAppJwt(CREDS, now).split(".")[1]!);
    const nowSec = Math.floor(now / 1000);
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(nowSec - 60);
    expect(claims.exp).toBe(nowSec + 540);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
  });

  test("a key that cannot sign is a loud config error, not a silent empty token", () => {
    expect(() => mintAppJwt({ appId: "1", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" })).toThrow(
      GitHubAppConfigError,
    );
  });
});

// ── installation tokens ───────────────────────────────────────────────────────────────────────

const INSTALL_TOKEN = (expiresAt: string, token = "ghs_installation_token") => ({
  status: 201,
  body: { token, expires_at: expiresAt, repository_selection: "selected", permissions: { contents: "write" } },
});

describe("installation tokens", () => {
  test("mints a token for the installation that owns the target repo", async () => {
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const { impl, calls } = fakeFetch({
      "GET /repos/kowo-co/beckett/installation": {
        body: { id: 555, account: { login: "kowo-co", type: "Organization" }, repository_selection: "selected" },
      },
      "POST /app/installations/555/access_tokens": INSTALL_TOKEN(expires),
    });
    const auth = new GitHubAppAuth(CREDS, { fetchImpl: impl });
    const tok = await auth.token({ repo: "kowo-co/beckett" });
    expect(tok.token).toBe("ghs_installation_token");
    expect(tok.installationId).toBe(555);
    expect(tok.repositorySelection).toBe("selected");
    // The lookup and the mint both authenticate as the APP (JWT), not with the minted token.
    expect(calls[0]!.auth?.startsWith("Bearer eyJ")).toBe(true);
  });

  test("caches the token and re-mints only once it is inside the refresh margin", async () => {
    let clock = 1_770_000_000_000;
    const { impl, calls } = fakeFetch({
      "GET /repos/kowo-co/beckett/installation": {
        body: { id: 555, account: { login: "kowo-co" }, repository_selection: "all" },
      },
      "POST /app/installations/555/access_tokens": INSTALL_TOKEN(new Date(clock + 3_600_000).toISOString()),
    });
    const auth = new GitHubAppAuth(CREDS, { fetchImpl: impl, now: () => clock });

    await auth.tokenForInstallation(555);
    await auth.tokenForInstallation(555);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

    clock += 56 * 60 * 1000; // 4 minutes left — inside the 5-minute margin
    await auth.tokenForInstallation(555);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  test("falls back owner → pinned installation → sole installation, in that order", async () => {
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const { impl } = fakeFetch({
      "GET /orgs/kowo-co/installation": { body: { id: 777, account: { login: "kowo-co" }, repository_selection: "all" } },
      "POST /app/installations/777/access_tokens": INSTALL_TOKEN(expires, "ghs_by_owner"),
      "POST /app/installations/42/access_tokens": INSTALL_TOKEN(expires, "ghs_pinned"),
    });
    const auth = new GitHubAppAuth({ ...CREDS, installationId: 42 }, { fetchImpl: impl });
    // Repo lookup 404s → owner lookup wins over the pin.
    expect((await auth.token({ repo: "kowo-co/some-new-repo" })).token).toBe("ghs_by_owner");
    // Nothing to key on → the pinned home installation.
    expect((await auth.token()).token).toBe("ghs_pinned");
  });

  test("refuses to guess when no installation covers the target — and names the install link", async () => {
    const { impl } = fakeFetch({
      "GET /app": { body: { id: 1, slug: "beckett", name: "beckett", owner: { login: "kowo-co" } } },
      "GET /app/installations?per_page=100": {
        body: [
          { id: 1, account: { login: "kowo-co", type: "Organization" }, repository_selection: "all" },
          { id: 2, account: { login: "someone-else", type: "User" }, repository_selection: "selected" },
        ],
      },
    });
    const auth = new GitHubAppAuth(CREDS, { fetchImpl: impl });
    await expect(auth.token({ owner: "stranger" })).rejects.toThrow(GitHubAppApiError);
    await expect(auth.token({ owner: "stranger" })).rejects.toThrow(
      /no installation covers stranger.*kowo-co, someone-else.*apps\/beckett\/installations\/new/s,
    );
  });

  test("a bad key or a skewed clock surfaces GitHub's own 401 message verbatim", async () => {
    const { impl } = fakeFetch({
      "GET /app": { status: 401, body: { message: "A JSON web token could not be decoded" } },
    });
    const auth = new GitHubAppAuth(CREDS, { fetchImpl: impl });
    await expect(auth.appMetadata()).rejects.toThrow(/HTTP 401: A JSON web token could not be decoded/);
  });
});

// ── access triage (the first entry in the troubleshooting playbook) ───────────────────────────

describe("diagnoseAccess", () => {
  const APP = { "GET /app": { body: { id: 1, slug: "beckett", name: "beckett", owner: { login: "kowo-co" } } } };

  test("ok when an installation covers the repo", async () => {
    const { impl } = fakeFetch({
      ...APP,
      "GET /repos/kowo-co/beckett/installation": {
        body: { id: 555, account: { login: "kowo-co" }, repository_selection: "selected" },
      },
    });
    const d = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).diagnoseAccess({ owner: "kowo-co", repo: "beckett" });
    expect(d).toEqual({
      status: "ok",
      owner: "kowo-co",
      repo: "kowo-co/beckett",
      installationId: 555,
      repositorySelection: "selected",
    });
  });

  test("not-installed when the account exists but has never installed the app", async () => {
    const { impl } = fakeFetch({ ...APP, "GET /users/octocat": { body: { login: "octocat" } } });
    const d = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).diagnoseAccess({ owner: "octocat", repo: "hello" });
    expect(d).toEqual({
      status: "not-installed",
      owner: "octocat",
      installUrl: "https://github.com/apps/beckett/installations/new",
    });
  });

  test("repo-not-selected when the app is installed but the (public) repo is outside the selection", async () => {
    const { impl } = fakeFetch({
      ...APP,
      "GET /users/octocat/installation": { body: { id: 9, account: { login: "octocat" }, repository_selection: "selected" } },
      "GET /repos/octocat/hello": { body: { full_name: "octocat/hello", private: false } },
    });
    const d = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).diagnoseAccess({ owner: "octocat", repo: "hello" });
    expect(d.status).toBe("repo-not-selected");
    expect(d).toMatchObject({ repo: "octocat/hello", installationId: 9 });
  });

  test("stays honest about the case GitHub cannot disambiguate (private-unselected vs missing)", async () => {
    const { impl } = fakeFetch({
      ...APP,
      "GET /users/octocat/installation": { body: { id: 9, account: { login: "octocat" }, repository_selection: "selected" } },
    });
    const d = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).diagnoseAccess({ owner: "octocat", repo: "ghost" });
    expect(d.status).toBe("repo-not-selected-or-missing");
  });

  test("no-such-owner is a typo, not an access problem", async () => {
    const { impl } = fakeFetch(APP);
    const d = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).diagnoseAccess({ owner: "nope-not-real" });
    expect(d).toEqual({ status: "no-such-owner", owner: "nope-not-real" });
  });
});

test("appInstallUrl is the public repo-picker link", () => {
  expect(appInstallUrl("beckett")).toBe("https://github.com/apps/beckett/installations/new");
});

test("installationRepositories pages through the installation's repo list", async () => {
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const { impl } = fakeFetch({
    "POST /app/installations/555/access_tokens": INSTALL_TOKEN(expires),
    "GET /installation/repositories?per_page=100&page=1": {
      body: { total_count: 2, repositories: [{ full_name: "kowo-co/beckett" }, { full_name: "kowo-co/site" }] },
    },
  });
  const repos = await new GitHubAppAuth(CREDS, { fetchImpl: impl }).installationRepositories(555);
  expect(repos).toEqual(["kowo-co/beckett", "kowo-co/site"]);
});
