import { expect, test } from "bun:test";
import { GitHubCli } from "./index.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } };

function client(fetchImpl: typeof fetch): GitHubCli {
  return new GitHubCli({
    pat: "test-pat",
    account: "beckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => process.cwd(),
    logger: quiet,
    fetchImpl,
  });
}

test("stars and unstars repos through the authenticated REST endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const gh = client(fetchImpl);

  await gh.setRepoStar("owner/repo", true);
  await gh.setRepoStar("owner/repo", false);

  expect(calls).toEqual([
    { url: "https://api.github.com/user/starred/owner/repo", init: expect.objectContaining({ method: "PUT" }) },
    { url: "https://api.github.com/user/starred/owner/repo", init: expect.objectContaining({ method: "DELETE" }) },
  ]);
  expect(calls[0]!.init?.headers).toEqual({
    Authorization: "Bearer test-pat",
    Accept: "application/vnd.github+json",
  });
});

test("rejects malformed repository names before making a request", async () => {
  let called = false;
  const gh = client((async () => {
    called = true;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch);

  await expect(gh.setRepoStar("not-a-repo", true)).rejects.toThrow("repo must be in owner/name form");
  expect(called).toBe(false);
});
